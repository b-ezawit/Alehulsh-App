-- API-scoped revocation. Does not modify provider-owned users/sessions or
-- invent a retention period. Provider session deletion removes its marker.
CREATE TABLE public.revoked_supabase_sessions (
 provider_session_id uuid PRIMARY KEY REFERENCES auth.sessions(id) ON DELETE CASCADE,
 auth_subject uuid NOT NULL,
 revoked_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.revoked_supabase_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.revoked_supabase_sessions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.revoked_supabase_sessions FROM PUBLIC,anon,authenticated,alehulsh_api;
GRANT SELECT ON public.revoked_supabase_sessions TO alehulsh_auth_reader;
CREATE POLICY auth_reader_revocations ON public.revoked_supabase_sessions
 FOR SELECT TO alehulsh_auth_reader USING(true);

CREATE OR REPLACE FUNCTION public.inspect_supabase_session(p_subject uuid,p_session uuid,p_max_age integer,p_inactivity integer)
RETURNS TABLE(application_subject text,verified_phone text,verified_email text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $$
 SELECT m.firebase_uid,
   CASE WHEN u.phone_confirmed_at IS NOT NULL THEN nullif(u.phone,'') END,
   CASE WHEN u.email_confirmed_at IS NOT NULL THEN nullif(u.email,'') END
 FROM auth.sessions s JOIN auth.users u ON u.id=s.user_id
 LEFT JOIN public.supabase_accounts b ON b.auth_subject=u.id
 LEFT JOIN public.identity_map m ON m.user_id=b.user_id
 WHERE u.id=p_subject AND s.id=p_session AND p_max_age>=0 AND p_inactivity>=0
   AND NOT u.is_anonymous AND u.deleted_at IS NULL
   AND (u.banned_until IS NULL OR u.banned_until<=clock_timestamp())
   AND (s.not_after IS NULL OR s.not_after>clock_timestamp())
   AND (p_max_age=0 OR s.created_at+make_interval(secs=>p_max_age)>clock_timestamp())
   AND (p_inactivity=0 OR coalesce(s.refreshed_at::timestamptz,s.created_at)+make_interval(secs=>p_inactivity)>clock_timestamp())
   AND NOT EXISTS(SELECT 1 FROM public.revoked_supabase_sessions r WHERE r.provider_session_id=s.id)
$$;
-- CREATE OR REPLACE preserves the isolated NOLOGIN owner and prior grants.
CREATE FUNCTION public.revoke_supabase_session(p_subject uuid,p_session uuid,p_max_age integer,p_inactivity integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.inspect_supabase_session(p_subject,p_session,p_max_age,p_inactivity)) THEN
  RAISE EXCEPTION 'active provider session required' USING ERRCODE='28000';
 END IF;
 INSERT INTO public.revoked_supabase_sessions(provider_session_id,auth_subject)
 VALUES(p_session,p_subject) ON CONFLICT(provider_session_id) DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION public.revoke_supabase_session(uuid,uuid,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_supabase_session(uuid,uuid,integer,integer) TO alehulsh_api;
