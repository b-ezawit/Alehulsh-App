-- Terminal reconciliation is queued by inbox retraction in the transition
-- transaction. Abandon initial delivery work while preserving that opaque hint.
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
         WHERE alert_id = p_alert AND state IN ('pending','claimed')
           AND NOT (channel='private-push' AND payload->>'kind'='reconcile');
    END IF;
    RETURN true;
END $$;
