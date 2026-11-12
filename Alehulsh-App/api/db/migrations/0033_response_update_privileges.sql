GRANT UPDATE(withdrawn_at) ON public.acceptances TO alehulsh_api;
CREATE POLICY acceptance_owner_state_update ON public.acceptances AS RESTRICTIVE
 FOR UPDATE TO alehulsh_api USING(auth.uid() IS NULL OR responder_id=auth.uid())
 WITH CHECK(auth.uid() IS NULL OR responder_id=auth.uid());
