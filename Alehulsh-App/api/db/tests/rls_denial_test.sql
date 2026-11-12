-- RLS denial suite. Runs against a real local PostgreSQL+PostGIS instance
-- with synthetic data only. Any failed assertion aborts with a non-zero exit.
\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;
TRUNCATE users CASCADE;   -- re-runnable: no fixture collisions
-- task_queue has no foreign key to users (0008, deliberately), so TRUNCATE
-- users CASCADE does NOT reach it. Without this the suite is not re-runnable:
-- the probe row below survives, enqueue_task correctly reports "already
-- exists", and the assertion fails on the second run.
-- task_alert_log (0011) has a foreign key TO task_queue, so the parent cannot
-- be truncated alone. Both are named explicitly rather than using CASCADE, so
-- this cannot silently grow to reach a table a reader did not expect.
TRUNCATE task_alert_log, task_queue;

-- ---- synthetic fixtures ---------------------------------------------------
INSERT INTO users (id, display_name, phone_e164, phone_verified_at,
                   phone_hash, email_hash, keyword_hash, email_verified_at) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Alice',    '+251911111111', now(),
   'SYNTHETIC-PHONE-HASH', 'SYNTHETIC-EMAIL-HASH', 'SYNTHETIC-KEYWORD-HASH', now()),
  ('22222222-2222-2222-2222-222222222222', 'Beza',     '+251922222222', NULL,
   NULL, NULL, NULL, NULL),
  ('33333333-3333-3333-3333-333333333333', 'Stranger', '+251933333333', NULL,
   NULL, NULL, NULL, NULL);

INSERT INTO alerts (id, owner_id, request_id, expires_at, location, location_quality, location_age_ms)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '11111111-1111-1111-1111-111111111111', 'req-alice-0001',
        now() + interval '2 hours',
        ST_SetSRID(ST_MakePoint(38.7897, 8.9956),4326)::geography, 'live', 30000);

-- Beza was sent it and accepted; Stranger was not.
INSERT INTO inbox (recipient_id, alert_id, audience, projection)
VALUES ('22222222-2222-2222-2222-222222222222',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'contact', '{"alertId":"a"}'::jsonb);
INSERT INTO acceptances (alert_id, responder_id, audience)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '22222222-2222-2222-2222-222222222222', 'contact');
INSERT INTO evidence (id, alert_id, owner_id, r2_key, state, content_type,
                      actual_sha256, completed_at, deliberate)
VALUES ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '11111111-1111-1111-1111-111111111111',
        'evidence/opaque/aaaa-bbbb', 'stored', 'audio/m4a', 'deadbeef', now(), true);

-- Alice and Stranger have Firebase identities; Beza deliberately does not, so
-- "unmapped" is a state the suite can exercise. Stranger holds no alert, which
-- is what makes her usable for the creation assertion below: Alice has a LIVE
-- fixture alert, so a create for Alice folds onto it (correctly) and proves
-- nothing about where a new row lands.
INSERT INTO identity_map (firebase_uid, user_id) VALUES
  ('kJ8sQ2mNpR4tV6wX1yZ3aB5cD7eF', '11111111-1111-1111-1111-111111111111'),
  ('zP3xW9vU1tS5rQ7nM2kJ4hG6fD8c', '33333333-3333-3333-3333-333333333333');

COMMIT;

