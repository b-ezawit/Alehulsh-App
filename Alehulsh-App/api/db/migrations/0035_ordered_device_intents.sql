-- Client intents are durably ordered before HTTP. A delayed register cannot
-- undo a newer token/consent intent, including logout/relogin and process death.
ALTER TABLE public.push_devices ADD COLUMN intent_revision bigint NOT NULL DEFAULT 0
 CHECK(intent_revision BETWEEN 0 AND 9007199254740991);
-- Provider session cleanup must not erase application delivery history.
ALTER TABLE public.push_devices DROP CONSTRAINT push_devices_provider_session_id_fkey;
ALTER TABLE public.push_devices ALTER COLUMN provider_session_id DROP NOT NULL;
ALTER TABLE public.push_devices ADD CONSTRAINT push_devices_provider_session_id_fkey
 FOREIGN KEY(provider_session_id) REFERENCES auth.sessions(id) ON DELETE SET NULL;
CREATE FUNCTION public.disable_orphaned_push_device() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.provider_session_id IS NULL THEN NEW.enabled:=false;NEW.token:=NULL;NEW.generation:=gen_random_uuid();END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.disable_orphaned_push_device() FROM PUBLIC;
CREATE TRIGGER push_device_session_cleanup BEFORE UPDATE OF provider_session_id ON public.push_devices
 FOR EACH ROW EXECUTE FUNCTION public.disable_orphaned_push_device();
DROP FUNCTION public.put_push_device(uuid,uuid,text,text);
CREATE FUNCTION public.put_push_device(p_id uuid,p_session uuid,p_token text,p_consent text,p_revision bigint)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE owner uuid:=auth.uid(); result uuid;
BEGIN
 IF owner IS NULL OR p_revision NOT BETWEEN 1 AND 9007199254740991 OR p_revision IS NULL
  OR coalesce(length(p_token),0)<20 OR length(p_token)>4096 OR coalesce(length(p_consent),0)=0 THEN
  RAISE EXCEPTION 'valid registration required' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM auth.sessions s JOIN public.supabase_accounts b ON b.auth_subject=s.user_id
  WHERE s.id=p_session AND b.user_id=owner FOR SHARE OF s;
 IF NOT EXISTS(SELECT 1 FROM public.supabase_accounts b JOIN auth.sessions s ON s.user_id=b.auth_subject
  WHERE b.user_id=owner AND s.id=p_session AND NOT EXISTS(SELECT 1 FROM public.revoked_supabase_sessions r WHERE r.provider_session_id=s.id)) THEN
  RAISE EXCEPTION 'active owner session required' USING ERRCODE='28000'; END IF;
 IF EXISTS(SELECT 1 FROM public.push_devices WHERE id=p_id AND user_id<>owner) THEN
  RAISE EXCEPTION 'device unavailable' USING ERRCODE='23505'; END IF;
 INSERT INTO public.push_devices(id,user_id,provider_session_id,token,consent_version,intent_revision)
 VALUES(p_id,owner,p_session,p_token,p_consent,p_revision)
 ON CONFLICT(id) DO UPDATE SET token=EXCLUDED.token,provider_session_id=EXCLUDED.provider_session_id,
  consent_version=EXCLUDED.consent_version,enabled=true,intent_revision=EXCLUDED.intent_revision,updated_at=clock_timestamp(),
  generation=CASE WHEN push_devices.token IS NOT DISTINCT FROM EXCLUDED.token AND push_devices.enabled
   AND push_devices.consent_version=EXCLUDED.consent_version AND push_devices.provider_session_id=EXCLUDED.provider_session_id
   THEN push_devices.generation ELSE gen_random_uuid() END
 WHERE push_devices.user_id=owner AND (push_devices.intent_revision<EXCLUDED.intent_revision OR
  (push_devices.intent_revision=EXCLUDED.intent_revision AND push_devices.enabled AND push_devices.token=EXCLUDED.token
   AND push_devices.consent_version=EXCLUDED.consent_version AND push_devices.provider_session_id=EXCLUDED.provider_session_id))
 RETURNING generation INTO result;
 IF result IS NULL THEN RAISE EXCEPTION 'stale device intent' USING ERRCODE='23505'; END IF;
 PERFORM public.queue_private_delivery(i.alert_id,owner,false) FROM public.inbox i JOIN public.alerts a ON a.id=i.alert_id
  WHERE i.recipient_id=owner AND a.status IN ('active','escalated') AND a.expires_at>clock_timestamp();
 RETURN result;
END $$;
CREATE FUNCTION public.disable_push_device(p_id uuid,p_session uuid,p_generation uuid,p_revision bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE owner uuid:=auth.uid();
BEGIN
 IF owner IS NULL OR p_revision NOT BETWEEN 1 AND 9007199254740991 OR p_revision IS NULL THEN
  RAISE EXCEPTION 'valid intent required' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.supabase_accounts b JOIN auth.sessions s ON s.user_id=b.auth_subject
  WHERE b.user_id=owner AND s.id=p_session AND NOT EXISTS(SELECT 1 FROM public.revoked_supabase_sessions r WHERE r.provider_session_id=s.id)) THEN
  RAISE EXCEPTION 'active owner session required' USING ERRCODE='28000'; END IF;
 IF EXISTS(SELECT 1 FROM public.push_devices WHERE id=p_id AND user_id<>owner) THEN RETURN; END IF;
 -- A tombstone also defeats an earlier register whose response was lost.
 INSERT INTO public.push_devices(id,user_id,provider_session_id,token,consent_version,enabled,intent_revision)
 VALUES(p_id,owner,p_session,NULL,'',false,p_revision)
 ON CONFLICT(id) DO UPDATE SET token=NULL,enabled=false,intent_revision=EXCLUDED.intent_revision,
  generation=gen_random_uuid(),updated_at=clock_timestamp()
 WHERE push_devices.user_id=owner AND (push_devices.intent_revision<EXCLUDED.intent_revision OR
  (push_devices.intent_revision=EXCLUDED.intent_revision AND push_devices.generation=p_generation));
END $$;
REVOKE ALL ON FUNCTION public.put_push_device(uuid,uuid,text,text,bigint) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.disable_push_device(uuid,uuid,uuid,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.put_push_device(uuid,uuid,text,text,bigint) TO alehulsh_api;
GRANT EXECUTE ON FUNCTION public.disable_push_device(uuid,uuid,uuid,bigint) TO alehulsh_api;

CREATE OR REPLACE FUNCTION public.revoke_supabase_session(p_subject uuid,p_session uuid,p_max_age integer,p_inactivity integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 -- Serialize with registration: no stale request can reclaim the token after
 -- confirmed logout and block the next account on the same installation.
 PERFORM 1 FROM auth.sessions WHERE id=p_session AND user_id=p_subject FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM public.inspect_supabase_session(p_subject,p_session,p_max_age,p_inactivity)) THEN
  RAISE EXCEPTION 'active provider session required' USING ERRCODE='28000'; END IF;
 INSERT INTO public.revoked_supabase_sessions(provider_session_id,auth_subject)
 VALUES(p_session,p_subject) ON CONFLICT(provider_session_id) DO NOTHING;
 UPDATE public.push_devices SET enabled=false,token=NULL,generation=gen_random_uuid()
 WHERE provider_session_id=p_session;
END $$;
