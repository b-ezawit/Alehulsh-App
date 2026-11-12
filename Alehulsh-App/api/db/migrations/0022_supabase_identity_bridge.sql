-- Requires existing Supabase Auth tables. Local harness uses a separate,
-- synthetic-only fixture; this migration never creates provider-owned tables.
-- Fail before DDL if the approved operator cannot install the narrowly
-- scoped reader policies. Hosted metadata proves the currently supplied
-- development login lacks this authority; do not work around it silently.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='auth' AND c.relname IN ('users','sessions')
     AND NOT pg_has_role(current_user,c.relowner,'USAGE')) THEN
  RAISE EXCEPTION 'approved Auth policy owner authority required' USING ERRCODE='42501';
 END IF;
END $$;
-- A custom role can have accessor EXECUTE but lack auth schema USAGE.
-- Grant only use of this existing accessor, never replace its body.
-- If the migration operator lacks grant authority, fail for owner review.
GRANT USAGE ON SCHEMA auth TO alehulsh_api;
GRANT EXECUTE ON FUNCTION auth.uid() TO alehulsh_api;
DO $$ BEGIN
 IF NOT has_schema_privilege('alehulsh_api','auth','USAGE') THEN
  RAISE EXCEPTION 'approved Auth schema grant authority required' USING ERRCODE='42501';
 END IF;
END $$;
CREATE TABLE public.supabase_accounts (
  auth_subject uuid PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
  linked_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.supabase_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supabase_accounts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.supabase_accounts FROM PUBLIC,anon,authenticated,alehulsh_api;

DO $$ BEGIN
 CREATE ROLE alehulsh_auth_reader NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Never reuse an existing privileged role as the SECURITY DEFINER owner.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='alehulsh_auth_reader'
   AND (rolcanlogin OR rolinherit OR rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication))
   OR EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member OR r.oid=m.roleid
     WHERE r.rolname='alehulsh_auth_reader') THEN
  RAISE EXCEPTION 'auth reader role requires isolated restricted ownership';
 END IF;
END $$;
GRANT USAGE ON SCHEMA auth,public TO alehulsh_auth_reader;
GRANT SELECT(id,email,email_confirmed_at,phone,phone_confirmed_at,banned_until,deleted_at,is_anonymous)
 ON auth.users TO alehulsh_auth_reader;
GRANT SELECT(id,user_id,created_at,refreshed_at,not_after) ON auth.sessions TO alehulsh_auth_reader;
GRANT SELECT ON public.supabase_accounts,public.identity_map TO alehulsh_auth_reader;
-- Provider Auth tables already use RLS. Extend SELECT solely to this isolated
-- NOLOGIN function-owner role, with the narrow column grants above. This
-- requires explicit hosted approval and an operator with policy authority;
-- never disable Auth RLS or grant the general API access to Auth records.
CREATE POLICY alehulsh_bridge_users_read ON auth.users FOR SELECT TO alehulsh_auth_reader USING(true);
CREATE POLICY alehulsh_bridge_sessions_read ON auth.sessions FOR SELECT TO alehulsh_auth_reader USING(true);
CREATE POLICY auth_reader_bindings ON public.supabase_accounts FOR SELECT TO alehulsh_auth_reader USING(true);
CREATE POLICY auth_reader_canonical_identity ON public.identity_map FOR SELECT TO alehulsh_auth_reader USING(true);

CREATE FUNCTION public.inspect_supabase_session(p_subject uuid,p_session uuid,p_max_age integer,p_inactivity integer)
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
$$;
-- Transfer only this read function to a role that cannot modify Auth data.
-- CREATE is granted only while assigning function ownership, then revoked.
GRANT CREATE ON SCHEMA public TO alehulsh_auth_reader;
ALTER FUNCTION public.inspect_supabase_session(uuid,uuid,integer,integer) OWNER TO alehulsh_auth_reader;
REVOKE CREATE ON SCHEMA public FROM alehulsh_auth_reader;
REVOKE ALL ON FUNCTION public.inspect_supabase_session(uuid,uuid,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inspect_supabase_session(uuid,uuid,integer,integer) TO alehulsh_api;
GRANT EXECUTE ON FUNCTION public.inspect_supabase_session(uuid,uuid,integer,integer) TO CURRENT_USER;

CREATE FUNCTION public.provision_supabase_account(p_subject uuid,p_session uuid,p_max_age integer,p_inactivity integer,
 p_name text,p_address text,p_hash text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE current_identity record; application_id uuid; canonical text;
BEGIN
 IF coalesce(length(p_name),0)<1 OR length(p_name)>120 OR length(p_address)>1000
    OR coalesce(length(p_hash),0)=0 THEN RAISE EXCEPTION 'invalid profile' USING ERRCODE='22023'; END IF;
 -- Serialize explicit provisioning only. A normal SOS never creates an account.
 PERFORM pg_advisory_xact_lock(hashtextextended('supabase-account:'||p_subject::text,0));
 SELECT * INTO current_identity FROM public.inspect_supabase_session(p_subject,p_session,p_max_age,p_inactivity);
 IF NOT FOUND THEN RAISE EXCEPTION 'active provider session required' USING ERRCODE='28000'; END IF;
 IF current_identity.application_subject IS NOT NULL THEN RETURN current_identity.application_subject; END IF;
 -- No account linking by email/phone/name. Legacy mappings remain untouched.
 canonical:='supabase:'||p_subject::text;
 IF EXISTS(SELECT 1 FROM public.identity_map WHERE firebase_uid=canonical) THEN
   RAISE EXCEPTION 'identity binding requires review' USING ERRCODE='23505'; END IF;
 INSERT INTO public.users(display_name,home_address,keyword_hash,must_set_keyword)
 VALUES(p_name,coalesce(p_address,''),p_hash,false) RETURNING id INTO application_id;
 INSERT INTO public.identity_map(firebase_uid,user_id) VALUES(canonical,application_id);
 INSERT INTO public.supabase_accounts(auth_subject,user_id) VALUES(p_subject,application_id);
 RETURN canonical;
END $$;
REVOKE ALL ON FUNCTION public.provision_supabase_account(uuid,uuid,integer,integer,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.provision_supabase_account(uuid,uuid,integer,integer,text,text,text) TO alehulsh_api;
