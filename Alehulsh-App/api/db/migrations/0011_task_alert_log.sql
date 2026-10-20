-- 0011 — P2-17: abandoned tasks become a durable, queryable fact.
--
-- An `abandoned` task is work the system accepted, retried to exhaustion and
-- gave up on. For every kind this queue carries that has a victim: an
-- abandoned safety-check is a woman who was never escalated, an abandoned
-- notify-contacts is contacts who were never told, an abandoned expiry is an
-- alert left non-terminal past its window.
--
-- Until now the only trace was one error line on stdout from TaskWorker. If
-- nobody was reading stdout at that moment the event was gone - the row stayed
-- in the table but nothing ever looked at it again, and a restart lost even
-- the line.
--
-- ---------------------------------------------------------------------------
-- WHY A SEPARATE TABLE, and not any of the cheaper options
--
--   * an in-process Set of reported ids is not durable. A restart
--     re-announces everything and N workers announce N times - and the
--     failure mode we most need to survive IS the process dying.
--   * a column on task_queue (alerted_at) would put the monitor on the WRITE
--     PATH of the safety-critical table, so a monitoring bug could corrupt
--     task state.
--   * a marker row in task_queue is tempting, because UNIQUE(task_key) is
--     already idempotent dedupe - but a task row is CLAIMABLE. The marker
--     would be claimed, find no handler, fail, and abandon; the monitor would
--     then detect THAT and mark it, forever. Self-amplifying.
--   * writing into last_error destroys the diagnostic field it would mark.
--
-- This migration is ADDITIVE. It creates nothing existing code reads or
-- writes, changes no existing function, alters no existing column, and leaves
-- every task-processing path byte-identical. Rollback is DROP TABLE.
--
-- ---------------------------------------------------------------------------
-- WHY THERE IS NO EMERGENCY DATA HERE
--
-- No payload, no alert id, no error text, no user, no location. Two things
-- make that structural rather than a promise:
--
--   1. every column is a number, a timestamp, a boolean, or constrained to a
--      closed vocabulary by a CHECK. The one free-text column, `kind`, is
--      capped and written from server-side literals. A bug that tried to put
--      a raw error message into error_class is REFUSED by the database rather
--      than quietly persisted.
--   2. the fields are denormalised deliberately, so an eventual external
--      alerting integration can read THIS table alone and never touch
--      task_queue - whose payloads do carry alert ids. The thing we may one
--      day point at a pager holds no personal data.
--
-- An operator who needs the alert behind a task joins task_queue on task_id
-- under their own authorisation. That second step is the point.

CREATE TABLE task_alert_log (
    -- PRIMARY KEY is the whole deduplication mechanism: the unique index
    -- decides which scanner gets to announce a task. Two monitors that both
    -- select the same row both attempt the insert, exactly one gets it back
    -- from RETURNING, and only that one emits a signal. Idempotency is a
    -- database property, not a convention a caller can forget.
    --
    -- ON DELETE CASCADE, not NO ACTION: nothing may DELETE from task_queue
    -- today (no grant, to any role), so this costs nothing now. If a
    -- retention sweep is ever introduced, a description of a task that no
    -- longer exists is a dead pointer, and blocking the sweep on an
    -- observability table would be worse than losing the row with it.
    task_id      bigint PRIMARY KEY
                 REFERENCES public.task_queue(id) ON DELETE CASCADE,

    -- Denormalised so this table stands alone. Capped rather than enumerated:
    -- a CHECK on the kind list would make the ledger reject a newly added task
    -- kind, which is the wrong failure. The writer truncates to 64, so this is
    -- a backstop that should never fire.
    kind         text NOT NULL CHECK (char_length(kind) BETWEEN 1 AND 64),

    attempts     int NOT NULL CHECK (attempts >= 0),
    max_attempts int NOT NULL CHECK (max_attempts > 0),

    -- task_queue.completed_at. When it is abandoned, it is set - the
    -- task_terminal_has_time CHECK guarantees that.
    abandoned_at timestamptz NOT NULL,

    -- CLOSED VOCABULARY. The raw last_error is read, classified and
    -- discarded; it is never stored and never logged. The vocabulary is
    -- defined in src/queue/AbandonedTaskMonitor.ts and this CHECK is the
    -- database refusing to hold anything outside it.
    error_class  text NOT NULL CHECK (error_class IN (
                     'none', 'no_handler', 'missing_alert_id', 'route_rejected',
                     'timeout', 'unreachable', 'lease_expired', 'unclassified')),

    -- 'safety' unless the kind is EXPLICITLY listed as non-safety. The
    -- inverse default would silently downgrade a safety kind somebody forgot
    -- to register; on this platform that trade is the wrong way round.
    severity     text NOT NULL CHECK (severity IN ('safety', 'background')),

    -- false when the kind is in neither list, so a reader can tell a rating
    -- that was decided from one that was defaulted.
    kind_registered boolean NOT NULL,

    -- When the monitor noticed, as distinct from when the task was abandoned.
    -- The gap between them is the monitor's detection latency, which is
    -- measurable from this table alone.
    --
    -- NOTE for whoever wires a real destination: this means NOTICED, not
    -- DELIVERED. Delivery needs its own column and attempt count, or a
    -- destination outage silently loses the signal.
    noticed_at   timestamptz NOT NULL DEFAULT now()
);

