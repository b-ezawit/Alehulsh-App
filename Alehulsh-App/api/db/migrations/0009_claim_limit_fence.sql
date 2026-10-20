-- 0009 — the claim batch limit was not a limit.  (HIGH, pre-existing)
--
-- Both claim functions were written as:
--
--     UPDATE ... WHERE id IN (
--         SELECT id FROM ... ORDER BY ... FOR UPDATE SKIP LOCKED LIMIT p_limit)
--
-- The subquery honours the LIMIT when run alone - measured, it returns exactly
-- p_limit ids. But as an IN-sublink inside an UPDATE, the planner converts it
-- to a semi-join and the LIMIT stops bounding the rows updated. Measured
-- against 7 due rows with p_limit = 3: the subquery returned 3 and the UPDATE
-- claimed all 7.
--
-- Why it matters beyond tidiness. The batch size is what stops one worker
-- taking the whole backlog. Without it a single dispatcher claims every due
-- row, holds a 60-second lease on all of them, and processes them one at a
-- time - so work it will not reach for minutes is marked `claimed` and no
-- other worker may touch it. For notification work that is a queue of women
-- whose contacts have not been told, sitting behind a lease held by a worker
-- that has not got to them yet. It also defeats SKIP LOCKED's purpose: the
-- point of bounded batches is that N workers share the work rather than one
-- taking it and the rest idling.
--
-- The fix is a CTE. A WITH clause is an optimisation fence and is evaluated
-- exactly once, so the LIMIT applies to the set of ids actually chosen.
--
-- claim_outbox has carried this since 0003 (sprint 1). It was never detected
-- because nothing asked it for fewer rows than were available - the outbox
-- concurrency suite claims with limit 10 against at most 12 rows and asserts
-- the total, not the bound. M-07's task queue copied the shape, added a test
-- for the bound, and the test failed. Both are fixed here; regression tests
-- for both are in test/taskQueue.integration.test.ts and
-- test/outboxConcurrency.integration.test.ts.

CREATE OR REPLACE FUNCTION public.claim_tasks(
    p_worker text,
    p_limit  int DEFAULT 10,
    p_lease  interval DEFAULT interval '60 seconds'
) RETURNS SETOF public.task_queue
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    RETURN QUERY
    WITH picked AS (
        SELECT c.id FROM public.task_queue c
         WHERE c.run_at <= now()
           AND (c.state = 'pending'
                OR (c.state = 'claimed' AND c.claimed_until < now()))  -- expired lease
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

CREATE OR REPLACE FUNCTION public.claim_outbox(
    p_worker text, p_limit int DEFAULT 20, p_lease interval DEFAULT interval '60 seconds'
) RETURNS SETOF public.outbox
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    RETURN QUERY
    WITH picked AS (
        SELECT c.id FROM public.outbox c
         WHERE c.next_retry_at <= now()
           AND (c.state = 'pending'
                OR (c.state = 'claimed' AND c.claimed_until < now()))  -- expired lease
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

-- Signatures are unchanged, so the 0003/0008 grants still apply. Restated so a
-- reader need not go and check.
GRANT EXECUTE ON FUNCTION public.claim_tasks(text,int,interval) TO alehulsh_api;
GRANT EXECUTE ON FUNCTION public.claim_outbox(text,int,interval) TO alehulsh_api;
