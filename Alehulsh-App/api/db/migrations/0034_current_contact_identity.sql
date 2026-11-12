-- Narrow provider confirmation read for trusted recipient matching. No raw
-- Auth table grants, account linking by identifier, or provider mutations.
CREATE FUNCTION public.current_supabase_contact_identifiers(p_application_subject text)
RETURNS TABLE(verified_phone text,verified_email text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT CASE WHEN u.phone_confirmed_at IS NOT NULL THEN nullif(u.phone,'') END,
  CASE WHEN u.email_confirmed_at IS NOT NULL THEN nullif(u.email,'') END
 FROM public.identity_map m JOIN public.supabase_accounts b ON b.user_id=m.user_id
 JOIN auth.users u ON u.id=b.auth_subject WHERE m.firebase_uid=p_application_subject
  AND NOT u.is_anonymous AND u.deleted_at IS NULL AND (u.banned_until IS NULL OR u.banned_until<=clock_timestamp())
  AND (auth.uid() IS NULL OR m.user_id=auth.uid())
$$;
GRANT EXECUTE ON FUNCTION auth.uid() TO alehulsh_auth_reader;
GRANT CREATE ON SCHEMA public TO alehulsh_auth_reader;
ALTER FUNCTION public.current_supabase_contact_identifiers(text) OWNER TO alehulsh_auth_reader;
REVOKE CREATE ON SCHEMA public FROM alehulsh_auth_reader;
REVOKE ALL ON FUNCTION public.current_supabase_contact_identifiers(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.current_supabase_contact_identifiers(text) TO alehulsh_api;
