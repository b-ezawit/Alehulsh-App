\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;
TRUNCATE users CASCADE;

INSERT INTO users (id, display_name) VALUES
 ('11111111-1111-1111-1111-111111111111','Alice'),
 ('22222222-2222-2222-2222-222222222222','Beza');

-- ===== idempotency =========================================================
DO $$
DECLARE a1 uuid; a2 uuid; a3 uuid; c1 bool; c2 bool; c3 bool;
BEGIN
    SELECT alert_id, created INTO a1, c1 FROM create_alert(
        '11111111-1111-1111-1111-111111111111','req-0000001A', 8.9956, 38.7897, 30000);
    ASSERT c1, 'first create must create';

    -- same requestId retried
    SELECT alert_id, created INTO a2, c2 FROM create_alert(
        '11111111-1111-1111-1111-111111111111','req-0000001A', 8.9956, 38.7897, 30000);
    ASSERT NOT c2 AND a2 = a1, 'same requestId must fold onto the original';

    -- DIFFERENT requestId while one is live (the second tap)
    SELECT alert_id, created INTO a3, c3 FROM create_alert(
        '11111111-1111-1111-1111-111111111111','req-0000002B', 8.9956, 38.7897, 30000);
    ASSERT NOT c3 AND a3 = a1, 'a second trigger must fold onto the LIVE alert, not error';

    ASSERT (SELECT count(*) FROM alerts) = 1, 'exactly one alert row exists';
    RAISE NOTICE 'ok: idempotency (same id, different id, one row)';
END $$;

-- ===== location integrity ==================================================
DO $$
DECLARE aid uuid;
BEGIN
    DELETE FROM alerts;
    SELECT alert_id INTO aid FROM create_alert(
        '22222222-2222-2222-2222-222222222222','req-noloc-001', NULL, NULL);
    ASSERT (SELECT location IS NULL FROM alerts WHERE id=aid), 'no fix => NULL location';
    ASSERT (SELECT location_quality FROM alerts WHERE id=aid) = 'unavailable',
           'and quality must say so';

    DELETE FROM alerts;
    -- (0,0) with no evidence is an uninitialised reading, not a position
    SELECT alert_id INTO aid FROM create_alert(
        '22222222-2222-2222-2222-222222222222','req-zero-0001', 0, 0);
    ASSERT (SELECT location IS NULL FROM alerts WHERE id=aid), '(0,0) must not be published';

    DELETE FROM alerts;
    SELECT alert_id INTO aid FROM create_alert(
        '22222222-2222-2222-2222-222222222222','req-bad-00001', 91, 200);
    ASSERT (SELECT location IS NULL FROM alerts WHERE id=aid), 'out-of-range must not be published';
    RAISE NOTICE 'ok: unknown/invalid location never becomes a position';
END $$;

-- ===== server-stamped expiry ===============================================
DO $$
DECLARE aid uuid;
BEGIN
    DELETE FROM alerts;
    SELECT alert_id INTO aid FROM create_alert(
        '11111111-1111-1111-1111-111111111111','req-expiry-01', 8.9956, 38.7897, 1000);
    ASSERT (SELECT expires_at > now() + interval '118 minutes' FROM alerts WHERE id=aid),
           'expiry is server-stamped ~2h ahead regardless of any client clock';
    RAISE NOTICE 'ok: server-stamped expiry';
END $$;

-- ===== transition races ====================================================
DO $$
DECLARE aid uuid; r1 bool; r2 bool;
BEGIN
    DELETE FROM alerts;
    SELECT alert_id INTO aid FROM create_alert(
        '11111111-1111-1111-1111-111111111111','req-race-0001', 8.9956, 38.7897, 1000);

    r1 := transition_alert(aid, 'resolved', 'owner');
    r2 := transition_alert(aid, 'cancelled', 'owner');      -- loser
    ASSERT r1, 'first terminal transition wins';
    ASSERT NOT r2, 'second must no-op, not contradict';
    ASSERT (SELECT status     FROM alerts WHERE id=aid) = 'resolved';
    ASSERT (SELECT end_reason FROM alerts WHERE id=aid) = 'resolved',
           'end_reason must agree with status';
    ASSERT (SELECT ended_at IS NOT NULL FROM alerts WHERE id=aid), 'terminal rows carry a timestamp';

    ASSERT NOT transition_alert(aid, 'expired', 'system'),
           'expiry cannot reopen or overwrite a terminal alert';
    RAISE NOTICE 'ok: cancel/resolve/expiry race -> single consistent terminal state';
END $$;

-- ===== cancellation vs resolution are distinct =============================
DO $$
DECLARE aid uuid;
BEGIN
    DELETE FROM alerts;
    SELECT alert_id INTO aid FROM create_alert(
        '22222222-2222-2222-2222-222222222222','req-cancel-01', NULL, NULL);
    ASSERT transition_alert(aid, 'cancelled', 'owner');
    ASSERT (SELECT status FROM alerts WHERE id=aid) = 'cancelled',
           'cancellation is its own terminal state, not resolution';
    RAISE NOTICE 'ok: cancelled is distinct from resolved';
END $$;

