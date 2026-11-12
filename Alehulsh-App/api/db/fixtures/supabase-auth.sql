-- SYNTHETIC LOCAL CONTAINER ONLY. Never part of hosted migration inventory.
-- Minimal provider-owned columns used by the bridge; not a Supabase Auth server.
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY, encrypted_password text, email text, email_confirmed_at timestamptz,
  phone text, phone_confirmed_at timestamptz, banned_until timestamptz,
  deleted_at timestamptz, is_anonymous boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS auth.sessions (
  id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),refreshed_at timestamp,
  not_after timestamptz
);
REVOKE ALL ON auth.users,auth.sessions FROM PUBLIC;

-- Match hosted Auth RLS; column grants alone must not bypass it.
ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.sessions ENABLE ROW LEVEL SECURITY;