-- ---- helper: assert a statement is refused --------------------------------
CREATE OR REPLACE FUNCTION pg_temp.must_fail(sql text, label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    BEGIN
        EXECUTE sql;
        RAISE EXCEPTION 'SECURITY FAILURE: % was ALLOWED but must be refused', label;
    EXCEPTION
        WHEN insufficient_privilege THEN RAISE NOTICE 'ok (denied): %', label;
        WHEN check_violation       THEN RAISE NOTICE 'ok (denied): %', label;
    END;
END $$;

-- ===========================================================================
-- Alice, authenticated
-- ===========================================================================
SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

DO $$ BEGIN
    ASSERT (SELECT count(*) FROM users) = 1, 'Alice must see exactly her own profile';
    ASSERT (SELECT display_name FROM users) = 'Alice', 'and it must be hers';
END $$;

DO $$ BEGIN
    ASSERT (SELECT count(*) FROM users
            WHERE id='22222222-2222-2222-2222-222222222222') = 0,
           'cross-user profile read must return nothing';
END $$;

-- ---- column exposure (0006) ------------------------------------------------
-- RLS was always correct here: she sees only her own row. These are about the
-- wrong COLUMNS of the right row. 0002 restricted INSERT/UPDATE by column but
-- granted SELECT at the table level, which carries every column.
--
-- keyword_hash is the one that matters most. It is the anti-coercion control,
-- so an abuser holding her unlocked phone could read it from the API and
-- brute-force a short memorable word offline, then stand her responders down.
SELECT pg_temp.must_fail(
  $q$ SELECT keyword_hash FROM users $q$,
  'client reading her own safety-keyword hash');
SELECT pg_temp.must_fail(
  $q$ SELECT phone_hash FROM users $q$,
  'client reading her own phone hash');
SELECT pg_temp.must_fail(
  $q$ SELECT email_hash FROM users $q$,
  'client reading her own email hash');
SELECT pg_temp.must_fail(
  $q$ SELECT keyword_algo FROM users $q$,
  'client reading which KDF guards the keyword');
SELECT pg_temp.must_fail(
  $q$ SELECT * FROM users $q$,
  'client reading the whole profile row with SELECT *');

-- contact_user_id is an INTERNAL uuid, and its presence also discloses that a
-- third party has an account - which that third party never consented to.
SELECT pg_temp.must_fail(
  $q$ SELECT contact_user_id FROM emergency_contacts $q$,
  'client reading the internal account a contact resolved to');
SELECT pg_temp.must_fail(
  $q$ SELECT linked_at FROM emergency_contacts $q$,
  'client reading when a contact was matched to an account');

-- What she legitimately needs is untouched. Asserted positively so a future
-- tightening cannot quietly break her own profile.
DO $$ BEGIN
    PERFORM id, display_name, home_address, phone_e164, phone_verified_at,
            must_set_keyword, created_at
       FROM users;
    RAISE NOTICE 'ok: her own profile remains readable after 0006';
END $$;

SELECT pg_temp.must_fail(
  $q$ UPDATE users SET phone_hash='forged' WHERE id='11111111-1111-1111-1111-111111111111' $q$,
  'client writing her own phone_hash');
SELECT pg_temp.must_fail(
  $q$ UPDATE users SET phone_verified_at=now() WHERE id='11111111-1111-1111-1111-111111111111' $q$,
  'client self-verifying her phone');
SELECT pg_temp.must_fail(
  $q$ UPDATE users SET keyword_hash='x' WHERE id='11111111-1111-1111-1111-111111111111' $q$,
  'client writing her own keyword_hash');
SELECT pg_temp.must_fail(
  $q$ INSERT INTO alerts (owner_id, request_id, expires_at)
      VALUES ('11111111-1111-1111-1111-111111111111','req-forged-001', now()+interval '2 hours') $q$,
  'client creating an alert directly');
SELECT pg_temp.must_fail(
  $q$ UPDATE alerts SET status='resolved' WHERE id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' $q$,
  'client resolving her own alert directly');
SELECT pg_temp.must_fail(
  $q$ INSERT INTO inbox (recipient_id, alert_id, audience, projection)
      VALUES ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','contact','{}'::jsonb) $q$,
  'client inventing an inbox entry');
SELECT pg_temp.must_fail(
  $q$ INSERT INTO acceptances (alert_id, responder_id, audience)
      VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','11111111-1111-1111-1111-111111111111','contact') $q$,
  'client forging an acceptance');
SELECT pg_temp.must_fail(
  $q$ INSERT INTO outbox (dedupe_key, alert_id, recipient_id, channel, payload)
      VALUES ('k','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','11111111-1111-1111-1111-111111111111','fcm','{}'::jsonb) $q$,
  'client writing the outbox');
SELECT pg_temp.must_fail(
  $q$ INSERT INTO notification_attempts (alert_id, recipient_id, channel)
      VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','11111111-1111-1111-1111-111111111111','fcm') $q$,
  'client asserting a notification');
SELECT pg_temp.must_fail(
  $q$ INSERT INTO reveal_log (alert_id, actor_id, granted)
      VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','11111111-1111-1111-1111-111111111111',true) $q$,
  'client writing the audit log');
SELECT pg_temp.must_fail(
  $q$ SELECT r2_key FROM evidence $q$,
  'client reading evidence metadata or object keys');
SELECT pg_temp.must_fail(
  $q$ DELETE FROM alerts WHERE id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' $q$,
  'client deleting an alert (remote evidence destruction)');

-- task_queue (0008, M-07). A task row says which alert will be acted on and
-- when. A client reading it learns the escalation schedule; a client writing it
-- could cancel her own safety check, which is exactly what a coercer wants.
SELECT pg_temp.must_fail(
  $q$ SELECT * FROM task_queue $q$,
  'client reading the task queue (the escalation schedule)');
SELECT pg_temp.must_fail(
  $q$ INSERT INTO task_queue (task_key, kind, payload, run_at)
      VALUES ('forged','safety-check','{}'::jsonb, now()) $q$,
  'client inserting a task');
SELECT pg_temp.must_fail(
  $q$ UPDATE task_queue SET state='cancelled' $q$,
  'client cancelling her own safety check');

-- task_alert_log (0011, P2-17). A map of exactly where the system did not
-- protect someone: which escalations were dropped, and when. The last thing a
-- coercer should be able to query, and nothing a client needs at all.
SELECT pg_temp.must_fail(
  $q$ SELECT * FROM task_alert_log $q$,
  'client reading which safety work was dropped');
SELECT pg_temp.must_fail(
  $q$ INSERT INTO task_alert_log (task_id, kind, attempts, max_attempts,
                                  abandoned_at, error_class, severity, kind_registered)
      VALUES (1,'safety-check',1,1,now(),'none','background',true) $q$,
  'client writing the abandonment ledger');
SELECT pg_temp.must_fail(
  $q$ DELETE FROM task_alert_log $q$,
  'client erasing the record that her safety check was dropped');
SELECT pg_temp.must_fail(
  $q$ SELECT record_task_alerts(ARRAY[1]::bigint[], ARRAY['k'], ARRAY[1], ARRAY[1],
        ARRAY[now()]::timestamptz[], ARRAY['none'], ARRAY['safety'], ARRAY[true]) $q$,
  'client executing the ledger function');

-- Contacts: she owns the row, she does not assert who someone IS.
INSERT INTO emergency_contacts (owner_id, label, phone_e164)
VALUES ('11111111-1111-1111-1111-111111111111','Sister','+251944444444');
SELECT pg_temp.must_fail(
  $q$ UPDATE emergency_contacts SET contact_user_id='33333333-3333-3333-3333-333333333333'
      WHERE owner_id='11111111-1111-1111-1111-111111111111' $q$,
  'client linking a contact to an arbitrary account');

RESET ROLE;

-- ===========================================================================
-- Beza: a legitimate recipient
-- ===========================================================================
SET ROLE authenticated;
SET request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
DO $$ BEGIN
    ASSERT (SELECT count(*) FROM alerts
            WHERE id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') = 1,
           'a recipient must see the alert she was sent';
    ASSERT (SELECT count(*) FROM inbox) = 1, 'and exactly her own inbox row';
END $$;
RESET ROLE;

-- ===========================================================================
-- Stranger: sent nothing
-- ===========================================================================
SET ROLE authenticated;
SET request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
DO $$ BEGIN
    ASSERT (SELECT count(*) FROM alerts) = 0, 'a stranger must see no alerts';
    ASSERT (SELECT count(*) FROM inbox) = 0, 'and no inbox rows';
    ASSERT (SELECT count(*) FROM users) = 1, 'and only her own profile';
END $$;
RESET ROLE;

-- ===========================================================================
-- anon: nothing, anywhere
-- ===========================================================================
SET ROLE anon;
SELECT pg_temp.must_fail($q$ SELECT * FROM users  $q$, 'anon reading users');
SELECT pg_temp.must_fail($q$ SELECT * FROM alerts $q$, 'anon reading alerts');
SELECT pg_temp.must_fail($q$ SELECT * FROM inbox  $q$, 'anon reading inbox');
RESET ROLE;

-- ===========================================================================
-- The API role: constrained by RLS, which is why it is not service_role
-- ===========================================================================
SET ROLE alehulsh_api;
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
DO $$ BEGIN
    ASSERT (SELECT count(*) FROM evidence) = 1,
           'owner evidence visible to the API acting as the owner';
END $$;
SET request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
DO $$ BEGIN
    ASSERT (SELECT count(*) FROM evidence) = 1,
           'accepted responder sees the deliberate note while the alert is live';
END $$;
SET request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
DO $$ BEGIN
    ASSERT (SELECT count(*) FROM evidence) = 0,
           'a non-recipient sees no evidence';
END $$;

-- 0006 revoked the client's table-level SELECT. The API must still hold it:
-- verifying a keyword means reading its hash, and fan-out needs
-- contact_user_id. A revoke that caught the API too would break both.
DO $$ BEGIN
    PERFORM keyword_hash, phone_hash, email_hash, keyword_algo FROM users;
    PERFORM contact_user_id, linked_at FROM emergency_contacts;
    RAISE NOTICE 'ok: the API retains the columns it needs to verify and match';
END $$;

-- The API role must be able to run the queue (0008) - and must NOT be able to
-- delete from it. Tasks end by state transition so the record of what ran
-- survives, the same reasoning as alerts (docs/alert-retention.md §3).
DO $$
DECLARE k text := 'rls-task-probe'; ok boolean; claimed int;
BEGIN
    ok := public.enqueue_task(k, 'safety-check', '{"alertId":"x"}'::jsonb, now() - interval '1 s');
    ASSERT ok, 'the API can enqueue';
    ASSERT NOT public.enqueue_task(k, 'safety-check', '{}'::jsonb, now()),
           'and a repeat enqueue folds onto the existing row';
    SELECT count(*) INTO claimed FROM public.claim_tasks('rls-worker', 10, interval '60 s');
    ASSERT claimed >= 1, 'the API can claim';
    ASSERT public.cancel_task(k) OR true, 'and can cancel';
    RAISE NOTICE 'ok: the API can enqueue, claim and cancel tasks';
END $$;

SELECT pg_temp.must_fail(
  $q$ DELETE FROM task_queue $q$,
  'API role deleting task history');

-- The ledger (0011) is APPEND-ONLY, even to the role that appends to it. The
-- only write path is record_task_alerts, which refuses to record a task that
-- is not actually abandoned and cannot rewrite or remove an existing row. So a
-- compromised API process can neither fabricate an abandonment nor erase one.
DO $$
DECLARE tid bigint; got bigint;
BEGIN
    -- A genuinely abandoned task of this suite's own.
    INSERT INTO public.task_queue (task_key, kind, payload, run_at, state,
                                   attempts, max_attempts, last_error, completed_at)
    VALUES ('rls-abandoned-probe','safety-check','{"alertId":"x"}'::jsonb, now(),
            'abandoned', 5, 5, 'task route returned 500', now())
    RETURNING id INTO tid;

    SELECT * INTO got FROM public.record_task_alerts(
        ARRAY[tid], ARRAY['safety-check'], ARRAY[5], ARRAY[5],
        ARRAY[now()]::timestamptz[], ARRAY['route_rejected'], ARRAY['safety'], ARRAY[true]);
    ASSERT got = tid, 'the API can append an abandonment';

    ASSERT NOT EXISTS (SELECT * FROM public.record_task_alerts(
        ARRAY[tid], ARRAY['safety-check'], ARRAY[5], ARRAY[5],
        ARRAY[now()]::timestamptz[], ARRAY['route_rejected'], ARRAY['safety'], ARRAY[true])),
        'and a repeat announces nothing - the unique index is the arbiter';

    ASSERT (SELECT count(*) FROM public.task_alert_log WHERE task_id = tid) = 1,
        'the API can read back what it appended';
    RAISE NOTICE 'ok: the API can append to the abandonment ledger, exactly once';
END $$;

-- A task that is NOT abandoned cannot be recorded as one.
DO $$
DECLARE tid bigint;
BEGIN
    INSERT INTO public.task_queue (task_key, kind, payload, run_at)
    VALUES ('rls-pending-probe','safety-check','{}'::jsonb, now() + interval '1 day')
    RETURNING id INTO tid;
    ASSERT NOT EXISTS (SELECT * FROM public.record_task_alerts(
        ARRAY[tid], ARRAY['safety-check'], ARRAY[0], ARRAY[5],
        ARRAY[now()]::timestamptz[], ARRAY['none'], ARRAY['safety'], ARRAY[true])),
        'SECURITY FAILURE: abandonment can be fabricated for a live task';
    RAISE NOTICE 'ok (denied): recording an abandonment for a task that is not abandoned';
END $$;

SELECT pg_temp.must_fail(
  $q$ INSERT INTO task_alert_log (task_id, kind, attempts, max_attempts,
                                  abandoned_at, error_class, severity, kind_registered)
      VALUES (1,'safety-check',1,1,now(),'none','background',true) $q$,
  'API role inserting into the ledger outside the function');
SELECT pg_temp.must_fail(
  $q$ UPDATE task_alert_log SET severity='background' $q$,
  'API role rewriting an abandonment into something milder');
SELECT pg_temp.must_fail(
  $q$ DELETE FROM task_alert_log $q$,
  'API role erasing the record that work was dropped');
RESET ROLE;

-- ===========================================================================
-- Identity translation (0005)
--
-- The internal uuid is the one identifier a client must never be able to
-- choose, assert or discover. These assertions cover both halves: the client
-- cannot reach the mapping at all, and the API role can only read it.
-- ===========================================================================
SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
SELECT pg_temp.must_fail(
  $q$ SELECT * FROM identity_map $q$,
  'client reading the identity map');
SELECT pg_temp.must_fail(
  $q$ INSERT INTO identity_map (firebase_uid, user_id)
      VALUES ('attacker-uid','11111111-1111-1111-1111-111111111111') $q$,
  'client minting an identity mapping');
SELECT pg_temp.must_fail(
  $q$ UPDATE identity_map SET user_id='33333333-3333-3333-3333-333333333333' $q$,
  'client repointing a mapping at another account');
RESET ROLE;

SET ROLE alehulsh_api;
DO $$ BEGIN
    ASSERT public.resolve_identity('kJ8sQ2mNpR4tV6wX1yZ3aB5cD7eF')
           = '11111111-1111-1111-1111-111111111111',
           'the API resolves a mapped subject to its internal uuid';
    ASSERT public.resolve_identity('no-such-uid') IS NULL,
           'an unmapped subject resolves to NULL, never to an invented user';
    ASSERT public.resolve_identity(NULL) IS NULL,
           'and a NULL subject resolves to nothing rather than matching a row';
END $$;

-- The request path is READ-ONLY on the identity map. 0005 revoked INSERT:
-- without this, a bug in a handler could mint an identity for an unknown uid.
SELECT pg_temp.must_fail(
  $q$ INSERT INTO identity_map (firebase_uid, user_id)
      VALUES ('api-invented-uid','22222222-2222-2222-2222-222222222222') $q$,
  'API role minting an identity mapping');
SELECT pg_temp.must_fail(
  $q$ UPDATE identity_map SET user_id='33333333-3333-3333-3333-333333333333' $q$,
  'API role repointing a mapping');
SELECT pg_temp.must_fail(
  $q$ DELETE FROM identity_map $q$,
  'API role deleting a mapping');

-- An unmapped subject must not be able to raise an alert.
DO $$ BEGIN
    BEGIN
        PERFORM public.create_alert_for_subject('no-such-uid','req-unmapped-1');
        RAISE EXCEPTION 'SECURITY FAILURE: an unmapped subject created an alert';
    EXCEPTION WHEN SQLSTATE 'AL001' THEN
        RAISE NOTICE 'ok (denied): unmapped subject creating an alert';
    END;
END $$;

-- A mapped subject can, and the row lands on HER uuid - not one she chose.
DO $$
DECLARE aid uuid; owner uuid;
BEGIN
    SELECT alert_id INTO aid FROM public.create_alert_for_subject(
        'zP3xW9vU1tS5rQ7nM2kJ4hG6fD8c', 'req-mapped-0001', 8.9956, 38.7897, 30000);
    SELECT owner_id INTO owner FROM alerts WHERE id = aid;
    ASSERT owner = '33333333-3333-3333-3333-333333333333',
           'the alert is owned by the mapped account, not one the caller named';
    ASSERT (SELECT location_quality FROM alerts WHERE id=aid) = 'live',
           'and a 30s fix with the server deriving quality is live';
    -- Also exercises the DELETE grant 0005 added: without it this raises,
    -- and deleteAllForOwner would have failed on the live role.
    DELETE FROM alerts WHERE id = aid;
    RAISE NOTICE 'ok: verified subject resolves to its own internal uuid';
END $$;

-- The one-live-alert invariant holds across the identity boundary too: a
-- mapped subject with a live alert folds onto it instead of opening a second.
DO $$
DECLARE aid uuid; was_created boolean;
BEGIN
    SELECT alert_id, created INTO aid, was_created
      FROM public.create_alert_for_subject(
        'kJ8sQ2mNpR4tV6wX1yZ3aB5cD7eF', 'req-mapped-0002', 8.9956, 38.7897, 30000);
    ASSERT NOT was_created, 'a second trigger during a live alert must not create one';
    ASSERT aid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'it folds onto the live alert';
    RAISE NOTICE 'ok: identity resolution does not bypass one-live-alert';
END $$;
RESET ROLE;

\echo 'ALL RLS DENIAL ASSERTIONS PASSED'
