-- A delayed expiry worker cannot extend a responder's recording access.
-- Owner reads are governed by the separate evidence_owner policy, so evidence
-- remains available to its owner after the incident ends or passes its expiry.
ALTER POLICY evidence_responder ON public.evidence TO alehulsh_api
    USING (
        evidence.deliberate
        AND evidence.state = 'stored'
        AND EXISTS (SELECT 1 FROM public.inbox i
                    WHERE i.alert_id = evidence.alert_id AND i.recipient_id = auth.uid())
        AND EXISTS (SELECT 1 FROM public.acceptances a
                    WHERE a.alert_id = evidence.alert_id AND a.responder_id = auth.uid())
        AND EXISTS (SELECT 1 FROM public.alerts al
                    WHERE al.id = evidence.alert_id
                      AND al.status IN ('active','escalated')
                      AND al.expires_at > clock_timestamp())
    );
