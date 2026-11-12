-- Existing application policy and latest-version telemetry contracts.
-- No client grants; publishing an upgrade floor is an administrative action.
CREATE TABLE public.client_policy (
  platform text PRIMARY KEY CHECK (platform IN ('android','ios')),
  min_version text,
  latest_version text
);
CREATE TABLE public.client_versions (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('android','ios')),
  version text NOT NULL CHECK (length(version) BETWEEN 1 AND 64),
  last_seen_at timestamptz NOT NULL
);
ALTER TABLE public.client_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_policy FORCE ROW LEVEL SECURITY;
ALTER TABLE public.client_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_versions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.client_policy, public.client_versions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.client_policy TO alehulsh_api;
CREATE POLICY client_policy_api_read ON public.client_policy FOR SELECT TO alehulsh_api USING (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.client_versions TO alehulsh_api;
CREATE POLICY client_versions_owner ON public.client_versions TO alehulsh_api
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- Operators receive aggregate adoption counts, not a per-account activity feed.
CREATE FUNCTION public.client_version_distribution()
RETURNS TABLE(version text, count text) LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT v.version, count(*)::text FROM public.client_versions v GROUP BY v.version
$$;
REVOKE ALL ON FUNCTION public.client_version_distribution() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.client_version_distribution() TO alehulsh_api;
