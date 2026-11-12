-- Freeze evidence identity/consent metadata at creation, and published byte
-- identity once finalized. This does not change deletion or retention policy.
CREATE FUNCTION public.guard_evidence_immutability() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE publication boolean;
BEGIN
  IF ROW(NEW.id,NEW.alert_id,NEW.owner_id,NEW.content_type,NEW.duration_ms,NEW.deliberate,NEW.created_at,NEW.declared_sha256)
     IS DISTINCT FROM
     ROW(OLD.id,OLD.alert_id,OLD.owner_id,OLD.content_type,OLD.duration_ms,OLD.deliberate,OLD.created_at,OLD.declared_sha256) THEN
    RAISE EXCEPTION 'evidence metadata is immutable' USING ERRCODE='23514';
  END IF;
  publication := OLD.r2_key ~ '^evidence/[^/]+/[^/]+/[^/]+$'
    AND left(NEW.r2_key,length(OLD.r2_key)+11)=OLD.r2_key||'/published/'
    AND substring(NEW.r2_key from length(OLD.r2_key)+12) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND NEW.state='stored' AND NEW.actual_sha256 ~* '^[0-9a-f]{64}$'
    AND NEW.size_bytes>0 AND NEW.completed_at IS NOT NULL;
  IF NEW.r2_key IS DISTINCT FROM OLD.r2_key AND NOT coalesce(publication,false) THEN
    RAISE EXCEPTION 'immutable publication path required' USING ERRCODE='23514';
  END IF;
  IF OLD.actual_sha256 IS NOT NULL THEN
    IF ROW(NEW.actual_sha256,NEW.size_bytes,NEW.completed_at)
       IS DISTINCT FROM ROW(OLD.actual_sha256,OLD.size_bytes,OLD.completed_at)
       OR NEW.state='pending_upload' THEN
      RAISE EXCEPTION 'published evidence is immutable' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.actual_sha256 IS NOT NULL AND NOT coalesce(publication,false) THEN
    RAISE EXCEPTION 'checksum requires immutable publication' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_evidence_immutability() FROM PUBLIC;
CREATE TRIGGER evidence_immutable_metadata BEFORE UPDATE ON public.evidence
FOR EACH ROW EXECUTE FUNCTION public.guard_evidence_immutability();
