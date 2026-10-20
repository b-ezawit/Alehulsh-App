-- 0010 — three confirmed defects in the claim/complete functions.
--
-- Found by adversarial review of M-07. All three apply to BOTH the task queue
-- (0008) and the outbox (0003), because the task queue copied the outbox's
-- shape; both are fixed here.
--
-- ---------------------------------------------------------------------------
-- 1. max_attempts was not a bound.  (HIGH)
--
-- Reclaiming an expired lease increments `attempts`, and the claim predicate
-- never looked at `max_attempts` - only complete_* did. So a task whose worker
-- dies before reporting is re-claimed forever. Measured: 12 reclaims against
-- max_attempts = 5 left attempts = 12 and the row still 'claimed'.
--
-- Why it matters: a task that reliably kills its worker becomes a permanent
-- hot loop - every poll claims it, every poll dies - and it never reaches a
-- terminal state anyone can alert on. The documented "bounded retries" was not
-- true for the failure mode that matters most, a crashing handler.
--
-- Fixed by abandoning an expired-lease row whose attempts are exhausted
-- instead of handing it out again. That is a visible terminal state rather
-- than silent exclusion, so an operator can see the work was dropped.
--
-- ---------------------------------------------------------------------------
-- 2. The backoff formula could overflow.  (MEDIUM — a consequence of 1)
--
-- `interval '10 seconds' * power(2, attempts)` raises SQLSTATE 22008
-- "interval out of range" from roughly attempts = 40, and 22003 beyond ~1024.
-- Unbounded reclaim made that reachable. Once reached, any failure report
-- raises inside complete_*, and TaskWorker rethrows a completion failure -
-- so one poisoned row aborted the whole batch.
--
-- Fixed by clamping the exponent AND capping the delay. An hour is already far
-- beyond useful for this product; the cap exists so the arithmetic cannot
-- reach a value Postgres refuses.
--
-- ---------------------------------------------------------------------------
-- 3. A non-positive lease was accepted.  (MEDIUM)
--
-- Measured: `claim_tasks(worker, 2, interval '0 s')` and `interval '-60 s'`
-- both claimed rows whose lease had already expired, so any other worker could
-- immediately re-claim them and run the same task concurrently. For a
-- notification that is duplicate delivery; for an escalation it is two workers
-- racing on one alert.
--
-- PostgresTaskQueue.claim clamps the lease to at least a second, but these
-- functions are callable directly - and claim_outbox has no TypeScript wrapper
-- at all - so the invariant belongs in the database.
--
-- A limit of 0 stays legal: it claims nothing, which is bounded and is how the
-- restricted-role suite proves EXECUTE without competing for rows. A negative
-- limit is rejected explicitly rather than surfacing Postgres's own
-- "LIMIT must not be negative".

-- ===========================================================================
-- task_queue
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.claim_tasks(
    p_worker text,
    p_limit  int DEFAULT 10,
    p_lease  interval DEFAULT interval '60 seconds'
) RETURNS SETOF public.task_queue
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF p_worker IS NULL OR btrim(p_worker) = '' THEN
        RAISE EXCEPTION 'p_worker must identify a worker' USING ERRCODE = '22023';
    END IF;
    IF p_lease IS NULL OR p_lease <= interval '0' THEN
        RAISE EXCEPTION 'p_lease must be positive; a claim with an expired lease can be taken by another worker immediately'
            USING ERRCODE = '22023';
    END IF;
    IF p_limit IS NULL OR p_limit < 0 THEN
        RAISE EXCEPTION 'p_limit must not be negative' USING ERRCODE = '22023';
    END IF;

    -- Exhausted work is retired, not re-handed-out. Done before the claim so
    -- these rows are not eligible below.
    UPDATE public.task_queue
       SET state = 'abandoned', completed_at = now(),
           claimed_by = NULL, claimed_until = NULL,
           last_error = COALESCE(last_error, 'lease expired with attempts exhausted')
     WHERE state = 'claimed' AND claimed_until < now()
       AND attempts >= max_attempts;

    RETURN QUERY
    WITH picked AS (
        SELECT c.id FROM public.task_queue c
         WHERE c.run_at <= now()
           AND (c.state = 'pending'
                OR (c.state = 'claimed' AND c.claimed_until < now()))
         ORDER BY c.run_at
         FOR UPDATE SKIP LOCKED
         LIMIT p_limit
    )
    UPDATE public.task_queue t
       SET state = 'claimed', claimed_by = p_worker,
           claimed_until = now() + p_lease, attempts = t.attempts + 1
     WHERE t.id IN (SELECT id FROM picked)
    RETURNING t.*;
