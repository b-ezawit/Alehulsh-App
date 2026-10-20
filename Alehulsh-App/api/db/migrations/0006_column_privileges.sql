-- 0006 — close two column-exposure defects found by the sprint 3 audit.
--
-- Both are the same mistake made twice: 0002 restricted INSERT and UPDATE to
-- specific columns, and its comments say so accurately - but it granted SELECT
-- at the TABLE level, which carries every column. Row-level security was doing
-- its job throughout (a client sees only her own row), so this was never a
-- cross-user read. It was the wrong COLUMNS of the right row.
--
-- Nothing in the application regresses: no Dart or Kotlin code connects to
-- PostgreSQL yet, so the `authenticated` role currently has no live consumer.
-- Fixing it now costs nothing and stops the exposure being inherited.

-- ===========================================================================
-- 1. users — the safety keyword hash must never reach a client.  (HIGH)
-- ===========================================================================
--
-- Verified before the fix: an ordinary `authenticated` session with her own
-- subject could run `SELECT keyword_hash FROM users` and get it.
--
-- Why that matters more than an ordinary hash leak: the safety keyword is the
-- ANTI-COERCION control. An abuser holding her unlocked phone - the device
-- compromise case in CLAUDE.md s8, not a hypothetical - could read the hash
-- out of the API and brute-force it offline at his leisure. Keywords are short
-- memorable words and the shipped default was literally 'Milo', so a few
-- seconds of wordlist is enough. With the keyword he can resolve her alert and
-- stand her responders down.
--
-- The client has no use for any of these: the keyword is verified server-side,
-- and the phone/email hashes exist only for contact matching, also server-side.
REVOKE SELECT ON users FROM authenticated;
GRANT SELECT (
    id,
    display_name,
    home_address,
    phone_e164,
    -- Needed so the UI can tell her whether verification is outstanding.
    phone_verified_at,
    -- Drives the "set your safety keyword" prompt (P1-11).
    must_set_keyword,
    created_at
) ON users TO authenticated;
-- Deliberately NOT granted: phone_hash, email_hash, keyword_hash, keyword_algo.

-- The API still needs all of it - verifying a keyword means reading its hash.
-- Stated explicitly rather than relying on 0002's grant surviving the revoke
-- above, because that revoke names only `authenticated` and a reader should not
-- have to work that out.
GRANT SELECT ON users TO alehulsh_api;

-- ===========================================================================
-- 2. emergency_contacts — a contact's account must not be exposed.  (MEDIUM)
-- ===========================================================================
--
-- contact_user_id is the internal uuid of the account a contact resolved to,
-- and linked_at says when that happened. Two problems, one row:
--
--   * It hands a client an INTERNAL uuid. The entire identity boundary exists
--     so internal ids are never client-visible or client-nameable; leaking
--     them here undoes that for exactly the ids an attacker would most want.
--   * It discloses whether a THIRD PARTY has an Alehulsh account. Her sister
--     did not consent to that being readable by whoever can reach this row,
--     and in this product "does she use the safety app" is itself sensitive.
--
-- She needs to see the contacts she entered. She does not need to be told
-- which of them the server managed to match.
REVOKE SELECT ON emergency_contacts FROM authenticated;
GRANT SELECT (
    id,
    owner_id,
    label,
    phone_e164,
    is_primary,
    created_at
) ON emergency_contacts TO authenticated;
-- Deliberately NOT granted: contact_user_id, linked_at.

GRANT SELECT ON emergency_contacts TO alehulsh_api;
