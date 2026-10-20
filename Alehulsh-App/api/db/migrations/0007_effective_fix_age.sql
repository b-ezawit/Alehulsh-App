-- 0007 — a fix is only as fresh as the moment it ARRIVES.  (audit, HIGH)
--
-- location_age_ms is how old the fix was when the DEVICE captured it. If the
-- alert then sat in the offline queue, the position is older than that by the
-- queue delay before anyone can act on it.
--
-- Reproduced before the fix: a 30-second fix triggered three hours earlier and
-- replayed on reconnect was stored as location_quality = 'live', with
-- reported_delay_ms = 10800000 sitting in the next column. A responder reading
-- 'live' would go where she was three hours ago.
--
-- Neither half was wrong alone. P3-13 made expiry run from server receipt so a
-- queued SOS still dispatches - correct, and the reason the alert survives
-- long enough for this to matter. The freshness rule then read the device's fix
-- age and never asked how long the alert had been in transit.
--
-- WHAT IS STORED DOES NOT CHANGE. location_age_ms remains the device's claim,
-- because it is evidence and overwriting evidence with a derived number loses
-- information. Only the QUALITY LABEL changes, and the label is what a
-- responder acts on.

DROP FUNCTION IF EXISTS public.create_alert(
    uuid, text, double precision, double precision,
    bigint, double precision, interval, timestamptz, bigint);

-- Adding a defaulted parameter makes CREATE OR REPLACE an OVERLOAD, not a
-- replacement. Leaving 0005's five-argument version in place would keep a
-- copy that still has the bug, and make a four-argument call ambiguous. This
-- is the second time this trap has cost a migration; it is explicit now.
DROP FUNCTION IF EXISTS public.derive_location_quality(
    double precision, double precision, bigint, double precision, bigint);

-- ---------------------------------------------------------------------------
-- derive_location_quality gains p_delay_ms: how long the alert was in transit.
--
-- Appended with a default so every existing call keeps its meaning, and so a
-- caller that genuinely has no delay (a live request) need not pass one.
--
-- An UNKNOWN age stays unknown. Adding a known delay to an unknown age does
-- not produce knowledge, so 'age_unknown' is not downgraded to 'stale' - the
-- position is kept and no claim is made about it, which is what that value
-- means.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.derive_location_quality(
    p_lat        double precision,
    p_lng        double precision,
    p_age_ms     bigint,
    p_accuracy_m double precision,
    p_fresh_ms   bigint DEFAULT 120000,
    p_delay_ms   bigint DEFAULT 0
) RETURNS public.loc_quality
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN NOT public.usable_coordinate(p_lat, p_lng, p_accuracy_m) THEN 'unavailable'
        WHEN p_age_ms IS NULL OR p_age_ms < 0                        THEN 'age_unknown'
        -- Effective age at receipt. A negative delay is impossible here
        -- (create_alert floors it at zero), but GREATEST makes that explicit
        -- rather than trusting a caller: a dishonest future device clock must
        -- never be able to subtract from the fix age and buy freshness.
        WHEN p_age_ms + GREATEST(0, COALESCE(p_delay_ms, 0)) <= p_fresh_ms THEN 'live'
        ELSE 'stale'
    END::public.loc_quality
$$;

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
    -- Computed FIRST, because the freshness decision now depends on it.
    -- Floored at zero: a device clock running ahead is not a negative delay.
    IF p_occurred_at IS NOT NULL THEN
        v_delay := GREATEST(0, (EXTRACT(EPOCH FROM (now() - p_occurred_at)) * 1000)::bigint);
    END IF;

    v_quality := public.derive_location_quality(
        p_lat, p_lng, p_age_ms, p_accuracy_m, p_fresh_ms, COALESCE(v_delay, 0));

    IF v_quality = 'unavailable' THEN
        v_geo := NULL; v_age := NULL; v_accuracy := NULL;
    ELSE
        v_geo := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography;
        v_age := CASE WHEN p_age_ms IS NOT NULL AND p_age_ms >= 0 THEN p_age_ms END;
        v_accuracy := CASE WHEN public.measurement_evidence(p_accuracy_m)
                           THEN p_accuracy_m END;
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

REVOKE ALL ON FUNCTION public.derive_location_quality(double precision,double precision,bigint,double precision,bigint,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_alert(uuid,text,double precision,double precision,bigint,double precision,interval,timestamptz,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.derive_location_quality(double precision,double precision,bigint,double precision,bigint,bigint) TO alehulsh_api;
-- create_alert stays ungranted to the API: only create_alert_for_subject is.