-- ===== outbox: claim, lease expiry, stale worker, abandon on terminal ======
DO $$
DECLARE aid uuid; n int; oid bigint;
BEGIN
    DELETE FROM alerts;
    SELECT alert_id INTO aid FROM create_alert(
        '11111111-1111-1111-1111-111111111111','req-outbox-01', 8.9956, 38.7897, 1000);
    INSERT INTO outbox (dedupe_key, alert_id, recipient_id, channel, payload)
    VALUES ('d1', aid, '22222222-2222-2222-2222-222222222222', 'fcm', '{}'::jsonb);

    SELECT count(*) INTO n FROM claim_outbox('worker-A');
    ASSERT n = 1, 'worker A claims the pending row';
    SELECT count(*) INTO n FROM claim_outbox('worker-B');
    ASSERT n = 0, 'worker B must not claim a leased row';

    SELECT id INTO oid FROM outbox WHERE dedupe_key='d1';
    ASSERT NOT complete_outbox(oid, 'worker-B', true),
           'a worker that does not hold the claim cannot complete it';
    ASSERT complete_outbox(oid, 'worker-A', true), 'the holder completes it';
    ASSERT (SELECT state FROM outbox WHERE id=oid) = 'published';

    -- expired lease is reclaimable
    UPDATE outbox SET state='claimed', claimed_by='dead-worker',
           claimed_until = now() - interval '1 minute', next_retry_at = now()
     WHERE id=oid;
    SELECT count(*) INTO n FROM claim_outbox('worker-C');
    ASSERT n = 1, 'an expired lease is reclaimed after a crash';
    RAISE NOTICE 'ok: outbox claim, lease expiry, stale-worker protection';
END $$;

DO $$
DECLARE aid uuid;
BEGIN
    DELETE FROM alerts;
    SELECT alert_id INTO aid FROM create_alert(
        '11111111-1111-1111-1111-111111111111','req-abandon-1', NULL, NULL);
    INSERT INTO outbox (dedupe_key, alert_id, recipient_id, channel, payload)
    VALUES ('d2', aid, '22222222-2222-2222-2222-222222222222', 'fcm', '{}'::jsonb);
    PERFORM transition_alert(aid, 'cancelled', 'owner');
    ASSERT (SELECT state FROM outbox WHERE dedupe_key='d2') = 'abandoned',
           'pending work for a cancelled alert is abandoned, never published';
    RAISE NOTICE 'ok: cancellation abandons pending notification work';
END $$;

-- ===== notification state semantics ========================================
DO $$
DECLARE aid uuid;
BEGIN
    DELETE FROM alerts;
    SELECT alert_id INTO aid FROM create_alert(
        '11111111-1111-1111-1111-111111111111','req-notify-01', NULL, NULL);
    INSERT INTO notification_attempts (alert_id, recipient_id, channel, state, sent_at)
    VALUES (aid,'22222222-2222-2222-2222-222222222222','fcm','sent', now());
    BEGIN
        INSERT INTO notification_attempts (alert_id, recipient_id, channel, attempt_no, state)
        VALUES (aid,'22222222-2222-2222-2222-222222222222','fcm',2,'delivered');
        RAISE EXCEPTION 'delivered without a receipt must be rejected';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'ok: delivered requires a device receipt, never inferred from a send';
    END;
    BEGIN
        INSERT INTO notification_attempts (alert_id, recipient_id, channel, attempt_no, state)
        VALUES (aid,'22222222-2222-2222-2222-222222222222','fcm',3,'queued');
        RAISE EXCEPTION 'two live attempts must be rejected';
    EXCEPTION WHEN unique_violation THEN
        RAISE NOTICE 'ok: only one attempt in flight per recipient+channel';
    END;
END $$;

-- ===== PostGIS: radius and null-location ===================================
DO $$
DECLARE aid uuid; n int;
BEGIN
    DELETE FROM alerts;
    SELECT alert_id INTO aid FROM create_alert(
        '11111111-1111-1111-1111-111111111111','req-geo-0001', 8.9956, 38.7897, 1000);
    SELECT count(*) INTO n FROM alerts
     WHERE location IS NOT NULL
       AND ST_DWithin(location, ST_SetSRID(ST_MakePoint(38.7897,8.9956),4326)::geography, 500);
    ASSERT n = 1, 'a located alert matches within 500m';

    SELECT count(*) INTO n FROM alerts
     WHERE location IS NOT NULL
       AND ST_DWithin(location, ST_SetSRID(ST_MakePoint(38.8997,8.9956),4326)::geography, 500);
    ASSERT n = 0, 'a distant point does not match';

    DELETE FROM alerts;
    SELECT alert_id INTO aid FROM create_alert(
        '22222222-2222-2222-2222-222222222222','req-geo-null1', NULL, NULL);
    SELECT count(*) INTO n FROM alerts
     WHERE location IS NOT NULL
       AND ST_DWithin(location, ST_SetSRID(ST_MakePoint(38.7897,8.9956),4326)::geography, 500);
    ASSERT n = 0, 'an alert with no location is NEVER proximity-matched';
    RAISE NOTICE 'ok: PostGIS radius + null-location never matched';
END $$;

\echo 'ALL ALERT/OUTBOX ASSERTIONS PASSED'
