> Integration and release gates: see the
> [development integration procedure](../docs/development-integration.md)
> and [coordinated cutover procedure](../docs/production-cutover.md).
> Older migration completion and Workers crypto claims below are historical;
> the executable entry remains Firebase and protected Workers routes require
> approved hosted Auth grants, restricted runtime configuration and live validation before activation.

# Alehulsh API

Trusted API implementation under migration. The Flutter and native Android
clients still use Firebase directly; API authorization does not yet protect
those legacy operations.

**Read `../docs/api-layer.md` first.** This is a portable container by design,
not a Firebase service. Nothing outside `src/auth/`, `src/repositories/` and
`src/queue/` knows Firebase exists.

```bash
npm install
npm test          # typecheck + unit tests
npm run build
docker build -t alehulsh-api .
```

## Reliability and migration status (2026-10-24)

- Target remains Flutter, Workers/Hono, Supabase PostgreSQL/PostGIS, R2,
  and API-only database access. Executable composition is still Node/Fastify
  with Firebase authentication and repositories; it is not a Workers deployment.
- Firestore API alert creation and transitions commit `alert_task_outbox`
  records in the same transaction. The API recovery loop relays them to the
  PostgreSQL queue and revisits legacy direct writes using a bounded cursor.
  The relay runs only with a durable queue configured. A separate task worker
  must also run; durable records alone do not deliver anything.
- PostgreSQL migrations `0014` and `0018` and the alert repository atomically create/repair
  required tasks with the state change. Retries retain incident deadlines.
- Inbox projections carry an incident key. Firestore transactions/rules and
  PostgreSQL migration `0013` reject stale/terminal/expired sources. Terminal
  PostgreSQL transitions remove projections atomically; Firestore reads deny
  them immediately and durable retraction removes stored copies eventually.
- Existing tasks lacking an incident key cannot act on a keyed Firestore
  incident. Recovery recreates incident-bound work. Legacy timestamps are
  adopted once from Firestore's server update time; no claim is made about
  when the device originally triggered an offline emergency.
- Legacy mobile writes are **not atomic with backend work**. Recovery closes
  the crash gap after observation, but needs a running API and queue worker.
  Owner direct writes and local keyword cancellation remain a cutover blocker.
- No hosted migration or rules deployment has been performed by these changes.

Database request code must use `createApiDatabase`/`withApiTransaction`, which
sets the restricted role and transaction-local identity before application
queries. The raw pool is for explicit administration and connection lifecycle.
Migration `0015` scopes evidence edits to the owner. Most other API policies
still require repository/route resource authorization; they are not per-user
isolation policies.

`node db/apply-remote.mjs --dry-run` is an offline inventory: no credentials,
connection, or ledger writes. Applied hosted migration state remains unknown.
Remote PostgreSQL TLS always verifies the server certificate. Supply
`PGSSL_CA_PEM` when the server's
chain requires an additional trusted CA; do not disable verification.

Supplied development credentials are in ignored `api/.dev.vars`, permissions
0600. The runtime does not automatically source this file or translate
`SUPABASE_*` into `PG*`. Never use an owner credential as an unrestricted
application database handle, and never source secrets into test commands.

## Configuration

Every variable below is **required**; `loadConfig()` refuses to start without
one rather than failing later as a 500 during an emergency. Nothing here has a
default, and nothing here is logged.

| Variable | Purpose |
|---|---|
| `FIREBASE_PROJECT_ID` | Interim, Firebase-era. Removed at C-04. |
| `STORAGE_BUCKET` | Bucket holding evidence recordings. |
| `KEYWORD_PEPPER` | Server-side secret mixed into keyword hashing. Rotating it invalidates every stored hash — treat it as permanent. |
| `TASK_RUNNER_SECRET` | Shared secret the task runner presents. Not a user credential. |

