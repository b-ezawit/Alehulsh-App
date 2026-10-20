-- 0003_functions — alert transitions and outbox claiming.
--
-- These are SECURITY DEFINER because they are the ONLY sanctioned way to move
-- server-owned state. Each pins search_path, schema-qualifies its objects, and
-- is executable only by the API role.

-- ---------------------------------------------------------------------------
-- create_alert — idempotent in BOTH senses that matter.
--
--   same request_id  -> the retry folds onto the original row
--   different request_id while one is live -> folds onto the LIVE alert
--
-- The second case is the one a naive ON CONFLICT misses: it violates
-- alerts_one_live_per_owner, a different constraint, and would surface as an
-- unexplained 500 during an emergency.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_alert(
    p_owner        uuid,
    p_request_id   text,
    p_lat          double precision DEFAULT NULL,
    p_lng          double precision DEFAULT NULL,
    p_quality      public.loc_quality DEFAULT 'unavailable',
    p_age_ms       bigint DEFAULT NULL,
    p_accuracy_m   double precision DEFAULT NULL,
    p_window       interval DEFAULT interval '2 hours'
) RETURNS TABLE (alert_id uuid, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_geo  geography(Point,4326);
    v_id   uuid;
BEGIN
    -- A coordinate is published only if it is a real point. Nothing is
    -- substituted when it is not: unknown stays unknown.
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
        p_quality := 'age_unknown';           -- a position with no claim about age
    END IF;

    BEGIN
        INSERT INTO public.alerts (owner_id, request_id, location, location_quality,
                                   location_age_ms, accuracy_m, expires_at)
        VALUES (p_owner, p_request_id, v_geo, p_quality, p_age_ms, p_accuracy_m,
                now() + p_window)          -- SERVER-stamped expiry, never the client's
        RETURNING id INTO v_id;

        INSERT INTO public.alert_history (alert_id, owner_id, from_status, to_status, actor)
        VALUES (v_id, p_owner, NULL, 'active', 'owner');

        RETURN QUERY SELECT v_id, true;
        RETURN;
    EXCEPTION WHEN unique_violation THEN
        -- Either the same request retried, or a second trigger during a live
        -- alert. Both mean: she already has one. Return it.
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
-- transition_alert — one conditional UPDATE. Concurrent cancel/resolve/expiry
-- cannot produce contradictory terminal states: the first commit wins and the
-- loser affects zero rows.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.transition_alert(
    p_alert  uuid,
    p_to     public.alert_status,
    p_actor  text,
    p_reason text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_from public.alert_status;
BEGIN
    IF p_to NOT IN ('escalated','resolved','cancelled','expired') THEN
        RAISE EXCEPTION 'unsupported transition target %', p_to;
    END IF;

    UPDATE public.alerts a
       SET status       = p_to,
           ended_at     = CASE WHEN p_to IN ('resolved','cancelled','expired') THEN now() END,
           end_reason   = CASE WHEN p_to IN ('resolved','cancelled','expired') THEN p_to END,
           escalated_at = CASE WHEN p_to = 'escalated' THEN now() ELSE a.escalated_at END,
           escalation_reason = CASE WHEN p_to = 'escalated' THEN p_reason ELSE a.escalation_reason END
     WHERE a.id = p_alert
       AND a.status IN ('active','escalated')   -- terminal states are final
       AND NOT (p_to = 'escalated' AND a.status = 'escalated')
    RETURNING (SELECT s.status FROM public.alerts s WHERE s.id = p_alert) INTO v_from;

    IF NOT FOUND THEN
        RETURN false;                            -- already terminal; caller no-ops
    END IF;

    INSERT INTO public.alert_history (alert_id, owner_id, from_status, to_status, actor, reason)
    SELECT p_alert, a.owner_id, NULL, p_to, p_actor, p_reason
      FROM public.alerts a WHERE a.id = p_alert;

    -- Pending work for a now-terminal alert is abandoned rather than published.
    IF p_to IN ('resolved','cancelled','expired') THEN
        UPDATE public.outbox
           SET state = 'abandoned', last_error = 'alert terminal: ' || p_to
         WHERE alert_id = p_alert AND state IN ('pending','claimed');
    END IF;
    RETURN true;
END $$;

-- ---------------------------------------------------------------------------
-- claim_outbox — safe concurrent claiming.
--
-- FOR UPDATE SKIP LOCKED is the claim; claimed_until is a LEASE, so a
-- dispatcher that dies releases its work by expiry instead of holding it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_outbox(
    p_worker text, p_limit int DEFAULT 20, p_lease interval DEFAULT interval '60 seconds'
) RETURNS SETOF public.outbox
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    RETURN QUERY
    UPDATE public.outbox o
       SET state = 'claimed', claimed_by = p_worker,
           claimed_until = now() + p_lease, attempts = o.attempts + 1
     WHERE o.id IN (
         SELECT c.id FROM public.outbox c
          WHERE c.next_retry_at <= now()
            AND (c.state = 'pending'
                 OR (c.state = 'claimed' AND c.claimed_until < now()))  -- expired lease
          ORDER BY c.next_retry_at
          FOR UPDATE SKIP LOCKED
          LIMIT p_limit
     )
    RETURNING o.*;
END $$;

-- Conditional completion: a stale worker whose lease expired and whose row was
-- re-claimed by someone else cannot overwrite the newer claim.
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
           -- bounded exponential backoff
           next_retry_at = CASE WHEN p_ok THEN o.next_retry_at
                                ELSE now() + (interval '10 seconds' * power(2, o.attempts)) END
     WHERE o.id = p_id
       AND o.claimed_by = p_worker          -- the stale-worker guard
       AND o.state = 'claimed';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN v_rows = 1;
END $$;

REVOKE ALL ON FUNCTION public.create_alert(uuid,text,double precision,double precision,public.loc_quality,bigint,double precision,interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transition_alert(uuid,public.alert_status,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_outbox(text,int,interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_outbox(bigint,text,boolean,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_alert(uuid,text,double precision,double precision,public.loc_quality,bigint,double precision,interval) TO alehulsh_api;
GRANT EXECUTE ON FUNCTION public.transition_alert(uuid,public.alert_status,text,text) TO alehulsh_api;
GRANT EXECUTE ON FUNCTION public.claim_outbox(text,int,interval) TO alehulsh_api;
GRANT EXECUTE ON FUNCTION public.complete_outbox(bigint,text,boolean,text) TO alehulsh_api;
