-- Application evidence writes must carry the owner's transaction-local
-- identity. A generic system connection is not an evidence owner, and an
-- accepted responder's read grant must never become an edit grant.
-- No hosted migration is executed as part of implementing this file.
DROP POLICY IF EXISTS evidence_api_write ON public.evidence;
DROP POLICY IF EXISTS evidence_api_update ON public.evidence;

CREATE POLICY evidence_api_write ON public.evidence FOR INSERT TO alehulsh_api
    WITH CHECK (
        owner_id = auth.uid()
        AND EXISTS (SELECT 1 FROM public.alerts al
                    WHERE al.id = evidence.alert_id AND al.owner_id = auth.uid())
    );

CREATE POLICY evidence_api_update ON public.evidence FOR UPDATE TO alehulsh_api
    USING (owner_id = auth.uid())
    WITH CHECK (
        owner_id = auth.uid()
        AND EXISTS (SELECT 1 FROM public.alerts al
                    WHERE al.id = evidence.alert_id AND al.owner_id = auth.uid())
    );
