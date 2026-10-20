-- 0008 — M-07: durable storage for scheduled tasks.
--
-- Why not the outbox. The outbox answers "tell recipient R about alert A over
-- channel C": `recipient_id` and `alert_id` are both NOT NULL with foreign
-- keys. A scheduled task answers "run action K against alert A at time T" and
-- has no recipient at all - a safety check tells nobody anything, it decides
-- whether to escalate. Making recipient_id nullable to fit would destroy the
-- constraint that a queued notification always has someone to send to, which
-- is the outbox's whole point. The outbox also has no cancel, and the safety
-- check MUST be cancellable: it fires two minutes after an alert unless she
-- resolves first (docs/coercion-and-escalation.md §3).
--
-- So this is a separate table reusing the outbox's proven MECHANICS - claim by
-- FOR UPDATE SKIP LOCKED, a lease rather than a lock, bounded retries with
-- exponential backoff, and a stale-worker guard. Those are tested in
-- db/tests/alert_outbox_test.sql and test/outboxConcurrency.integration.test.ts
-- and are not re-invented here.
--
-- Deliberately NO foreign key to alerts. `ScheduledTask.payload` is an opaque
-- Record in the TypeScript contract, so the queue is generic; pulling alertId
-- out into a column to reference would couple the queue to one payload shape.
-- The consequence is that a task can outlive its alert, which is safe because
-- every handler in routes/tasks.ts re-reads the alert and skips when it is
-- missing or terminal. The HANDLER is the authority on alert state, never the
-- queue row.

CREATE TYPE task_state AS ENUM ('pending','claimed','done','abandoned','cancelled');

CREATE TABLE task_queue (
    id            bigserial PRIMARY KEY,
    -- Caller-supplied, so a task can be cancelled without bookkeeping, and so
    -- a redelivered schedule folds onto the existing row. UNIQUE is what makes
    -- enqueue idempotent.
    task_key      text NOT NULL UNIQUE,
    -- Denormalised from the payload for logging and metrics only. Never used
    -- to decide anything - the handler reads the payload.
    kind          text NOT NULL,
    payload       jsonb NOT NULL,
    -- When it becomes eligible. Scheduled delivery is the point: a cron
    -- sweeping a table cannot express "in two minutes unless cancelled".
    run_at        timestamptz NOT NULL,
    state         task_state NOT NULL DEFAULT 'pending',
    claimed_by    text,
    claimed_until timestamptz,
    attempts      int NOT NULL DEFAULT 0,
    max_attempts  int NOT NULL DEFAULT 5,
    last_error    text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    completed_at  timestamptz,

    CONSTRAINT task_claim_has_lease
        CHECK ((state <> 'claimed') OR (claimed_by IS NOT NULL AND claimed_until IS NOT NULL)),
    CONSTRAINT task_attempts_bounded CHECK (attempts >= 0 AND max_attempts > 0),
    CONSTRAINT task_terminal_has_time
        CHECK ((state NOT IN ('done','abandoned','cancelled')) OR completed_at IS NOT NULL)
);

-- The claim query's index: due work, oldest first. Partial, because claimed
-- and terminal rows are not scanned for eligibility.
CREATE INDEX task_queue_due_idx ON task_queue (run_at)
    WHERE state IN ('pending','claimed');

