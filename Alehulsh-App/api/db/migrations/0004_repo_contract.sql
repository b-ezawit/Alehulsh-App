-- 0004 — close the gaps between the AlertRepository interface and the
-- functions written in sprint 1. Each is a real mismatch found by reading the
-- interface and its call sites, not a speculative addition.
--
--   1. create() accepts occurredAt (device clock) and the domain carries
--      reportedDelayMs. 0003's create_alert had neither.
--   2. updateStatus('resolved', { resolvedBy }) passes 'owner' | 'owner_late'.
--      There was no column for it.

-- Adding a parameter makes CREATE OR REPLACE an OVERLOAD, not a replacement,
-- which leaves two candidates and makes every call ambiguous. Drop the 0003
-- signatures first.
DROP FUNCTION IF EXISTS public.create_alert(
    uuid, text, double precision, double precision,
    public.loc_quality, bigint, double precision, interval);
DROP FUNCTION IF EXISTS public.transition_alert(
    uuid, public.alert_status, text, text);

ALTER TABLE alerts ADD COLUMN IF NOT EXISTS resolved_by text
    CHECK (resolved_by IS NULL OR resolved_by IN ('owner','owner_late'));

-- create_alert, now recording the device-reported time and the server-computed
-- delay. The device clock is STORED, never trusted for a decision: its only
-- job is to let a recipient see that a position is two hours old.
CREATE OR REPLACE FUNCTION public.create_alert(
    p_owner        uuid,
    p_request_id   text,
    p_lat          double precision DEFAULT NULL,
    p_lng          double precision DEFAULT NULL,
    p_quality      public.loc_quality DEFAULT 'unavailable',
    p_age_ms       bigint DEFAULT NULL,
    p_accuracy_m   double precision DEFAULT NULL,
    p_window       interval DEFAULT interval '2 hours',
    p_occurred_at  timestamptz DEFAULT NULL
) RETURNS TABLE (alert_id uuid, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_geo   geography(Point,4326);
    v_id    uuid;
    v_delay bigint;
BEGIN
    IF p_lat IS NOT NULL AND p_lng IS NOT NULL
       AND p_lat BETWEEN -90 AND 90 AND p_lng BETWEEN -180 AND 180
       AND NOT (p_lat = 0 AND p_lng = 0)
    THEN
        v_geo := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography;
    ELSE
        v_geo := NULL;
    END IF;

    IF v_geo IS NULL THEN
        p_quality := 'unavailable'; p_age_ms := NULL; p_accuracy_m := NULL;
    ELSIF p_quality = 'unavailable' THEN
        p_quality := 'age_unknown';
    END IF;

    -- Server-computed from the server clock. A negative value would mean the
    -- device clock is ahead; that is not a delay, so it is discarded.
    IF p_occurred_at IS NOT NULL THEN
        v_delay := GREATEST(0, (EXTRACT(EPOCH FROM (now() - p_occurred_at)) * 1000)::bigint);
    END IF;

    BEGIN
        INSERT INTO public.alerts (owner_id, request_id, location, location_quality,
                                   location_age_ms, accuracy_m, expires_at,
                                   device_reported_at, reported_delay_ms)
        VALUES (p_owner, p_request_id, v_geo, p_quality, p_age_ms, p_accuracy_m,
                now() + p_window, p_occurred_at, v_delay)
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

-- transition_alert, now carrying resolved_by.
CREATE OR REPLACE FUNCTION public.transition_alert(
    p_alert       uuid,
    p_to          public.alert_status,
    p_actor       text,
    p_reason      text DEFAULT NULL,
    p_resolved_by text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF p_to NOT IN ('escalated','resolved','cancelled','expired') THEN
        RAISE EXCEPTION 'unsupported transition target %', p_to;
    END IF;

    UPDATE public.alerts a
       SET status       = p_to,
           ended_at     = CASE WHEN p_to IN ('resolved','cancelled','expired') THEN now() END,
           end_reason   = CASE WHEN p_to IN ('resolved','cancelled','expired') THEN p_to END,
           resolved_by  = CASE WHEN p_to = 'resolved' THEN p_resolved_by ELSE a.resolved_by END,
           escalated_at = CASE WHEN p_to = 'escalated' THEN now() ELSE a.escalated_at END,
           escalation_reason = CASE WHEN p_to = 'escalated' THEN p_reason ELSE a.escalation_reason END
     WHERE a.id = p_alert
       AND a.status IN ('active','escalated')
       AND NOT (p_to = 'escalated' AND a.status = 'escalated');

    IF NOT FOUND THEN
        RETURN false;
    END IF;

    INSERT INTO public.alert_history (alert_id, owner_id, from_status, to_status, actor, reason)
    SELECT p_alert, a.owner_id, NULL, p_to, p_actor, p_reason
      FROM public.alerts a WHERE a.id = p_alert;

    IF p_to IN ('resolved','cancelled','expired') THEN
        UPDATE public.outbox
           SET state = 'abandoned', last_error = 'alert terminal: ' || p_to
         WHERE alert_id = p_alert AND state IN ('pending','claimed');
    END IF;
    RETURN true;
END $$;

-- Record a failed keyword attempt. Never resets; a cluster is itself evidence.
CREATE OR REPLACE FUNCTION public.record_failed_attempt(p_alert uuid, p_at timestamptz)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    UPDATE public.alerts
       SET attempt_count = attempt_count + 1, last_attempt_at = p_at
     WHERE id = p_alert;
    RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION public.create_alert(uuid,text,double precision,double precision,public.loc_quality,bigint,double precision,interval,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transition_alert(uuid,public.alert_status,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_failed_attempt(uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_alert(uuid,text,double precision,double precision,public.loc_quality,bigint,double precision,interval,timestamptz) TO alehulsh_api;
GRANT EXECUTE ON FUNCTION public.transition_alert(uuid,public.alert_status,text,text,text) TO alehulsh_api;
GRANT EXECUTE ON FUNCTION public.record_failed_attempt(uuid,timestamptz) TO alehulsh_api;
