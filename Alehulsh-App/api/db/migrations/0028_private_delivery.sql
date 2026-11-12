-- Reuse the existing leased/retried outbox. Tokens never enter its payload.
CREATE TABLE public.push_devices (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
 provider_session_id uuid NOT NULL REFERENCES auth.sessions(id) ON DELETE CASCADE,
 token text UNIQUE,
 generation uuid NOT NULL DEFAULT gen_random_uuid(),
 consent_version text NOT NULL,
 enabled boolean NOT NULL DEFAULT true,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(token IS NULL OR length(token) BETWEEN 20 AND 4096)
);
ALTER TABLE public.push_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_devices FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.push_devices FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.push_devices TO alehulsh_api;
-- API system processing needs tokens; no mobile or direct SQL client grants.
CREATE POLICY push_devices_api ON public.push_devices FOR ALL TO alehulsh_api USING(true) WITH CHECK(true);
ALTER TABLE public.outbox
 ADD COLUMN delivery_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
 ADD COLUMN device_id uuid REFERENCES public.push_devices(id) ON DELETE CASCADE,
 ADD COLUMN device_generation uuid,
 ADD COLUMN provider_message_id text,
 ADD COLUMN device_received_at timestamptz,
 ADD COLUMN opened_at timestamptz;

CREATE FUNCTION public.queue_private_delivery(p_alert uuid,p_recipient uuid,p_terminal boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 INSERT INTO public.outbox(dedupe_key,alert_id,recipient_id,channel,payload,device_id,device_generation)
 SELECT 'private:'||p_alert||':'||d.id||':'||d.generation||':'||p_terminal,
  p_alert,p_recipient,'private-push',jsonb_build_object('kind',CASE WHEN p_terminal THEN 'reconcile' ELSE 'incident' END),d.id,d.generation
 FROM public.push_devices d WHERE d.user_id=p_recipient AND d.enabled AND d.token IS NOT NULL
  AND EXISTS(SELECT 1 FROM public.alerts WHERE id=p_alert)
 ON CONFLICT(dedupe_key) DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION public.queue_private_delivery(uuid,uuid,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.queue_private_delivery(uuid,uuid,boolean) TO alehulsh_api;

CREATE FUNCTION public.private_inbox_delivery() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  PERFORM public.queue_private_delivery(OLD.alert_id,OLD.recipient_id,true);RETURN OLD;
 END IF;
 PERFORM public.queue_private_delivery(NEW.alert_id,NEW.recipient_id,false);RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.private_inbox_delivery() FROM PUBLIC;
CREATE TRIGGER inbox_private_delivery AFTER INSERT OR UPDATE OR DELETE ON public.inbox
 FOR EACH ROW EXECUTE FUNCTION public.private_inbox_delivery();

CREATE FUNCTION public.put_push_device(p_id uuid,p_session uuid,p_token text,p_consent text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE owner uuid:=auth.uid(); current_generation uuid;
BEGIN
 IF owner IS NULL OR length(p_token)<20 OR length(p_token)>4096 OR coalesce(length(p_consent),0)=0 THEN
  RAISE EXCEPTION 'valid registration required' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.supabase_accounts b JOIN auth.sessions s ON s.user_id=b.auth_subject
  WHERE b.user_id=owner AND s.id=p_session AND NOT EXISTS(SELECT 1 FROM public.revoked_supabase_sessions r WHERE r.provider_session_id=s.id)) THEN
  RAISE EXCEPTION 'active owner session required' USING ERRCODE='28000'; END IF;
 IF EXISTS(SELECT 1 FROM public.push_devices WHERE id=p_id AND user_id<>owner) THEN
  RAISE EXCEPTION 'device unavailable' USING ERRCODE='23505'; END IF;
 INSERT INTO public.push_devices(id,user_id,provider_session_id,token,consent_version)
 VALUES(p_id,owner,p_session,p_token,p_consent)
 ON CONFLICT(id) DO UPDATE SET token=EXCLUDED.token,provider_session_id=EXCLUDED.provider_session_id,
  consent_version=EXCLUDED.consent_version,enabled=true,updated_at=clock_timestamp(),
  generation=CASE WHEN push_devices.token IS NOT DISTINCT FROM EXCLUDED.token AND push_devices.enabled
    AND push_devices.consent_version=EXCLUDED.consent_version AND push_devices.provider_session_id=EXCLUDED.provider_session_id
    THEN push_devices.generation ELSE gen_random_uuid() END
 WHERE push_devices.user_id=owner RETURNING generation INTO current_generation;
 -- Recover active incidents for token refresh, new devices and missed wakeups.
 PERFORM public.queue_private_delivery(i.alert_id,owner,false) FROM public.inbox i JOIN public.alerts a ON a.id=i.alert_id
 WHERE i.recipient_id=owner AND a.status IN ('active','escalated') AND a.expires_at>clock_timestamp();
 RETURN current_generation;
END $$;
REVOKE ALL ON FUNCTION public.put_push_device(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.put_push_device(uuid,uuid,text,text) TO alehulsh_api;

-- No direct provider table or revocation-table privileges for the dispatcher.
CREATE FUNCTION public.private_device_session_active(p_device uuid,p_max_age integer,p_inactivity integer)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.push_devices d JOIN auth.sessions s ON s.id=d.provider_session_id
  JOIN public.supabase_accounts b ON b.auth_subject=s.user_id AND b.user_id=d.user_id
  CROSS JOIN LATERAL public.inspect_supabase_session(s.user_id,s.id,p_max_age,p_inactivity) live
  WHERE d.id=p_device AND d.enabled)
$$;
REVOKE ALL ON FUNCTION public.private_device_session_active(uuid,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.private_device_session_active(uuid,integer,integer) TO alehulsh_api;