-- ---------------------------------------------------------------------------
-- enqueue_task — idempotent on task_key.
--
-- ON CONFLICT DO NOTHING, deliberately NOT a DO UPDATE that moves run_at.
-- Re-triggering an SOS must never postpone her safety check: that would let
-- someone under coercion be kept from escalating indefinitely by tapping the
-- button again. Returns false when the row already existed, so the caller
-- knows it scheduled nothing.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enqueue_task(
    p_key     text,
    p_kind    text,
    p_payload jsonb,
    p_run_at  timestamptz
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    INSERT INTO public.task_queue (task_key, kind, payload, run_at)
    VALUES (p_key, p_kind, p_payload, p_run_at)
    ON CONFLICT (task_key) DO NOTHING;
    RETURN FOUND;
END $$;

-- ---------------------------------------------------------------------------
-- claim_tasks — safe concurrent claiming, same shape as claim_outbox.
--
-- FOR UPDATE SKIP LOCKED is the claim; claimed_until is a LEASE, so a worker
-- that dies releases its work by expiry rather than holding it forever. A
-- bounded p_limit keeps a batch from starving other workers.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_tasks(
    p_worker text,
    p_limit  int DEFAULT 10,
    p_lease  interval DEFAULT interval '60 seconds'
) RETURNS SETOF public.task_queue
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    RETURN QUERY
    UPDATE public.task_queue t
       SET state = 'claimed', claimed_by = p_worker,
           claimed_until = now() + p_lease, attempts = t.attempts + 1
     WHERE t.id IN (
         SELECT c.id FROM public.task_queue c
          WHERE c.run_at <= now()
            AND (c.state = 'pending'
                 OR (c.state = 'claimed' AND c.claimed_until < now()))  -- expired lease
          ORDER BY c.run_at
          FOR UPDATE SKIP LOCKED
          LIMIT p_limit
     )
    RETURNING t.*;
END $$;

-- ---------------------------------------------------------------------------
-- complete_task — conditional, so a stale worker cannot overwrite a newer claim.
--
-- The guard is `claimed_by = p_worker AND state = 'claimed'`. A worker whose
-- lease expired and whose row was re-claimed by someone else affects zero rows
-- and is told so, rather than destroying the new owner's claim.
--
-- On failure: 'abandoned' once attempts reach max_attempts, else back to
-- 'pending' with exponential backoff. Bounded, so a permanently failing task
-- cannot become a hot loop.
-- ---------------------------------------------------------------------------
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
           -- Set for every terminal state, and cleared when the task goes back
           -- to pending, so task_terminal_has_time always holds.
           completed_at = CASE
                            WHEN p_ok OR t.attempts >= t.max_attempts THEN now()
                            ELSE NULL
                          END,
           last_error   = p_error,
           claimed_by   = NULL,
           claimed_until = NULL,
           run_at = CASE WHEN p_ok THEN t.run_at
                         ELSE now() + (interval '10 seconds' * power(2, t.attempts)) END
     WHERE t.id = p_id
       AND t.claimed_by = p_worker
       AND t.state = 'claimed';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN v_rows = 1;
END $$;

-- ---------------------------------------------------------------------------
-- cancel_task — she resolved, so the check must not fire.
--
-- Cancels pending AND claimed work. Cancelling a claimed row does not stop a
-- worker already running it, and is not meant to: that worker's
-- complete_task will fail the state guard, and its handler re-reads the alert
-- and skips a terminal one anyway. Two independent reasons the notification
-- cannot happen, which is the right number for this.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_task(p_key text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_rows int;
BEGIN
    UPDATE public.task_queue
       SET state = 'cancelled', completed_at = now(),
           claimed_by = NULL, claimed_until = NULL
     WHERE task_key = p_key
       AND state IN ('pending','claimed');
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN v_rows = 1;
END $$;

-- ===========================================================================
-- GRANTS — least privilege, matching the outbox's treatment.
-- ===========================================================================
ALTER TABLE task_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_queue FORCE ROW LEVEL SECURITY;

-- No client grant at all. A task row carries an alert id and a schedule; a
-- client has no business reading or writing either.
GRANT SELECT, INSERT, UPDATE ON task_queue TO alehulsh_api;
CREATE POLICY task_queue_api ON task_queue FOR ALL TO alehulsh_api
    USING (true) WITH CHECK (true);

-- DELETE is deliberately NOT granted: tasks end by state transition, never by
-- deletion, so the record of what ran survives. Same reasoning as alerts
-- (docs/alert-retention.md §3).
GRANT USAGE, SELECT ON SEQUENCE task_queue_id_seq TO alehulsh_api;

REVOKE ALL ON FUNCTION public.enqueue_task(text,text,jsonb,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_tasks(text,int,interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_task(bigint,text,boolean,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_task(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.enqueue_task(text,text,jsonb,timestamptz) TO alehulsh_api;
GRANT EXECUTE ON FUNCTION public.claim_tasks(text,int,interval) TO alehulsh_api;
GRANT EXECUTE ON FUNCTION public.complete_task(bigint,text,boolean,text) TO alehulsh_api;
GRANT EXECUTE ON FUNCTION public.cancel_task(text) TO alehulsh_api;
