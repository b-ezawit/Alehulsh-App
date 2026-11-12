-- State and required work commit together. No provider side effect runs here.
CREATE OR REPLACE FUNCTION public.ensure_alert_work(p_alert uuid, p_delay_ms bigint DEFAULT 120000)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a public.alerts; v_payload jsonb; stamp text;
BEGIN
  IF p_delay_ms <= 0 THEN RAISE EXCEPTION 'invalid safety delay'; END IF;
  SELECT * INTO a FROM public.alerts WHERE id = p_alert FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  v_payload := jsonb_build_object('alertId', a.id::text, 'alertKey', a.id::text);
  stamp := floor(extract(epoch FROM a.created_at) * 1000)::bigint::text;
  IF a.status IN ('resolved','cancelled','expired') THEN
    UPDATE public.task_queue SET state = 'cancelled', completed_at = now(),
      claimed_by = NULL, claimed_until = NULL
      WHERE payload->>'alertId' = a.id::text AND state IN ('pending','claimed')
        AND kind <> 'retract-inbox';
    PERFORM public.enqueue_task('retract-inbox:' || a.id, 'retract-inbox',
      v_payload || '{"kind":"retract-inbox"}'::jsonb, a.created_at);
    RETURN;
  END IF;
  PERFORM public.enqueue_task('safety-check:' || a.id || ':' || stamp, 'safety-check',
    v_payload || '{"kind":"safety-check"}'::jsonb,
    a.created_at + p_delay_ms * interval '1 millisecond');
  PERFORM public.enqueue_task('expiry:' || a.id || ':' || stamp, 'expiry',
    v_payload || '{"kind":"expiry"}'::jsonb, a.expires_at);
  PERFORM public.enqueue_task('notify-contacts:' || a.id || ':initial', 'notify-contacts',
    v_payload || '{"kind":"notify-contacts"}'::jsonb, a.created_at);
  IF a.status = 'escalated' THEN
    PERFORM public.enqueue_task('notify-contacts:' || a.id || ':escalation', 'notify-contacts',
      v_payload || '{"kind":"notify-contacts"}'::jsonb, coalesce(a.escalated_at, a.created_at));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.create_alert_with_tasks(
  p_subject text, p_request text, p_lat double precision, p_lon double precision,
  p_age bigint, p_accuracy double precision, p_window interval,
  p_occurred timestamptz, p_fresh bigint, p_delay bigint
) RETURNS TABLE(alert_id uuid, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE result record;
BEGIN
  SELECT * INTO result FROM public.create_alert_for_subject(
    p_subject,p_request,p_lat,p_lon,p_age,p_accuracy,p_window,p_occurred,p_fresh);
  PERFORM public.ensure_alert_work(result.alert_id, p_delay);
  RETURN QUERY SELECT result.alert_id, result.created;
END $$;

CREATE OR REPLACE FUNCTION public.transition_alert_with_tasks(
  p_alert uuid, p_to public.alert_status, p_actor text,
  p_reason text DEFAULT NULL, p_resolved_by text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE changed boolean;
BEGIN
  changed := public.transition_alert(p_alert,p_to,p_actor,p_reason,p_resolved_by);
  PERFORM public.ensure_alert_work(p_alert);
  RETURN changed;
END $$;

REVOKE ALL ON FUNCTION public.ensure_alert_work(uuid,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_alert_with_tasks(text,text,double precision,double precision,bigint,double precision,interval,timestamptz,bigint,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transition_alert_with_tasks(uuid,public.alert_status,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ensure_alert_work(uuid,bigint) TO alehulsh_api;
GRANT EXECUTE ON FUNCTION public.create_alert_with_tasks(text,text,double precision,double precision,bigint,double precision,interval,timestamptz,bigint,bigint) TO alehulsh_api;
GRANT EXECUTE ON FUNCTION public.transition_alert_with_tasks(uuid,public.alert_status,text,text,text) TO alehulsh_api;

-- task_queue also serves Firestore, so it cannot have an alerts FK. Cancel
-- work explicitly when a PostgreSQL incident is erased (including cascades).
CREATE FUNCTION public.cancel_erased_alert_work() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE public.task_queue SET state = 'cancelled', completed_at = now(),
      claimed_by = NULL, claimed_until = NULL
    WHERE payload->>'alertId' = OLD.id::text AND state IN ('pending','claimed');
  RETURN OLD;
END $$;
CREATE TRIGGER alerts_cancel_erased_work AFTER DELETE ON public.alerts
FOR EACH ROW EXECUTE FUNCTION public.cancel_erased_alert_work();
REVOKE ALL ON FUNCTION public.cancel_erased_alert_work() FROM PUBLIC;
