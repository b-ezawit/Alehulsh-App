-- Existing 72-hour recovery policy, serialized with alert insertion via the
-- owner's row lock (the alerts FK also holds a conflicting owner lock).
CREATE TABLE public.keyword_resets (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  requested_at timestamptz NOT NULL,
  eligible_at timestamptz NOT NULL,
  status text NOT NULL CHECK(status IN ('pending','confirmed','cancelled','voided_by_alert')),
  cancelled_at timestamptz,
  cancelled_reason text CHECK(cancelled_reason IN ('user','alert_raised')),
  CHECK(eligible_at >= requested_at + interval '72 hours')
);
ALTER TABLE public.keyword_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.keyword_resets FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.keyword_resets FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE ON public.keyword_resets TO alehulsh_api;
CREATE POLICY keyword_resets_owner ON public.keyword_resets TO alehulsh_api
  USING(user_id=auth.uid()) WITH CHECK(user_id=auth.uid());

CREATE FUNCTION public.keyword_owner(p_subject text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE owner uuid;
BEGIN
  owner := public.resolve_identity(p_subject);
  IF owner IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'owner context required' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.users WHERE id=owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'identity unavailable' USING ERRCODE='AL001'; END IF;
  RETURN owner;
END $$;
REVOKE ALL ON FUNCTION public.keyword_owner(text) FROM PUBLIC;

CREATE FUNCTION public.request_keyword_reset(p_subject text,p_at timestamptz)
RETURNS SETOF public.keyword_resets LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE owner uuid;
BEGIN
  owner := public.keyword_owner(p_subject);
  IF EXISTS(SELECT 1 FROM public.alerts WHERE owner_id=owner AND status IN ('active','escalated')) THEN
    RAISE EXCEPTION 'live incident' USING ERRCODE='AL002';
  END IF;
  INSERT INTO public.keyword_resets(user_id,requested_at,eligible_at,status)
    VALUES(owner,p_at,p_at+interval '72 hours','pending')
    ON CONFLICT(user_id) DO UPDATE SET requested_at=EXCLUDED.requested_at,
      eligible_at=EXCLUDED.eligible_at,status='pending',cancelled_at=NULL,cancelled_reason=NULL
    WHERE keyword_resets.status<>'pending';
  RETURN QUERY SELECT * FROM public.keyword_resets WHERE user_id=owner;
END $$;

CREATE FUNCTION public.confirm_keyword_reset(p_subject text,p_requested timestamptz,p_hash text,p_now timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE owner uuid; pending public.keyword_resets;
BEGIN
  owner := public.keyword_owner(p_subject);
  IF EXISTS(SELECT 1 FROM public.alerts WHERE owner_id=owner AND status IN ('active','escalated')) THEN
    RAISE EXCEPTION 'live incident' USING ERRCODE='AL002';
  END IF;
  SELECT * INTO pending FROM public.keyword_resets WHERE user_id=owner FOR UPDATE;
  IF NOT FOUND OR pending.status<>'pending' THEN RAISE EXCEPTION 'no pending reset' USING ERRCODE='AL003'; END IF;
  IF pending.requested_at<>p_requested OR pending.eligible_at>p_now OR coalesce(length(p_hash),0)=0 THEN
    RAISE EXCEPTION 'reset changed or not eligible' USING ERRCODE='AL002';
  END IF;
  UPDATE public.users SET keyword_hash=p_hash,must_set_keyword=false WHERE id=owner;
  UPDATE public.keyword_resets SET status='confirmed' WHERE user_id=owner;
END $$;

CREATE FUNCTION public.cancel_keyword_reset(p_subject text,p_status text,p_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE owner uuid;
BEGIN
  owner := public.keyword_owner(p_subject);
  IF p_status NOT IN ('cancelled','voided_by_alert') THEN RAISE EXCEPTION 'invalid transition' USING ERRCODE='AL002'; END IF;
  UPDATE public.keyword_resets SET status=p_status,cancelled_at=p_at,
    cancelled_reason=CASE WHEN p_status='cancelled' THEN 'user' ELSE 'alert_raised' END
    WHERE user_id=owner AND status='pending';
END $$;

CREATE FUNCTION public.change_safety_keyword(p_subject text,p_expected text,p_hash text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE owner uuid;
BEGIN
  owner := public.keyword_owner(p_subject);
  IF EXISTS(SELECT 1 FROM public.alerts WHERE owner_id=owner AND status IN ('active','escalated'))
     OR coalesce(length(p_hash),0)=0
     OR (SELECT keyword_hash FROM public.users WHERE id=owner) IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'incident or keyword changed' USING ERRCODE='AL002';
  END IF;
  UPDATE public.users SET keyword_hash=p_hash,must_set_keyword=false WHERE id=owner;
END $$;

CREATE FUNCTION public.void_reset_on_incident() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  UPDATE public.keyword_resets SET status='voided_by_alert',cancelled_at=now(),cancelled_reason='alert_raised'
    WHERE user_id=NEW.owner_id AND status='pending';
  RETURN NEW;
END $$;
CREATE TRIGGER alerts_void_pending_reset AFTER INSERT ON public.alerts
FOR EACH ROW EXECUTE FUNCTION public.void_reset_on_incident();

REVOKE ALL ON FUNCTION public.request_keyword_reset(text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.confirm_keyword_reset(text,timestamptz,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_keyword_reset(text,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.change_safety_keyword(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.void_reset_on_incident() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_keyword_reset(text,timestamptz) TO alehulsh_api;
GRANT EXECUTE ON FUNCTION public.confirm_keyword_reset(text,timestamptz,text,timestamptz) TO alehulsh_api;
GRANT EXECUTE ON FUNCTION public.cancel_keyword_reset(text,text,timestamptz) TO alehulsh_api;
GRANT EXECUTE ON FUNCTION public.change_safety_keyword(text,text,text) TO alehulsh_api;
