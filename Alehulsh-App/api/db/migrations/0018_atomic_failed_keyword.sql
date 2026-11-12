-- A failed keyword is itself an escalation event. A crash must not leave the
-- recorded attempt disconnected from the state change and notification work.
CREATE FUNCTION public.fail_keyword_attempt_with_tasks(p_alert uuid, p_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a public.alerts;
BEGIN
  SELECT * INTO a FROM public.alerts WHERE id = p_alert FOR UPDATE;
  IF NOT FOUND OR a.status NOT IN ('active','escalated') THEN RETURN; END IF;
  PERFORM public.record_failed_attempt(p_alert, p_at);
  IF a.status = 'active' THEN
    PERFORM public.transition_alert_with_tasks(p_alert, 'escalated', 'owner', 'wrong_keyword', NULL);
  ELSE
    PERFORM public.ensure_alert_work(p_alert);
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.fail_keyword_attempt_with_tasks(uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fail_keyword_attempt_with_tasks(uuid,timestamptz) TO alehulsh_api;
