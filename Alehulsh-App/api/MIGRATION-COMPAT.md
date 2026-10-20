# Migration compatibility report — Workers/Hono and Supabase Auth

Status: **audit of the current tree. Nothing deployed, no hosted service contacted.**
All findings below come from reading this repository, not from running on Cloudflare.

## 1. Cloudflare Workers runtime

Workers run V8 isolates, not Node. Current API surface: 47 TypeScript files,
~1,435 lines of routes, 13 of them importing Fastify.

### Blocking

| Issue | Occurrences | Detail |
|---|---|---|
| **`scrypt`** | 13 | `node:crypto` scrypt is **not** in Workers' WebCrypto. This is the safety-keyword KDF, so it blocks `routes/keyword.ts`, `routes/keywordReset.ts`, `routes/resolve.ts` |
| **Fastify** | 13 files | Not Workers-compatible. Hono is the near-equivalent; routing and schema validation must be re-expressed |
| **`firebase-admin`** | 10 files | Node SDK; replaced by the Postgres repositories (this sprint laid the schema for them) |

### Portable with small changes

| Primitive | Occurrences | Workers equivalent |
|---|---|---|
| `createHmac` | 4 | WebCrypto `HMAC` via `crypto.subtle` |
| `randomBytes` / `randomUUID` | 6 | `crypto.getRandomValues` / `crypto.randomUUID` |
| `timingSafeEqual` | 7 | **Do not hand-roll.** Use a maintained constant-time comparison |

### Reusable unchanged

- The 24 repository interfaces in `src/repositories/types.ts` — storage-agnostic by design
- `services/AlertFanout`, `ContactMatcher`, `ResponderRegistry`, `DataExporter`
- `geo.ts`, `geoFuzz.ts`, `staleness.ts`, `version.ts`, `errors.ts`
- The `TaskQueue` interface shape

### Queue semantics

`TaskQueue.cancel(key)` exists because a safety check must stop the moment she
resolves. **Cloudflare Queues cannot cancel.** Correctness therefore comes from
the consumer re-reading alert state before acting, which `transition_alert`
already supports by abandoning pending outbox rows on any terminal transition
(tested). Cancellation is advisory; the re-read is authoritative.

### Delivery guarantee

**At-least-once, not exactly-once.** If a consumer calls FCM, FCM accepts, and
the consumer crashes before recording `sent`, the retry sends again and the
device receives a duplicate. The side effect is external and cannot join the
database transaction. Mitigations: device-side dedupe on `(alertId, attemptNo)`,
a collapse key, and bounded `max_attempts` (schema default 5).

## 2. Supabase Auth

### Unverified assumptions — must be proven in an isolated dev project

| Assumption | Risk if wrong |
|---|---|
| `auth.admin.createUser({ id })` accepts an explicit id | Whole uid-preservation plan fails |
| **Firebase uids are 28-char strings, not uuids** | They cannot be reused as `uuid` primary keys at all |

The schema does **not** bet on either. `users.id` is an internal `uuid`, and
`identity_map(firebase_uid → user_id)` carries the mapping. If uid preservation
turns out to be impossible, nothing in the schema changes.

### Known constraints

- Firebase password hashes are not transferable in a form Supabase accepts →
  forced reset at cutover
- `auth.uid()` is reproduced locally reading `request.jwt.claim.sub`, so the
  policies written this sprint port to Supabase unedited

## 3. Database role behaviour — verified locally

Tested against the local container, not assumed:

- `service_role` has `rolbypassrls = true`, but **BYPASSRLS does not bypass
  table GRANTs.** Without a grant it was refused outright. Supabase ships broad
  grants to `service_role`, which is why it *appears* unrestricted — the bypass
  is only half the story.
- `alehulsh_api` has `rolbypassrls = false` on purpose, so RLS remains a live
  control on the server path.
- **Caveat, stated plainly:** the `*_api` policies use `USING (true)`, so for
  most tables RLS does **not** constrain the API role — the real controls are
  the absence of client grants plus application logic. `evidence` is the
  exception: its owner and responder policies are scoped by `auth.uid()` and
  were verified to filter (owner 1 row, accepted responder 1 row, stranger 0).

## 4. Keyword hashing decision

Unresolved pending one external check: **is `pgsodium` (Argon2id via
`crypto_pwhash`) available on the target Supabase project?** Supabase has been
deprecating it.

- If yes → Argon2id in the database; the pepper never leaves the server.
- If no → PBKDF2-HMAC-SHA256 at 600k iterations via WebCrypto. Weaker (not
  memory-hard) but the only option with no unverified dependency.

**No hashing code was changed this sprint.** The existing scrypt path remains
live and untouched; `users.keyword_algo` exists so a migration can be staged.
