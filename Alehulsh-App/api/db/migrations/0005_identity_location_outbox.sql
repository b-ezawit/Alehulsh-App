-- 0005 — close the three migration blockers sprint 2 identified.
--
--   1. IDENTITY. The routes carry a verified Firebase subject (a 28-character
--      string); alerts.owner_id is a uuid. identity_map existed but nothing
--      resolved through it, so the repository could not serve real traffic.
--   2. LOCATION QUALITY. create_alert took a client-supplied quality and
--      trusted it, and rejected (0,0) unconditionally - contradicting the
--      validated native rule, which accepts (0,0) when the provider offered
--      evidence it measured something.
--   3. OUTBOX. There was no way to enqueue work, so an alert and its
--      notification work could not be written in one transaction.

-- ===========================================================================
-- 1. IDENTITY
-- ===========================================================================

-- The request path may READ the identity map and nothing else.
--
-- Sprint 1 granted INSERT as well. Nothing needs it: mappings are created by
-- provisioning/migration, which runs as a privileged role, never by a request.
-- Leaving INSERT would mean a bug in a request handler could mint an identity
-- for an unknown uid - exactly the "do not invent a user" failure. Enforced
-- here rather than by code discipline, because a grant cannot be forgotten.
REVOKE INSERT ON identity_map FROM alehulsh_api;

-- ---------------------------------------------------------------------------
-- resolve_identity — verified external subject -> internal uuid.
--
-- Returns NULL when there is no mapping. It NEVER creates one: an unknown uid
-- is an unknown person, and inventing a user for them would attach someone's
-- emergency to an account nobody owns.
--
-- STABLE, so it can be inlined and called repeatedly within one statement.
-- firebase_uid is the primary key, so the lookup is a single index probe and
-- at most one row can ever match - duplicate or conflicting mappings are
-- structurally impossible, not merely unlikely. user_id is UNIQUE too, so the
-- relation is one-to-one in both directions.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_identity(p_subject text)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT m.user_id FROM public.identity_map m
     WHERE m.firebase_uid = p_subject
$$;

-- ===========================================================================
-- 2. LOCATION QUALITY, DERIVED SERVER-SIDE
-- ===========================================================================

-- Removing a parameter makes CREATE OR REPLACE ambiguous rather than
-- replacing, so the 0004 signature goes first.
DROP FUNCTION IF EXISTS public.create_alert(
    uuid, text, double precision, double precision,
    public.loc_quality, bigint, double precision, interval, timestamptz);

-- Accuracy that could only have come from an actual measurement. Defined
-- before its callers: a SQL-language body is validated when it is created.
CREATE OR REPLACE FUNCTION public.measurement_evidence(p_accuracy_m double precision)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
    SELECT p_accuracy_m IS NOT NULL
       AND p_accuracy_m <> 'NaN'::double precision
       AND p_accuracy_m <> 'Infinity'::double precision
       AND p_accuracy_m > 0
$$;

-- ---------------------------------------------------------------------------
-- usable_coordinate — may this pair be published as her position?
--
-- Mirrors SosLocationDecision.isUsableCoordinate (Kotlin, 33 unit tests), and
-- keeps its two kinds of rejection apart for the same reasons:
--
-- STRUCTURAL: NaN, infinity, or outside the valid range. Not points on Earth
-- under any interpretation. No geography is assumed - the poles, the
-- antimeridian and a zero on a SINGLE axis are all legitimate and kept.
--
-- EVIDENTIAL: exactly (0,0). A real place, so it is not rejected for being
-- unlikely. It is rejected only when the provider offered no evidence it
-- measured anything, because (0,0) is what an unpopulated location struct
-- holds. A (0,0) arriving WITH plausible accuracy is genuine and is kept.
--
-- The previous version rejected (0,0) outright, which silently discarded a
-- real fix that the client had already judged genuine.
--
-- Note on NaN: Postgres orders NaN as greater than every other value, so
-- `NaN BETWEEN -90 AND 90` is already false. It is excluded explicitly anyway,
-- because that ordering is a surprise worth not relying on.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.usable_coordinate(
    p_lat        double precision,
    p_lng        double precision,
    p_accuracy_m double precision DEFAULT NULL
) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
    SELECT p_lat IS NOT NULL AND p_lng IS NOT NULL
       AND p_lat <> 'NaN'::double precision
       AND p_lng <> 'NaN'::double precision
       AND p_lat BETWEEN -90 AND 90
       AND p_lng BETWEEN -180 AND 180
       -- Evidential, and only for the uninitialised-struct value.
       AND (NOT (p_lat = 0 AND p_lng = 0) OR public.measurement_evidence(p_accuracy_m))
$$;

