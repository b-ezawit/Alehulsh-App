-- Operational response state; preserve the original acknowledgment record.
-- Does not erase incidents/evidence or define an audit retention policy.
ALTER TABLE public.acceptances ADD COLUMN withdrawn_at timestamptz;
