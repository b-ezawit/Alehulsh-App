-- Serialize evidence admissions with one incident row lock. The count is in a
-- separate volatile PL/pgSQL statement so READ COMMITTED sees the prior lock
-- holder's commit. A count in the INSERT's original snapshot is insufficient.
CREATE FUNCTION public.guard_evidence_admission() RETURNS trigger
LANGUAGE plpgsql VOLATILE SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.alerts WHERE id=NEW.alert_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.evidence WHERE id=NEW.id) THEN RETURN NEW; END IF;
  IF (SELECT count(*) FROM public.evidence WHERE alert_id=NEW.alert_id) >= 20 THEN
    RAISE EXCEPTION 'evidence admission limit reached' USING ERRCODE='P0020';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_evidence_admission() FROM PUBLIC;
CREATE TRIGGER evidence_admission BEFORE INSERT ON public.evidence
FOR EACH ROW EXECUTE FUNCTION public.guard_evidence_admission();
