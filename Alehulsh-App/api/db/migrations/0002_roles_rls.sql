-- 0002_roles_rls — grants and Row Level Security.
--
-- Grants and RLS are SEPARATE controls and neither substitutes for the other:
-- a grant without a policy exposes every row; a policy without a grant denies
-- everything. Both are spelled out per table below.
--
-- Roles mirror Supabase so the policies port unchanged:
--   anon           - unauthenticated
--   authenticated  - a signed-in user, constrained by RLS
--   alehulsh_api   - the API. Deliberately NOT BYPASSRLS, so RLS remains a
--                    real control on the server path too; privileged
--                    transitions go through SECURITY DEFINER functions.
--   service_role   - break-glass/migrations only. BYPASSRLS: policies do NOT
--                    constrain it, which is exactly why the API does not use it.

DO $$ BEGIN
    CREATE ROLE anon NOLOGIN;            EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE ROLE authenticated NOLOGIN;   EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE ROLE alehulsh_api NOLOGIN;    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Supabase-compatible current-user accessor. Policies use this, so they move
-- to Supabase without edits.
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

-- Default-deny, then grant back deliberately.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated, alehulsh_api;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, alehulsh_api;

-- ===========================================================================
-- users
-- ===========================================================================
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

GRANT SELECT ON users TO authenticated, alehulsh_api;
-- Only genuinely user-editable columns. phone_hash, email_hash, keyword_hash,
-- keyword_algo, phone_verified_at and must_set_keyword are absent on purpose:
-- a client that cannot name a column cannot set it, whatever RLS says.
GRANT UPDATE (display_name, home_address, phone_e164) ON users TO authenticated;
GRANT INSERT, UPDATE, DELETE ON users TO alehulsh_api;

CREATE POLICY users_self_select ON users FOR SELECT
    TO authenticated USING (id = auth.uid());
CREATE POLICY users_self_update ON users FOR UPDATE
    TO authenticated USING (id = auth.uid()) WITH CHECK (id = auth.uid());
CREATE POLICY users_api_all ON users FOR ALL TO alehulsh_api USING (true) WITH CHECK (true);

-- ===========================================================================
-- emergency_contacts — she owns the record; she does NOT assert who someone is
-- ===========================================================================
ALTER TABLE emergency_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE emergency_contacts FORCE ROW LEVEL SECURITY;

GRANT SELECT, DELETE ON emergency_contacts TO authenticated;
GRANT INSERT (owner_id, label, phone_e164, is_primary) ON emergency_contacts TO authenticated;
GRANT UPDATE (label, phone_e164, is_primary) ON emergency_contacts TO authenticated;
-- contact_user_id and linked_at are server-set after OTP verification only.
GRANT SELECT, INSERT, UPDATE, DELETE ON emergency_contacts TO alehulsh_api;

CREATE POLICY contacts_owner ON emergency_contacts FOR ALL
    TO authenticated USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
CREATE POLICY contacts_api ON emergency_contacts FOR ALL
    TO alehulsh_api USING (true) WITH CHECK (true);

-- ===========================================================================
-- alerts — readable by the owner, written ONLY by the API.
-- No INSERT/UPDATE/DELETE grant for `authenticated` at all: every transition
-- is server-owned so timestamps, expiry and status cannot be forged.
-- ===========================================================================
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts FORCE ROW LEVEL SECURITY;

GRANT SELECT ON alerts TO authenticated;
GRANT SELECT, INSERT, UPDATE ON alerts TO alehulsh_api;

CREATE POLICY alerts_owner_read ON alerts FOR SELECT
    TO authenticated USING (owner_id = auth.uid());
-- A recipient may see the alerts she was actually sent, and only those.
CREATE POLICY alerts_recipient_read ON alerts FOR SELECT
    TO authenticated USING (
        EXISTS (SELECT 1 FROM inbox i
                WHERE i.alert_id = alerts.id AND i.recipient_id = auth.uid())
    );
CREATE POLICY alerts_api ON alerts FOR ALL TO alehulsh_api USING (true) WITH CHECK (true);

