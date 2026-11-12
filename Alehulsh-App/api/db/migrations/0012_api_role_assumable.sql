-- 0012 — let the connecting role BECOME alehulsh_api per transaction.
--
-- This is the answer to the credential question that has gated the whole
-- migration (api-only-migration-plan.md 0.1): `alehulsh_api` is NOLOGIN, so
-- "how does the API connect as it?" looked like it needed a password in secret
-- storage, or LOGIN on the role.
--
-- It needs neither. The API connects with the project's own credential and
-- then DOWNGRADES itself:
--
--     BEGIN;
--       SET LOCAL ROLE alehulsh_api;
--       SELECT set_config('request.jwt.claim.sub', <subject>, true);
--       ... the request's queries ...
--     COMMIT;
--
-- Inside that transaction current_user is alehulsh_api with rolsuper = false
-- and rolbypassrls = false, so RLS and the column grants are live controls
-- rather than decoration. On COMMIT the role reverts. Measured against a real
-- Supabase project (PostgreSQL 17.11), not assumed.
--
-- WHY A GRANT IS NEEDED AT ALL. PostgreSQL 16 split role membership into
-- separate INHERIT, SET and ADMIN options. `pg_has_role(..., 'MEMBER')`
-- already returned true, but `SET ROLE alehulsh_api` was refused with
-- "permission denied to set role" because the SET option was absent. On the
-- local container `postgres` is a superuser and can SET ROLE regardless, which
-- is exactly why this gap was invisible until it was run on Supabase, where
-- `postgres` is NOT a superuser.
--
-- THIS DOES NOT WEAKEN ANYTHING. The grantee is the role that already owns
-- every object in the schema and therefore already holds strictly more
-- privilege than alehulsh_api. What it adds is the ability to give privilege
-- UP, voluntarily, for the length of one transaction. It creates no new login,
-- no password, and nothing the mobile client can reach.
--
-- It also pairs with Hyperdrive, which pools in transaction mode and resets
-- the connection after each transaction: both the role downgrade and the JWT
-- claim are transaction-scoped, so neither can leak to whoever gets the
-- connection next. Verified: a claim set with SET LOCAL is gone after COMMIT
-- and after ROLLBACK, and a second transaction on the same connection starts
-- with auth.uid() = NULL.

DO $$
BEGIN
    -- WITH SET TRUE is PostgreSQL 16+. Both the local container (16.4) and
    -- Supabase (17.11) are past that; the guard keeps the file loadable on an
    -- older server rather than failing with a syntax error at parse time.
    IF current_setting('server_version_num')::int >= 160000 THEN
        EXECUTE 'GRANT alehulsh_api TO CURRENT_USER WITH SET TRUE';
    ELSE
        EXECUTE 'GRANT alehulsh_api TO CURRENT_USER';
    END IF;
EXCEPTION
    -- Already granted, or the connecting role is a superuser that does not
    -- need it. Either way there is nothing to do and nothing is wrong.
    WHEN duplicate_object OR insufficient_privilege THEN NULL;
END $$;