Optional, with defaults: `PORT`, `LOG_LEVEL`, `ACTIVE_WINDOW_MS`,
`SAFETY_CHECK_DELAY_MS`, `KEYWORD_ATTEMPT_CAP`, `KEYWORD_ATTEMPT_COOLDOWN_MS`,
`MAX_VOUCHES_PER_RESPONDER`, `REVEAL_RADIUS_M`, `REVEAL_ATTEMPT_CAP`,
`REVEAL_ATTEMPT_WINDOW_MS`, `ALERT_CREATE_CAP`, `ALERT_CREATE_WINDOW_MS`.

## Running against local emulators

Never develop against the live project: it holds real users' alerts, locations
and contacts. Point both the API and the app at the Firestore emulator instead.

```bash
# terminal 1 — emulators, from the repo's Alehulsh-App/ directory
firebase emulators:start --only firestore,auth --project alehulsh-local

# terminal 2 — the API against those emulators
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
FIREBASE_PROJECT_ID=alehulsh-local \
STORAGE_BUCKET=alehulsh-local.appspot.com \
KEYWORD_PEPPER="${LOCAL_TEST_KEYWORD_PEPPER:?Set an isolated emulator-only value}" \
TASK_RUNNER_SECRET="${LOCAL_TEST_TASK_SECRET:?Set an isolated emulator-only value}" \
npm start
```

The Flutter app has a matching compile-time switch (`lib/dev_config.dart`),
off by default and compiled out of release builds:

```bash
flutter run --dart-define=USE_FIREBASE_EMULATORS=true
```

In development the task queue is in-memory, so **scheduled tasks do not fire** —
the safety check and expiry backstop will not run. The process logs a warning
saying so at startup.

## The swap points

The hosting decision has landed: **Cloudflare Workers + Supabase + R2.** These
interfaces are reimplemented against it; nothing else changes.

| Interface | Now | Target |
|---|---|---|
| `TokenVerifier` | Firebase Auth | **Supabase Auth**, with migration/privacy review and live revocation checks |
| `AlertRepository` / `UserRepository` | Firestore | **Supabase** PostgreSQL + PostGIS (M-05) |
| `TaskQueue` | PostgreSQL queue + Node worker; Firestore durable relay | Bounded Workers execution of durable work |
| `EvidenceStore` | Firebase Storage | **Cloudflare R2** (M-06) |

**The HTTP migration is incomplete.** The existing executable API uses Fastify
on Node. A separate Hono Fetch entry now exists under `src/workers/`; it does
not bridge requests through Fastify or its runtime schema compiler. The remaining
routes must be ported with their existing authorization and validation preserved.
Runtime crypto measurements in `MIGRATION-COMPAT.md` are historical claims;
CPU and memory need target-runtime validation before activation.

`src/index.ts` composes the current Firebase-backed API; `src/workers/index.ts`
is a separate, inactive migration entry.

## What is deliberately here

- **`logger.ts`** — redacts by key name, recursively. The audit found the safety
  keyword being printed to logcat in cleartext. Nothing reaches a log line
  without passing through `redact()`.
- **`errors.ts`** — the client receives a code and a message we wrote, never a
  driver error. `forbidden` and `not_found` return identical bodies so a caller
  cannot probe which alert ids exist.
- **`config.ts`** — validated at startup. `LOG_LEVEL=debug` is refused in
  production.

## What is not here yet

Full Workers/Hono composition, remaining PostgreSQL adapters, replacement identity
provisioning/cutover, push wakeup and acknowledgment, provider SMS escalation
delivery, durable mobile outbox/read cache, retention and hosted validation.
The alert, resolve, accept, evidence, inbox and recovery routes already exist.

## Workers migration scope and activation gates

`src/workers/app.ts` provides real Hono handlers for `/healthz`,
`GET /v1/me/inbox` and `GET /v1/me/alert`. The protected read handlers preserve
recipient/owner scoping and return bounded projections. No emergency write
endpoint is activated in this entry; the mobile application remains unchanged.