-- ---------------------------------------------------------------------------
-- derive_location_quality — what the evidence actually supports.
--
-- The client sends EVIDENCE (coordinates, accuracy, age). It does not send a
-- quality, and could not be believed if it did: "live" is a claim that sends
-- someone running to a position, and a device is free to be wrong about it.
-- The server decides, from the same rules as SosLocationDecision.decide:
--
--   no usable coordinate          -> 'unavailable'
--   usable, age unknown/negative  -> 'age_unknown'  (keep the position,
--                                    withdraw the claim that it is current)
--   usable, age <= p_fresh_ms     -> 'live'
--   usable, age >  p_fresh_ms     -> 'stale'
--
-- A negative age means the device clock moved; that is unknown, not fresh.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.derive_location_quality(
    p_lat        double precision,
    p_lng        double precision,
    p_age_ms     bigint,
    p_accuracy_m double precision,
    p_fresh_ms   bigint DEFAULT 120000
) RETURNS public.loc_quality
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN NOT public.usable_coordinate(p_lat, p_lng, p_accuracy_m) THEN 'unavailable'
        WHEN p_age_ms IS NULL OR p_age_ms < 0                        THEN 'age_unknown'
        WHEN p_age_ms <= p_fresh_ms                                  THEN 'live'
        ELSE 'stale'
    END::public.loc_quality
$$;