END $$;

CREATE OR REPLACE FUNCTION public.complete_task(
    p_id     bigint,
    p_worker text,
    p_ok     boolean,
    p_error  text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_rows int;
BEGIN
    UPDATE public.task_queue t
       SET state = (CASE
                     WHEN p_ok THEN 'done'
                     WHEN t.attempts >= t.max_attempts THEN 'abandoned'
                     ELSE 'pending'
                   END)::public.task_state,
           completed_at = CASE
                            WHEN p_ok OR t.attempts >= t.max_attempts THEN now()
                            ELSE NULL
                          END,
           last_error   = p_error,
           claimed_by   = NULL,
           claimed_until = NULL,
           -- Exponent clamped and delay capped: the arithmetic must not be
           -- able to reach a value Postgres refuses (22008/22003).
           run_at = CASE WHEN p_ok THEN t.run_at
                         ELSE now() + LEAST(
                                interval '10 seconds' * power(2, LEAST(t.attempts, 12)),
                                interval '1 hour') END
     WHERE t.id = p_id
       AND t.claimed_by = p_worker
       AND t.state = 'claimed';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN v_rows = 1;
END $$;

-- ===========================================================================
-- outbox — the same three fixes
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.claim_outbox(
    p_worker text, p_limit int DEFAULT 20, p_lease interval DEFAULT interval '60 seconds'
) RETURNS SETOF public.outbox
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF p_worker IS NULL OR btrim(p_worker) = '' THEN
        RAISE EXCEPTION 'p_worker must identify a worker' USING ERRCODE = '22023';
    END IF;
    IF p_lease IS NULL OR p_lease <= interval '0' THEN
        RAISE EXCEPTION 'p_lease must be positive; a claim with an expired lease can be taken by another worker immediately'
            USING ERRCODE = '22023';
    END IF;
    IF p_limit IS NULL OR p_limit < 0 THEN
        RAISE EXCEPTION 'p_limit must not be negative' USING ERRCODE = '22023';
    END IF;

    UPDATE public.outbox
       SET state = 'abandoned',
           claimed_by = NULL, claimed_until = NULL,
           last_error = COALESCE(last_error, 'lease expired with attempts exhausted')
     WHERE state = 'claimed' AND claimed_until < now()
       AND attempts >= max_attempts;

    RETURN QUERY
    WITH picked AS (
        SELECT c.id FROM public.outbox c
         WHERE c.next_retry_at <= now()
           AND (c.state = 'pending'
                OR (c.state = 'claimed' AND c.claimed_until < now()))
         ORDER BY c.next_retry_at
         FOR UPDATE SKIP LOCKED
         LIMIT p_limit
    )
    UPDATE public.outbox o
       SET state = 'claimed', claimed_by = p_worker,
           claimed_until = now() + p_lease, attempts = o.attempts + 1
     WHERE o.id IN (SELECT id FROM picked)
    RETURNING o.*;
END $$;

CREATE OR REPLACE FUNCTION public.complete_outbox(
    p_id bigint, p_worker text, p_ok boolean, p_error text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_rows int;
BEGIN
    UPDATE public.outbox o
       SET state = (CASE
                     WHEN p_ok THEN 'published'
                     WHEN o.attempts >= o.max_attempts THEN 'abandoned'
                     ELSE 'pending'
                   END)::public.outbox_state,
           published_at  = CASE WHEN p_ok THEN now() END,
           last_error    = p_error,
           claimed_by    = NULL,
           claimed_until = NULL,
           next_retry_at = CASE WHEN p_ok THEN o.next_retry_at
                                ELSE now() + LEAST(
                                       interval '10 seconds' * power(2, LEAST(o.attempts, 12)),
                                       interval '1 hour') END
     WHERE o.id = p_id
       AND o.claimed_by = p_worker
       AND o.state = 'claimed';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN v_rows = 1;
END $$;

-- Signatures unchanged, so existing grants still apply. Restated for a reader.
GRANT EXECUTE ON FUNCTION public.claim_tasks(text,int,interval) TO alehulsh_api;
GRANT EXECUTE ON FUNCTION public.complete_task(bigint,text,boolean,text) TO alehulsh_api;
GRANT EXECUTE ON FUNCTION public.claim_outbox(text,int,interval) TO alehulsh_api;
GRANT EXECUTE ON FUNCTION public.complete_outbox(bigint,text,boolean,text) TO alehulsh_api;
