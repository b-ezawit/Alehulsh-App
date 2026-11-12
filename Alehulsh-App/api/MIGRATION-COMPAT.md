> Integration and release gates: see the
> [development integration procedure](../docs/development-integration.md)
> and [coordinated cutover procedure](../docs/production-cutover.md).
> Older migration completion and Workers crypto claims below are historical;
> the executable entry remains Firebase and protected Workers routes require
> approved hosted Auth grants, restricted runtime configuration and live validation before activation.

# Migration compatibility report — Workers/Hono and Supabase Auth

Status: **audit of the current tree, plus section 1a measured in the real runtime.**
Nothing is deployed and no Cloudflare *account* has been contacted - but 1a was
measured by running `workerd` locally via `wrangler dev`, which needs no account.
Everything else below still comes from reading this repository.

## 1. Cloudflare Workers runtime

Workers run V8 isolates, not Node. Current API surface: 47 TypeScript files,
~1,435 lines of routes, 13 of them importing Fastify.

### Blocking

| Issue | Files | Detail |
|---|---|---|
| **Fastify** | 14 | Not Workers-compatible - V8 isolates have no `node:http`. Hono is the near-equivalent; routing and schema validation must be re-expressed. Other composition and execution gaps remain; see section 4. |
| **`firebase-admin`** | 13 | Node SDK; replaced by the Postgres repositories (the schema for them exists) |

## 1a. node:crypto - CORRECTED, and measured

**An earlier revision of this document listed `scrypt` as blocking. That was
wrong.** It was written from an older account of the Workers runtime. Cloudflare
now supports the full `node:crypto` API under the `nodejs_compat` flag, and this
was verified by running the real runtime locally - `wrangler dev`, which starts
`workerd` and needs no Cloudflare account.

Measured in `workerd` 1.20261019 with `compatibility_flags = ["nodejs_compat"]`:

| Probe | Result |
|---|---|
| `node:crypto` import | ok |
| **`scrypt` at the real parameters** (N=65536, r=8, p=1, dkLen=32) | **works, 301 ms**, digest `caa3555f0cce6caf...` |
| `createHmac('sha256').digest('base64url')` | ok |
| `randomBytes`, `randomUUID`, `timingSafeEqual` | ok |
| `crypto.subtle.timingSafeEqual` | present (non-standard Workers extension) |
| `@noble/hashes` scrypt, same parameters | works, 539 ms, **identical digest** |

**Consequences.** `src/crypto/keyword.ts` needs no change to run on Workers, and
nor do `identifier.ts`, `taskAuth.ts`, `routes/resolve.ts`, `routes/evidence.ts`
or `FirestoreAlertRepository`'s `randomUUID`. No cryptographic decision is
required and no algorithm is being substituted - which was the real risk, since
the candidate replacements (PBKDF2, or Argon2id via a Postgres extension
Supabase has been deprecating) were both weaker or less certain than the scrypt
already in place.

`src/crypto/keywordPortable.ts` exists and is proven byte-identical in both Node
and `workerd`, with interchangeability tested in both directions. On this
evidence it is **NOT required**. It is retained as a verified fallback should
`nodejs_compat` scrypt ever become unavailable, and is wired into nothing.
Deleting it is a reasonable call.

**What this does NOT solve: CPU.** 301 ms is CPU time, and Workers allow 10 ms
per invocation on the free plan against 30 s (default) on paid. **The keyword
path therefore requires Workers Paid** - measured, not estimated. A plan
decision, not a cryptographic one.

### Reusable unchanged

- **All of `src/crypto/`** - see 1a
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

## 4. Current decisions and verification limits

The existing scrypt algorithm remains unchanged. The old proposal below this
section to choose Argon2id/PBKDF2 was inconsistent with section 1a and is
superseded. Runtime measurements above were recorded by previous work and
were not reproduced by the current reliability changes.

A narrow Hono Fetch entrypoint now implements health, own-alert and inbox reads.
The default live-session bridge is now locally composed; hosted Auth grants, restricted runtime login and explicit policy configuration remain fail-closed activation gates.
The complete API migration is unfinished. Remaining issues include:
Firebase composition, request identity, bounded durable task execution,
operational monitoring and mobile/native cutover also need validation.

The transitional Firestore outbox/relay is retirement work, not a second
permanent database. PostgreSQL stores emergency work transactionally after
migration. A future Cloudflare queue must have an explicit responsibility
relative to `task_queue` and `outbox`; do not duplicate delivery authority.

Supabase Auth with migration/privacy review and provider SMS to selected contacts
after non-acknowledgment are now selected. Provider procurement, delivery/acknowledgment
policy and audit retention remain unresolved. No hosted service was modified during the reliability work.