-- The detection query: abandoned rows, oldest id first. Partial, because
-- nothing else is ever scanned this way and abandoned rows are a small
-- minority of the table.
CREATE INDEX task_queue_abandoned_idx ON task_queue (id)
    WHERE state = 'abandoned';

-- The operator's query: the safety-severity backlog, newest first.
CREATE INDEX task_alert_log_severity_idx ON task_alert_log (severity, noticed_at DESC);

-- ---------------------------------------------------------------------------
-- record_task_alerts — append-only, atomic, and unable to fabricate.
--
-- One statement, so concurrent monitors cannot both win. ON CONFLICT DO
-- NOTHING plus RETURNING is what tells the caller which rows are ITS to
-- announce; everything else was already announced by somebody.
--
-- The EXISTS guard is an invariant the caller cannot bypass: a ledger row may
-- only be written for a task that is ACTUALLY abandoned. A buggy or
-- compromised API process cannot manufacture abandonment records, and cannot
-- rewrite or erase one - there is no UPDATE or DELETE path here at all, and
-- none is granted on the table.
--
-- Arrays rather than row-at-a-time: one round trip per scan, and the whole
-- batch lands in one transaction.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_task_alerts(
    p_task_ids    bigint[],
    p_kinds       text[],
    p_attempts    int[],
    p_max         int[],
    p_abandoned   timestamptz[],
    p_error_class text[],
    p_severity    text[],
    p_registered  boolean[]
) RETURNS SETOF bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n int;
BEGIN
    n := COALESCE(array_length(p_task_ids, 1), 0);
    IF n = 0 THEN
        RETURN;  -- an empty scan is the normal case, not an error
    END IF;

    -- Mismatched arrays would silently pair a task with another task's
    -- classification, which is worse than a refusal: the ledger would be
    -- confidently wrong about which work was dropped.
    IF COALESCE(array_length(p_kinds, 1), 0) <> n
       OR COALESCE(array_length(p_attempts, 1), 0) <> n
       OR COALESCE(array_length(p_max, 1), 0) <> n
       OR COALESCE(array_length(p_abandoned, 1), 0) <> n
       OR COALESCE(array_length(p_error_class, 1), 0) <> n
       OR COALESCE(array_length(p_severity, 1), 0) <> n
       OR COALESCE(array_length(p_registered, 1), 0) <> n
    THEN
        RAISE EXCEPTION 'record_task_alerts: every array must have the same length'
            USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    WITH candidate AS (
        SELECT * FROM unnest(
            p_task_ids, p_kinds, p_attempts, p_max,
            p_abandoned, p_error_class, p_severity, p_registered
        ) AS u(task_id, kind, attempts, max_attempts,
               abandoned_at, error_class, severity, kind_registered)
    ), inserted AS (
        INSERT INTO public.task_alert_log
            (task_id, kind, attempts, max_attempts, abandoned_at,
             error_class, severity, kind_registered)
        SELECT c.task_id, c.kind, c.attempts, c.max_attempts, c.abandoned_at,
               c.error_class, c.severity, c.kind_registered
          FROM candidate c
         WHERE EXISTS (
             SELECT 1 FROM public.task_queue t
              WHERE t.id = c.task_id AND t.state = 'abandoned'
         )
        ON CONFLICT (task_id) DO NOTHING
        RETURNING task_id
    )
    SELECT task_id FROM inserted;
END $$;

-- ===========================================================================
-- GRANTS — least privilege, matching task_queue's treatment (0008).
-- ===========================================================================
ALTER TABLE task_alert_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_alert_log FORCE ROW LEVEL SECURITY;

-- SELECT ONLY for the API/worker role. Writes go exclusively through the
-- function above, so the ledger is append-only even to the role that appends
-- to it: no UPDATE, no DELETE, and no INSERT it could use to forge a row.
GRANT SELECT ON task_alert_log TO alehulsh_api;
CREATE POLICY task_alert_log_api ON task_alert_log FOR ALL TO alehulsh_api
    USING (true) WITH CHECK (true);

-- No client grant at all, deliberately. A client reading this learns which
-- escalations failed and when - a map of exactly where the system did not
-- protect someone, which is the last thing a coercer should be able to query.

REVOKE ALL ON FUNCTION public.record_task_alerts(
    bigint[], text[], int[], int[], timestamptz[], text[], text[], boolean[]
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_task_alerts(
    bigint[], text[], int[], int[], timestamptz[], text[], text[], boolean[]
) TO alehulsh_api;
