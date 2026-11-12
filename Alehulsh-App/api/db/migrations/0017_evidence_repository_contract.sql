-- Preserve the existing upload integrity gate. No checksum constraint is
-- removed or relaxed to make the API's size-only finalize contract fit.
ALTER TABLE public.evidence ADD COLUMN duration_ms bigint
    CHECK (duration_ms IS NULL OR duration_ms >= 0);

-- Account erasure is owner-scoped, including for accepted responders.
GRANT DELETE ON public.evidence TO alehulsh_api;
CREATE POLICY evidence_owner_delete ON public.evidence FOR DELETE TO alehulsh_api
    USING (owner_id = auth.uid());
