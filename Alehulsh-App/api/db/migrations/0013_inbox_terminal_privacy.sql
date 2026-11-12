-- Serialize projection writes with alert closure and remove exact-coordinate
-- copies in the SAME transaction as a terminal transition. The lock order is
-- alert -> inbox, shared by inserts and terminal updates.
CREATE OR REPLACE FUNCTION public.guard_live_inbox_projection()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE current_status public.alert_status;
        current_expiry timestamptz;
BEGIN
    SELECT a.status, a.expires_at INTO current_status, current_expiry
      FROM public.alerts a WHERE a.id = NEW.alert_id FOR UPDATE;
    IF NOT FOUND OR current_status NOT IN ('active', 'escalated')
       OR current_expiry <= clock_timestamp() THEN
        RETURN NULL;
    END IF;
    -- PostgreSQL incident IDs are immutable, unlike Firestore owner slots.
    IF NEW.projection ? 'alertKey'
       AND NEW.projection->>'alertKey' IS DISTINCT FROM NEW.alert_id::text THEN
        RETURN NULL;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER inbox_live_incident_guard
BEFORE INSERT OR UPDATE ON public.inbox
FOR EACH ROW EXECUTE FUNCTION public.guard_live_inbox_projection();

CREATE OR REPLACE FUNCTION public.retract_terminal_inbox()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
    IF NEW.status IN ('resolved', 'cancelled', 'expired') THEN
        DELETE FROM public.inbox WHERE alert_id = NEW.id;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER alerts_retract_terminal_inbox
AFTER UPDATE OF status ON public.alerts
FOR EACH ROW EXECUTE FUNCTION public.retract_terminal_inbox();

-- Remove already-stale copies when this migration is deliberately applied.
DELETE FROM public.inbox i USING public.alerts a
 WHERE i.alert_id = a.id
   AND (a.status IN ('resolved','cancelled','expired') OR a.expires_at <= now());

REVOKE ALL ON FUNCTION public.guard_live_inbox_projection() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.retract_terminal_inbox() FROM PUBLIC;
