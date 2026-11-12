-- Owner-editable fields already collected by the mobile app. NULL preference
-- means not configured; no fabricated blood type or recording consent default.
ALTER TABLE public.users
 ADD COLUMN blood_type text NOT NULL DEFAULT '',
 ADD COLUMN medical_notes text NOT NULL DEFAULT '',
 ADD COLUMN location_sharing_enabled boolean,
 ADD COLUMN auto_audio_recording boolean,
 ADD COLUMN fake_call_enabled boolean,
 ADD COLUMN community_alerts_enabled boolean,
 ADD COLUMN email_verified_at timestamptz;
ALTER TABLE public.emergency_contacts
 ADD COLUMN email text,
 ADD COLUMN relationship text NOT NULL DEFAULT '';

-- Preserve legacy hashes as unverified rather than guessing ownership or
-- blocking unrelated profile/keyword updates. New unverified hashes are denied.
CREATE FUNCTION public.guard_verified_email_hash() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.email_hash IS NOT NULL AND NEW.email_verified_at IS NULL
    AND (TG_OP='INSERT' OR NEW.email_hash IS DISTINCT FROM OLD.email_hash) THEN
  RAISE EXCEPTION 'verified email ownership required' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_verified_email_hash() FROM PUBLIC;
CREATE TRIGGER users_verified_email_hash BEFORE INSERT OR UPDATE ON public.users
FOR EACH ROW EXECUTE FUNCTION public.guard_verified_email_hash();

-- Preferences govern new incidents. They cannot retract or cancel an existing
-- SOS outside the established keyword flow. Locking serializes this decision
-- with a concurrent owner preference update.
CREATE FUNCTION public.apply_alert_location_preference() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE sharing boolean;
BEGIN
 SELECT location_sharing_enabled INTO sharing FROM public.users WHERE id=NEW.owner_id FOR SHARE;
 IF sharing IS FALSE THEN
  NEW.location:=NULL; NEW.location_quality:='unavailable';
  NEW.location_age_ms:=NULL; NEW.accuracy_m:=NULL;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.apply_alert_location_preference() FROM PUBLIC;
CREATE TRIGGER alerts_location_preference BEFORE INSERT ON public.alerts
FOR EACH ROW EXECUTE FUNCTION public.apply_alert_location_preference();

-- If an existing development database has duplicate primaries, fail and
-- request an explicit repair plan; never choose or delete a contact silently.
CREATE UNIQUE INDEX emergency_contacts_one_primary ON public.emergency_contacts(owner_id) WHERE is_primary;
CREATE FUNCTION public.put_owned_contact(p_subject text,p_id uuid,p_label text,p_phone text,p_email text,p_relationship text,p_primary boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE owner uuid; was_new boolean;
BEGIN
 owner:=public.resolve_identity(p_subject);
 IF owner IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'owner context required' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.users WHERE id=owner FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'owner unavailable' USING ERRCODE='AL001'; END IF;
 IF length(p_label)<1 OR length(p_label)>120 OR p_phone !~ '^\+251[79][0-9]{8}$'
    OR length(p_email)>320 OR length(p_relationship)>120 OR p_primary IS NULL THEN
  RAISE EXCEPTION 'invalid contact' USING ERRCODE='22023';
 END IF;
 IF EXISTS(SELECT 1 FROM public.emergency_contacts WHERE id=p_id AND owner_id<>owner) THEN
  RAISE EXCEPTION 'contact unavailable' USING ERRCODE='AL003';
 END IF;
 SELECT NOT EXISTS(SELECT 1 FROM public.emergency_contacts WHERE id=p_id) INTO was_new;
 IF p_primary THEN UPDATE public.emergency_contacts SET is_primary=false WHERE owner_id=owner AND id<>p_id; END IF;
 INSERT INTO public.emergency_contacts(id,owner_id,label,phone_e164,email,relationship,is_primary)
 VALUES(p_id,owner,p_label,p_phone,nullif(p_email,''),p_relationship,p_primary)
 ON CONFLICT(id) DO UPDATE SET label=EXCLUDED.label,phone_e164=EXCLUDED.phone_e164,email=EXCLUDED.email,
  relationship=EXCLUDED.relationship,is_primary=EXCLUDED.is_primary,
  contact_user_id=CASE WHEN emergency_contacts.phone_e164=EXCLUDED.phone_e164
    AND emergency_contacts.email IS NOT DISTINCT FROM EXCLUDED.email THEN emergency_contacts.contact_user_id END,
  linked_at=CASE WHEN emergency_contacts.phone_e164=EXCLUDED.phone_e164
    AND emergency_contacts.email IS NOT DISTINCT FROM EXCLUDED.email THEN emergency_contacts.linked_at END
 WHERE emergency_contacts.owner_id=owner;
 RETURN was_new;
END $$;
REVOKE ALL ON FUNCTION public.put_owned_contact(text,uuid,text,text,text,text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.put_owned_contact(text,uuid,text,text,text,text,boolean) TO alehulsh_api;