Supabase JWT signature verification uses JOSE with HTTPS issuer, audience,
expiry, user UUID, session UUID and authenticated-user checks. Only ES256 and
RS256 public signing keys are accepted; project signing secrets and service-role
tokens are not request identities. JWT verification does **not** establish live
session validity: Supabase documents the signed `session_id` and its relation to
the Auth session record in its [session documentation](https://supabase.com/docs/guides/auth/sessions).

The default Worker therefore returns **503** for protected reads until an
independently validated live session/revocation adapter is injected. It never
falls back to trusting an otherwise valid JWT. Authenticated data access also
requires `SUPABASE_AUTH_ISSUER`, `SUPABASE_AUTH_AUDIENCE` and `HYPERDRIVE`.
No Supabase administrative connection string is used as a fallback. The
Hyperdrive-backed request executes inside an `alehulsh_api` transaction with
the verified subject mapped to the internal UUID, and local claims cleared when
the transaction ends. Identity provisioning remains a cutover prerequisite.

Hyperdrive origin TLS/certificate settings and disabled query caching for
sensitive/live-state queries require explicit deployment validation. The
[Cloudflare driver guide](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/node-postgres/)
and [TLS configuration reference](https://developers.cloudflare.com/hyperdrive/configuration/tls-ssl-certificates-for-hyperdrive/)
describe the separate Hyperdrive connection responsibilities; no Hyperdrive
resource has been created or changed here.

`test/workers.test.ts` has 35 local tests covering JWT tampering, issuer/audience
and session claims, revocation failure gates, recipient scoping, query validation,
minimal own-alert responses and missing configuration. Tests use generated
synthetic signing keys and injected dependencies; they contact no provider. The
Worker module also bundles locally without Fastify or Firebase Admin. An actual
local `workerd` HTTP smoke check remains unexecuted because loopback-listener
permission was denied. These checks do not establish hosted compatibility or
production readiness.

## Inbox privacy during the transition

Projection reads require a live, unexpired source incident and its immutable
`alertKey`; an ended incident or a reused Firestore owner slot grants no access
to an older exact-location copy. Firestore rules permit a guarded single-document
get but deny direct inbox collection listing: rules cannot prove the source
check for an unconstrained query. `GET /v1/me/inbox` performs those checks in
the API instead. No current mobile inbox consumer is switched by this change.

PostgreSQL migration `0013` serializes inbox writes with terminal transitions
and deletes copies in the closing transaction. Firestore cleanup is durable
asynchronous work; read guards apply immediately while cleanup is pending.
The interim Firebase expiry function now excludes terminal backlog, paginates
and rechecks each incident transactionally, writing its cleanup intent alongside
closure. Local tests do not establish deployed rule/index state or delivery.


## Remaining migration boundaries

Supabase Auth and provider SMS on unacknowledged contact alerts were selected on
2026-10-25. A live session/revocation adapter, account provisioning/cutover, SMS
provider and credentials, acknowledgment timing and recipient/message policy
remain activation gates. No messages were sent during local development.

PostgreSQL acceptance, evidence, client-policy and latest-version adapters now
exist in addition to alerts/users/contacts/inbox. Evidence finalization requires
trusted object SHA-256 inspection; no digest is fabricated to satisfy the
schema. The adapter is not activated: immutable publication must also prevent a
still-valid upload URL from changing bytes after finalization.

The keyword-recovery confirm flow still spans multiple repositories and needs
an atomic alert/reset/hash transaction before porting. Location-reveal audit
fields and deletion conflict with the existing append-only schema and pending
retention decision; neither new precise-coordinate fields nor audit deletion
privileges were added. Responder eligibility/location persistence remains
unfinished. Local repository parity does not establish a complete cutover.

The legacy Firestore bridge adopts the source document's server update time
when a client supplied no server creation time. A retrigger or recording update
may precede that first observation; this is not proof of original trigger time.
Its bounded recovery scan must be measured under load before promising a
trigger-to-escalation deadline. Legacy direct writes remain a cutover blocker.


## Historical reliability-stage validation (2026-10-25; superseded below)

| Check | Executed result |
|---|---|
| API unit suites, direct test-file execution | 596 passed, 0 failed/skipped |
| API integration suites on isolated PostgreSQL/PostGIS and Firestore | 490 passed, 2 existing TODOs, 0 failed/skipped |
| Firestore security rules | 43 passed |
| Firebase expiry reconciliation | 10 passed |
| TypeScript, JavaScript syntax, whitespace | passed |
| Workers bundle | built offline; runtime HTTP smoke not run (listener permission declined) |

The integration count combines the full sequential run and successful reruns
of the corrected restricted-role assertion and final Firestore cases. No
Supabase-hosted or real-R2 signature test was run. Hosted Supabase tests also
require explicit `ALEHULSH_SUPABASE_INTEGRATION=1`; credentials alone do not
enable them. Flutter/Android builds were
not run; this work does not switch their backend.

Phase 1 files include the alert repositories, `services/alertWork.ts`,
`queue/FirestoreAlertWork.ts`, `queue/FirestoreAlertRecovery.ts`, alert/resolve/
task routes, incident keys, inbox repositories and fan-out, Firestore rules,
Firebase expiry reconciliation, and migrations 0013/0014/0018/0019. Failed
keywords now commit attempt counts, escalation and required work atomically.
Responder evidence reads use wall-clock expiry even in an older transaction.

Phase 2 files include `db/pool.ts`, `db/apply-remote.mjs`, migration 0015 and
identity/TLS/transaction tests. BEGIN/COMMIT errors discard the connection;
scoped handles are invalidated before release. A deferred COMMIT failure was
verified against the local database. Query/lock/idle-transaction deadlines and
Hyperdrive cache/TLS settings still need deployment validation.

Phase 3 files include `src/workers/`, `queue/runTaskBatch.ts`,
`PostgresAcceptanceRepository`, `PostgresEvidenceRepository`,
`PostgresClientPolicyRepository`, `PostgresVersionTelemetryRepository`,
`R2EvidenceStore`, worker lane settlement, migrations 0016/0017 and matching
tests. This is a partial migration, with the activation gates above remaining.

Supplied secrets remain ignored in `api/.dev.vars` with permissions 0600;
derived `SUPABASE_AUTH_ISSUER` and `SUPABASE_AUTH_AUDIENCE` were added there.
No owner database credential was copied into default runtime `PG*` settings.
Still missing: the existing keyword pepper, task-runner secret, restricted
runtime database/Hyperdrive configuration, R2 bucket/endpoint/S3 signing
credentials, and a selected SMS provider with its sender/credentials. The live
Supabase session checker and immutable evidence publication are implementation
gates, not credentials. No cloud resources, hosted migrations or messages were
created by this work. All changes remain uncommitted.

## Local continuation validation — 2026-10-25

These are assertion-level counts from running each compiled test file directly,
not counts of test files. The inventory is at
`/tmp/alehulsh-api-validation.json` for the full run and
`/tmp/alehulsh-stage-validation.json` for the final targeted reruns in this workspace session. No `.dev.vars`
credentials were loaded. API integration used synthetic PostgreSQL on loopback
port 55439 and Firestore emulator port 18080; workerd/R2 used ephemeral local
fixtures. Migrations through 0023 were validated locally; all 23 were also applied on a fresh throwaway local database. Hosted inventory and Auth authority blockers are documented separately.

| Check | Pass | Fail | Skip | TODO |
| --- | ---: | ---: | ---: | ---: |
| API unit/HTTP suites | 647 | 0 | 0 | 0 |
| API integration suites (575 cases) | 548 | 0 | 27 | 0 |
| Offline preflight safeguards | 5 | 0 | 0 | 0 |
| Firestore current rules | 43 | 0 | 0 | 0 |
| Firestore target closed rules | 9 | 0 | 0 | 0 |
| Firebase Storage denial rules | 11 | 0 | 0 | 0 |
| Firebase expiry reconciliation | 10 | 0 | 0 | 0 |
| Flutter | 122 | 0 | 0 | 0 |
| Kotlin pure JVM suites | 52 | 0 | 0 | 0 |

Both SQL regression files (`alert_outbox_test.sql`, `rls_denial_test.sql`) passed
with `psql -X -v ON_ERROR_STOP=1` against the same synthetic local fixture.
TypeScript build/typecheck, analysis of the new Dart client/tests and
`git diff --check` passed. New Android migration sources compiled against the
installed Android SDK and Flutter embedding using the cached Kotlin compiler.
The ordinary `:app:testDevDebugUnitTest` Gradle task remains blocked by missing
development `google-services.json`; it did not run JVM test cases through the
full Android build. No replacement configuration was generated.

The 27 skips are 11 hosted Supabase identity checks (explicit opt-in disabled)
and 16 S3-compatible integration cases (local service absent). The four real
workerd/native R2 tests are included in the passing integration cases.
The two prior composition TODOs now pass with an authoritative identifier
source. Cross-provider linking remains a migration gate. Supabase identifier synchronization and current-provider proof now have local implementations; their hosted installation and real-provider validation remain gates. Final counts combine the full suite with the targeted
RLS bridge rerun (11 replacing 10) and one new migration-authority regression,
without double-counting reruns. A fresh emulator booted; no UI flows were tested.

Commands exercised included `npm run build` / `tsc --noEmit`, direct
`node dist/test/<suite>.test.js` per compiled suite,
`ALEHULSH_WORKER_RUNTIME_TESTS=1 node dist/test/workersRuntime.integration.test.js`,
`node functions/test/expiryReconciliation.test.js` from the app directory,
local current/closed/storage rules suites, `flutter test --no-pub --reporter expanded`,
and `flutter analyze --no-pub lib/api test/migration_api_client_test.dart`.
The local PostgreSQL/Firestore variables must identify synthetic loopback
fixtures; never source hosted credentials to reproduce these local results.

The compatible dependency patch pass removed the audited runtime high advisory
and fixed Fastify/URI advisories. `npm audit --omit=dev` still reports eight
moderate findings in the Firebase dependency chain, with several fixes requiring
an SDK major upgrade. This is not an all-clear security verdict.

For changed components, unresolved security/product decisions, actual cloud
validation and mobile cutover gates, see
[development integration checklist](../docs/development-integration.md) and
[notification review](../docs/notification-review.md).


## Trusted mobile and private delivery composition

The target Worker composes Supabase Auth session checks, API-scoped logout,
owned profile/contact routes, keyword recovery, SOS/inbox/response controls,
owner note/urgency updates and immutable evidence finalization. Flutter uses
the official GoTrue Auth client without a direct database SDK, and Android
uses Keystore session storage plus the shared durable SOS outbox. Release
mobile builds refuse legacy Firestore mode and missing target configuration.
This is source-level containment, not a deployed migration of existing clients.

Private FCM is opt-in server configuration. The official Google Auth SDK is
restricted to the Google token endpoint; token acquisition and message transport
use bounded requests and refuse redirects. The existing PostgreSQL outbox
stores idempotent device-generation-bound intents and keeps provider acceptance,
device-reported receipt and opening separate from a human response. Local
workerd checks build through Wrangler's real compatibility bundler; generic
esbuild alone omitted CJS built-in shims needed by this SDK.

Use the [development integration procedure](../docs/development-integration.md)
for exact public build definitions, backend-only secret names, the current
0001–0035 SQL inventory and external gates. No hosted origin, keyword pepper,
FCM/R2 credential, consent policy or audit/evidence-erasure policy is invented
by these modules. No real notifications or hosted migrations are part of the
local regression gate. Legacy public-topic functions and direct-client rules
require coordinated, approved cutover; do not deploy individual pieces as an
API-only production claim.
