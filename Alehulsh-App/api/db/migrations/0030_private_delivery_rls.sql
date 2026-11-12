-- A null identity is reserved for explicitly composed system work. Mapped
-- request transactions cannot read a different account's device token.
DROP POLICY push_devices_api ON public.push_devices;
CREATE POLICY push_devices_api ON public.push_devices FOR ALL TO alehulsh_api
 USING(auth.uid() IS NULL OR user_id=auth.uid()) WITH CHECK(auth.uid() IS NULL OR user_id=auth.uid());
DROP POLICY outbox_api ON public.outbox;
CREATE POLICY outbox_api_read ON public.outbox FOR SELECT TO alehulsh_api
 USING(auth.uid() IS NULL OR recipient_id=auth.uid() OR EXISTS(SELECT 1 FROM public.alerts a WHERE a.id=alert_id AND a.owner_id=auth.uid()));
CREATE POLICY outbox_api_write ON public.outbox FOR INSERT TO alehulsh_api WITH CHECK(auth.uid() IS NULL);
CREATE POLICY outbox_api_update ON public.outbox FOR UPDATE TO alehulsh_api
 USING(auth.uid() IS NULL OR recipient_id=auth.uid()) WITH CHECK(auth.uid() IS NULL OR recipient_id=auth.uid());
