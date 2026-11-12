-- Separate admission from failed-attempt accounting: concurrent guesses must
-- reserve the bounded verification budget before expensive hashing starts.
ALTER TABLE public.alerts ADD COLUMN keyword_admission_count integer NOT NULL DEFAULT 0,
  ADD COLUMN keyword_admission_at timestamptz;
CREATE FUNCTION public.admit_keyword_verification(_id uuid,_key text,_cap integer,_cooldown_ms integer)
RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=public,pg_temp AS $$
DECLARE a public.alerts%ROWTYPE; t timestamptz := clock_timestamp();
BEGIN
  IF _cap < 1 OR _cooldown_ms < 1 THEN RETURN false; END IF;
  SELECT * INTO a FROM public.alerts WHERE id=_id FOR UPDATE;
  IF NOT FOUND OR a.id::text<>_key OR a.status NOT IN ('active','escalated') OR a.expires_at<=t THEN RETURN false; END IF;
  IF a.keyword_admission_at IS NULL OR a.keyword_admission_at + (_cooldown_ms * interval '1 millisecond') <= t THEN
    UPDATE public.alerts SET keyword_admission_count=1,keyword_admission_at=t WHERE id=_id;
    RETURN true;
  END IF;
  IF a.keyword_admission_count>=_cap THEN RETURN false; END IF;
  UPDATE public.alerts SET keyword_admission_count=keyword_admission_count+1 WHERE id=_id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.admit_keyword_verification(uuid,text,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admit_keyword_verification(uuid,text,integer,integer) TO alehulsh_api;