-- ---------------------------------------------------------------------------
-- create_alert — p_quality is GONE. The server derives it.
--
-- Everything else is unchanged: dual idempotency, server-stamped expiry, the
-- opening alert_history row in the same transaction.
--
-- Metadata is normalised to satisfy the table's CHECK constraints rather than
-- violating them, because a constraint violation here costs her the entire
-- alert to save a field nobody needs. A negative age, a zero accuracy and an
-- unjustified freshness claim all become "we do not know" - never an error.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_alert(
    p_owner        uuid,
    p_request_id   text,
    p_lat          double precision DEFAULT NULL,
    p_lng          double precision DEFAULT NULL,
    p_age_ms       bigint DEFAULT NULL,
    p_accuracy_m   double precision DEFAULT NULL,
    p_window       interval DEFAULT interval '2 hours',
    p_occurred_at  timestamptz DEFAULT NULL,
    p_fresh_ms     bigint DEFAULT 120000
) RETURNS TABLE (alert_id uuid, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_geo      geography(Point,4326);
    v_id       uuid;
    v_delay    bigint;
    v_quality  public.loc_quality;
    v_age      bigint;
    v_accuracy double precision;
BEGIN
    v_quality := public.derive_location_quality(p_lat, p_lng, p_age_ms, p_accuracy_m, p_fresh_ms);

    IF v_quality = 'unavailable' THEN
        -- Nothing is substituted for a position we do not have, and no
        -- metadata is kept that would imply we do.
        v_geo := NULL; v_age := NULL; v_accuracy := NULL;
    ELSE
        v_geo := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography;
        -- age_not_negative: a negative age is unknown, not a value.
        v_age := CASE WHEN p_age_ms IS NOT NULL AND p_age_ms >= 0 THEN p_age_ms END;
        -- accuracy_positive: zero, NaN and infinity are not measurements.
        v_accuracy := CASE WHEN public.measurement_evidence(p_accuracy_m)
                           THEN p_accuracy_m END;
    END IF;

    IF p_occurred_at IS NOT NULL THEN
        v_delay := GREATEST(0, (EXTRACT(EPOCH FROM (now() - p_occurred_at)) * 1000)::bigint);
    END IF;

    BEGIN
        INSERT INTO public.alerts (owner_id, request_id, location, location_quality,
                                   location_age_ms, accuracy_m, expires_at,
                                   device_reported_at, reported_delay_ms)
        VALUES (p_owner, p_request_id, v_geo, v_quality,
                v_age, v_accuracy, now() + p_window, p_occurred_at, v_delay)
        RETURNING id INTO v_id;

        INSERT INTO public.alert_history (alert_id, owner_id, from_status, to_status, actor)
        VALUES (v_id, p_owner, NULL, 'active', 'owner');

        RETURN QUERY SELECT v_id, true;
        RETURN;
    EXCEPTION WHEN unique_violation THEN
        SELECT a.id INTO v_id FROM public.alerts a
         WHERE a.owner_id = p_owner
           AND (a.request_id = p_request_id OR a.status IN ('active','escalated'))
         ORDER BY (a.request_id = p_request_id) DESC, a.created_at DESC
         LIMIT 1;
        RETURN QUERY SELECT v_id, false;
        RETURN;
    END;
END $$;

-- ---------------------------------------------------------------------------
-- create_alert_for_subject — the only entry point a request should use.
--
-- Resolves the VERIFIED external subject to an internal uuid and delegates.
-- The uuid is never accepted from, nor returned to, a caller outside the
-- database: a client cannot nominate which internal account its alert lands
-- on, because it has no way to name one.
--
-- An unmapped subject raises AL001 rather than returning a NULL owner, which
-- would have become a NOT NULL violation and read as a database fault instead
-- of what it is: we do not know who this is.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_alert_for_subject(
    p_subject      text,
    p_request_id   text,
    p_lat          double precision DEFAULT NULL,
    p_lng          double precision DEFAULT NULL,
    p_age_ms       bigint DEFAULT NULL,
    p_accuracy_m   double precision DEFAULT NULL,
    p_window       interval DEFAULT interval '2 hours',
    p_occurred_at  timestamptz DEFAULT NULL,
    p_fresh_ms     bigint DEFAULT 120000
) RETURNS TABLE (alert_id uuid, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_owner uuid;
BEGIN
    v_owner := public.resolve_identity(p_subject);
    IF v_owner IS NULL THEN
        -- No subject value is echoed: this message reaches logs, and a uid is
        -- an identifier for a person.
        RAISE EXCEPTION 'identity not mapped' USING ERRCODE = 'AL001';
    END IF;
    RETURN QUERY SELECT * FROM public.create_alert(
        v_owner, p_request_id, p_lat, p_lng, p_age_ms, p_accuracy_m,
        p_window, p_occurred_at, p_fresh_ms);
END $$;

-- ===========================================================================
-- 3. OUTBOX ENQUEUE
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- enqueue_outbox — notification work, in the caller's transaction.
--
-- Deliberately takes no explicit transaction control of its own. Called inside
-- a caller-managed transaction it commits or rolls back with the alert, which
-- is the whole point of an outbox: work that exists if and only if the alert
-- it belongs to does. There is no window in which an alert is live with
-- nothing queued, and none in which notifications are queued for an alert
-- that was rolled back.
--
-- dedupe_key is UNIQUE, so a retried enqueue folds onto the existing row and
-- reports false rather than queueing a second notification for one event.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enqueue_outbox(
    p_dedupe_key  text,
    p_alert       uuid,
    p_recipient   uuid,
    p_channel     text,
    p_payload     jsonb
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    INSERT INTO public.outbox (dedupe_key, alert_id, recipient_id, channel, payload)
    VALUES (p_dedupe_key, p_alert, p_recipient, p_channel, p_payload)
    ON CONFLICT (dedupe_key) DO NOTHING;
    RETURN FOUND;
END $$;

-- ===========================================================================
-- 4. A MISSING GRANT THAT WOULD HAVE FAILED IN PRODUCTION
-- ===========================================================================

-- AlertRepository.deleteAllForOwner issues `DELETE FROM alerts`, and the API
-- role had SELECT, INSERT, UPDATE but no DELETE. Every integration test
-- connects as the owning superuser, so nothing caught it: account deletion
-- would have failed with a permission error on the live role.
--
-- Granted rather than routed through a SECURITY DEFINER function because the
-- ordering this path must respect is already enforced by the schema: evidence
-- references alerts ON DELETE RESTRICT, so a delete that would strand R2
-- objects is refused by the database, not by convention. Clients still have
-- no DELETE on alerts at all - see the denial suite.
GRANT DELETE ON alerts TO alehulsh_api;

-- ===========================================================================
-- GRANTS — least privilege, re-stated for every new function.
-- ===========================================================================
REVOKE ALL ON FUNCTION public.resolve_identity(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.usable_coordinate(double precision,double precision,double precision) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.measurement_evidence(double precision) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.derive_location_quality(double precision,double precision,bigint,double precision,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_alert(uuid,text,double precision,double precision,bigint,double precision,interval,timestamptz,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_alert_for_subject(text,text,double precision,double precision,bigint,double precision,interval,timestamptz,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enqueue_outbox(text,uuid,uuid,text,jsonb) FROM PUBLIC;

-- The API resolves identities and creates alerts; it does not need the
-- uuid-taking create_alert, so it is not granted one.
GRANT EXECUTE ON FUNCTION public.resolve_identity(text) TO alehulsh_api;
GRANT EXECUTE ON FUNCTION public.usable_coordinate(double precision,double precision,double precision) TO alehulsh_api;
GRANT EXECUTE ON FUNCTION public.measurement_evidence(double precision) TO alehulsh_api;
GRANT EXECUTE ON FUNCTION public.derive_location_quality(double precision,double precision,bigint,double precision,bigint) TO alehulsh_api;
GRANT EXECUTE ON FUNCTION public.create_alert_for_subject(text,text,double precision,double precision,bigint,double precision,interval,timestamptz,bigint) TO alehulsh_api;
GRANT EXECUTE ON FUNCTION public.enqueue_outbox(text,uuid,uuid,text,jsonb) TO alehulsh_api;