-- ===========================================================================
-- alert_history — append-only audit, readable by the owner
-- ===========================================================================
ALTER TABLE alert_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_history FORCE ROW LEVEL SECURITY;
GRANT SELECT ON alert_history TO authenticated;
GRANT SELECT, INSERT ON alert_history TO alehulsh_api;
CREATE POLICY history_owner_read ON alert_history FOR SELECT
    TO authenticated USING (owner_id = auth.uid());
CREATE POLICY history_api ON alert_history FOR ALL TO alehulsh_api USING (true) WITH CHECK (true);

-- ===========================================================================
-- inbox — read-only to its recipient. A writable inbox would let anyone
-- invent an alert, or delete one they were asked to answer.
-- ===========================================================================
ALTER TABLE inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox FORCE ROW LEVEL SECURITY;
GRANT SELECT ON inbox TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON inbox TO alehulsh_api;
CREATE POLICY inbox_recipient_read ON inbox FOR SELECT
    TO authenticated USING (recipient_id = auth.uid());
CREATE POLICY inbox_api ON inbox FOR ALL TO alehulsh_api USING (true) WITH CHECK (true);

-- ===========================================================================
-- acceptances — written through the API only; the uid comes from the token
-- ===========================================================================
ALTER TABLE acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE acceptances FORCE ROW LEVEL SECURITY;
GRANT SELECT ON acceptances TO authenticated;
GRANT SELECT, INSERT, DELETE ON acceptances TO alehulsh_api;
CREATE POLICY acceptances_self_read ON acceptances FOR SELECT
    TO authenticated USING (responder_id = auth.uid());
CREATE POLICY acceptances_api ON acceptances FOR ALL TO alehulsh_api USING (true) WITH CHECK (true);

-- ===========================================================================
-- evidence — NO client grant at all. Metadata and r2_key never reach the app;
-- every read is mediated by the API, which mints a short-lived URL.
-- Owner and responder are authorized SEPARATELY - owner-only would silently
-- deny a responder, and a single policy would over-grant one of them.
-- ===========================================================================
ALTER TABLE evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON evidence TO alehulsh_api;

CREATE POLICY evidence_owner ON evidence FOR SELECT TO alehulsh_api
    USING (owner_id = auth.uid());
-- A responder sees deliberate notes only, only for an alert she was sent AND
-- accepted, and only while that alert is live. Terminal = access ends.
CREATE POLICY evidence_responder ON evidence FOR SELECT TO alehulsh_api
    USING (
        evidence.deliberate
        AND evidence.state = 'stored'
        AND EXISTS (SELECT 1 FROM inbox i
                    WHERE i.alert_id = evidence.alert_id AND i.recipient_id = auth.uid())
        AND EXISTS (SELECT 1 FROM acceptances a
                    WHERE a.alert_id = evidence.alert_id AND a.responder_id = auth.uid())
        AND EXISTS (SELECT 1 FROM alerts al
                    WHERE al.id = evidence.alert_id AND al.status IN ('active','escalated'))
    );
CREATE POLICY evidence_api_write ON evidence FOR INSERT TO alehulsh_api WITH CHECK (true);
CREATE POLICY evidence_api_update ON evidence FOR UPDATE TO alehulsh_api USING (true) WITH CHECK (true);

-- ===========================================================================
-- Server-only tables. No grant to anon or authenticated under any condition.
-- ===========================================================================
ALTER TABLE notification_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_attempts FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON notification_attempts TO alehulsh_api;
CREATE POLICY notify_api ON notification_attempts FOR ALL TO alehulsh_api USING (true) WITH CHECK (true);

ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON outbox TO alehulsh_api;
CREATE POLICY outbox_api ON outbox FOR ALL TO alehulsh_api USING (true) WITH CHECK (true);

ALTER TABLE reveal_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE reveal_log FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON reveal_log TO alehulsh_api;   -- append-only, no UPDATE/DELETE
CREATE POLICY reveal_api ON reveal_log FOR ALL TO alehulsh_api USING (true) WITH CHECK (true);

ALTER TABLE identity_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_map FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON identity_map TO alehulsh_api;
CREATE POLICY identity_api ON identity_map FOR ALL TO alehulsh_api USING (true) WITH CHECK (true);

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO alehulsh_api;
