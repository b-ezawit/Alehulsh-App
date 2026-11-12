-- The API derives keyed hashes with the existing server pepper. The database
-- rechecks the provider's canonical confirmation fields under row locks so a
-- stale inspect/hash operation cannot attest a changed identifier.
CREATE FUNCTION public.sync_supabase_identifiers(p_subject uuid,p_session uuid,p_max_age integer,p_inactivity integer,
 p_phone text,p_email text,p_phone_e164 text,p_phone_hash text,p_email_hash text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE identity record; account_id uuid;
BEGIN
 PERFORM 1 FROM auth.users WHERE id=p_subject FOR SHARE;
 SELECT * INTO identity FROM public.inspect_supabase_session(p_subject,p_session,p_max_age,p_inactivity);
 IF NOT FOUND THEN RAISE EXCEPTION 'active provider session required' USING ERRCODE='28000'; END IF;
 IF identity.verified_phone IS DISTINCT FROM p_phone OR identity.verified_email IS DISTINCT FROM p_email THEN
  RAISE EXCEPTION 'provider identifiers changed' USING ERRCODE='40001';
 END IF;
 IF (p_phone_hash IS NOT NULL AND (p_phone IS NULL OR p_phone_e164 !~ '^\+251[79][0-9]{8}$'))
    OR (p_email_hash IS NOT NULL AND p_email IS NULL) THEN
  RAISE EXCEPTION 'confirmed provider identifiers required' USING ERRCODE='22023'; END IF;
 SELECT user_id INTO account_id FROM public.supabase_accounts WHERE auth_subject=p_subject;
 IF account_id IS NULL THEN RAISE EXCEPTION 'account unavailable' USING ERRCODE='AL001'; END IF;
 UPDATE public.users SET
  phone_e164=CASE WHEN p_phone_hash IS NOT NULL THEN p_phone_e164 ELSE phone_e164 END,
  phone_hash=p_phone_hash,phone_verified_at=CASE WHEN p_phone_hash IS NOT NULL THEN clock_timestamp() END,
  email_hash=p_email_hash,email_verified_at=CASE WHEN p_email_hash IS NOT NULL THEN clock_timestamp() END
 WHERE id=account_id;
END $$;
REVOKE ALL ON FUNCTION public.sync_supabase_identifiers(uuid,uuid,integer,integer,text,text,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sync_supabase_identifiers(uuid,uuid,integer,integer,text,text,text,text,text) TO alehulsh_api;
