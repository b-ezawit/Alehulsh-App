-- Preserve existing owner note/urgency controls behind authenticated APIs.
-- Notes are not included in recipient projections or notification payloads.
ALTER TABLE public.alerts ADD COLUMN is_urgent boolean NOT NULL DEFAULT false,
 ADD COLUMN message text NOT NULL DEFAULT '' CHECK(length(message)<=4000);
