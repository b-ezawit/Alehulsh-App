# Development integration gates

Updated 2026-11-12. This is a development-only integration procedure. Earlier implementation batches used local synthetic fixtures. The later release-verification task authorizes read-only hosted metadata/health inspection; its actual results are reported in chat. Hosted migrations, resource creation, credential rotation, real delivery and deployment remain unapproved. Local regressions use synthetic fixtures only. See the [coordinated cutover procedure](production-cutover.md).

## Configuration inventory

Local environment setup is now available through `npm run env:init` in `api/`.
It preserves existing values, creates separate ignored mobile dev/prod JSON
files and a production-target backend file, and keeps all actual files at
mode `0600`. See [environment files](../config/README.md) for their consumers
and the offline checks. The supplied production API origin is recorded only
in local mobile configuration as an unverified candidate. Its hosted routes,
authentication and TLS have not been tested in this local-only batch.
`api/wrangler.local.jsonc` selects the appropriate local backend file and
restricts loaded secrets to runtime fields; tests using the real Wrangler
loader verify that operator credentials never become request bindings.
This manifest configures no remote bindings, schedule or production deployment.
The service-account private key pasted into chat was not installed.

`api/.dev.vars` exists, is ignored, and has mode `0600`. Secret values were not printed.
The earlier approved read-only hosted inventory reported insufficient Auth
grant/policy authority. That historical result is not current connectivity or
permission verification. Follow the
[coordinated migration and approval procedure](production-cutover.md).

| Configuration | Local result | Purpose |
| --- | --- | --- |
| `SUPABASE_PROJECT_REF`, `SUPABASE_DB_HOST`, `SUPABASE_DB_PORT`, `SUPABASE_DB_NAME`, `SUPABASE_DB_USER`, `SUPABASE_DB_PASSWORD` | Present | Operator preflight/migrations, never default request identity |
| `SUPABASE_POOLER_HOST`, `SUPABASE_POOLER_USER`, `SUPABASE_POOLER_SESSION_PORT`, `SUPABASE_POOLER_TXN_PORT` | Present | Candidate connection options; compatibility must be measured |
| `SUPABASE_AUTH_ISSUER`, `SUPABASE_AUTH_AUDIENCE` | Present | Signed access-token verification |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | Present | Operator tooling; permissions unverified; not an R2 S3 secret |
| `KEYWORD_PEPPER` | Absent | Must recover the authoritative existing value through secret management. Do not generate a replacement |
| `HYPERDRIVE` | No binding configured | Must use a restricted runtime login and verified origin TLS, query cache disabled |
| `EVIDENCE_BUCKET`, `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Endpoint/bucket present; binding and signing key pair absent | Private R2 binding for publication, narrowly scoped S3 signing keys for direct upload/playback |
| `TASK_BATCH_SIZE`, `TASK_CONCURRENCY`, `TASK_LEASE_MS`, `TASK_DISPATCH_TIMEOUT_MS`, `TASK_QUERY_TIMEOUT_MS` | Absent | Bounded scheduled task execution; values require a measured capacity/latency plan |
| Development Android Firebase app configuration | Missing | `android/app/src/dev/google-services.json`, matching the existing dev package; the development flavor needs it. The production-debug JVM suite can run locally with its existing public configuration |
| `TASK_RUNNER_SECRET` | Absent from this file | Interim Node HTTP task dispatch only; Workers scheduled execution introduces no shared HTTP secret |
| Supabase Auth migration/session checker | Locally composed and tested | Hosted migration 0022 blocked by operator authority; protected routes fail closed until integration succeeds |
| `PGSSL_CA_FILE` | Present | `.dev-certs/prod-ca-2021.crt`; earlier inventory reported successful verified TLS through the session pooler. Hosted TLS was not revalidated in this local-only batch |
| `SUPABASE_ANON_KEY` or `SUPABASE_PUBLISHABLE_KEY` | Absent | Public mobile SDK configuration; never substitute a privileged database/service credential |
| `SUPABASE_SESSION_MAX_AGE_SECONDS`, `SUPABASE_SESSION_INACTIVITY_SECONDS` | Absent | Explicit settings matching the approved Auth policy; 0 disables a limit only when explicitly configured |

Presence is not authorization to use a credential. Do not source this file into
ordinary tests, print its values, copy it into tracked configuration, or convert
its privileged database connection into the application's default login.
Supabase Auth public client configuration and native session persistence are
also required before any mobile cutover; these were not inferred from a
Cloudflare token or an administrator database password.

## Approval stage A: read-only hosted preflight

Read-only approval was supplied for development. Follow the
[cutover procedure](production-cutover.md) and recheck current metadata before
proposing changes. Approval for writes has not been supplied:

1. Connect to the exact pinned development DB host over certificate-verified TLS
   (`PGSSL_CA_FILE` or `PGSSL_CA_PEM` for its required CA). Never disable verification.
2. Inspect PostgreSQL/PostGIS versions, existing `auth.uid()`, role attributes,
   schema/table/function ownership, RLS policies and grants. Read the migration
   ledger only if it exists. Do not create a ledger during preflight.
3. Compare the applied migration inventory with local `0001` through `0035` and
   inspect schema drift. `node db/apply-remote.mjs --dry-run` is offline inventory
   only and cannot establish which files the host has applied.
4. Inspect development Auth issuer, audience, asymmetric signing-key/JWKS
   configuration, session revocation behavior and account-disable semantics.
5. Inspect existing Cloudflare development resources and token scopes only if
   that account inspection is separately approved. Reuse suitable resources.

Report exact unapplied files, checksums, destructive statements, data changes,
role grants and provider limitations before requesting write approval. Existing
comments claiming that a migration is non-destructive are not a substitute for
reviewing its actual DDL.

## Approval stage B: proposed development writes

Do not execute this stage under the current instruction. Its concrete SQL and
resource names depend on stage A and must be presented for approval first.

1. Apply only reviewed, unapplied migrations, in numeric order, each with its
   ledger row in the same transaction. Do not replay baseline migrations over
   an existing untracked schema. Check backup/restore capability first. Fail
   on incompatible ownership or schema drift; never patch Supabase-owned
   authentication functions to make a migration pass.
2. Create or configure a distinct development runtime login, without superuser,
   BYPASSRLS, role administration, database creation, or inherited privileged
   roles. Give it CONNECT and the ability to SET `alehulsh_api`; keep migration
   credentials out of Worker request execution. Supply its credential through
   secret management. Review PostgreSQL version-specific role membership SET
   options. `0012` grants the *migration caller* membership and does not by
   itself provision the separate runtime login.
3. Create synthetic test accounts and an approved identity mapping. The current
   `identity_map.firebase_uid` column is a historical name; it maps an external
   subject to one internal UUID. Its unique `user_id` currently prevents two
   concurrent provider subjects for one account. Do not infer account links
   from names, unverified email/phone, or sign-in success. Review the migration
   protocol before linking Firebase and Supabase identities.
4. Configure an approved development Hyperdrive binding to that restricted
   login, with origin TLS verification and query caching disabled. Measure
   whether direct DB or Supabase pooler is appropriate for the approved region
   and connection limits; avoid layering pooling without evidence. The mobile
   client receives neither connection credentials nor a Hyperdrive URL.
5. Configure an approved private development R2 bucket/binding and narrowly
   scoped signing credential. Review CORS for explicit development app origins
   and PUT/content-type, public access denial and residency requirements. No
   public bucket, new retention policy, or lifecycle erasure rule is implied.
6. Review migration 0022's isolated Auth reader: narrowly granted columns,
   explicit SELECT policies on provider-owned Auth tables, NOLOGIN/no
   privileged membership, and a fixed read function. The current supplied
   operator lacks Auth schema grant/policy ownership authority. Its deliberate
   precondition prevents pretending that local success establishes hosted
   compatibility. An authorized owner or a separately reviewed alternative
   access boundary is required. Connect the tested live-session bridge only
   after those gates and explicit timeout settings pass. Never silently accept signature-only
   validity. Do not give the general API broad access to `auth` tables merely
   to make a session lookup convenient.
7. Run hosted synthetic integration tests only after approval for their fixture
   DDL/data writes and cleanup. The existing Supabase identity suite creates
   test roles/tables/rows; it is **not read-only**. Its
   `ALEHULSH_SUPABASE_INTEGRATION=1` switch must remain off until then.

## Development acceptance checks

- Verify `session_user` is the restricted connection login and `current_user`
  becomes `alehulsh_api` inside each application transaction. Assert neither
  effective role is superuser/BYPASSRLS. Confirm role/claims do not survive
  COMMIT, ROLLBACK, BEGIN/COMMIT failures, connection reuse, or concurrent users.
- Apply transaction-local scalar and JSON JWT claims from the verified mapped
  subject only. Unknown users fail closed; no sparse account auto-creation.
- Test owner, other user, accepted contact/responder, anonymous and system
  contexts. Evidence and keyword resets have DB-enforced owner isolation;
  existing API policies for several other tables are intentionally broad for
  cross-user fan-out and still require repository/route authorization. Do not
  describe all tables as automatically isolated by the API role.
- Verify `anon` and `authenticated` cannot call privileged functions, mutate
  task state, change another user's keyword, or finalize another user's
  evidence. Exercise the real pooler/Hyperdrive configuration, not only a
  direct administrator connection with claims attached.
- Test create/commit-response loss/retry; failed-keyword escalation rollback;
  worker crash/lease expiry/reclaim; terminal transition racing fan-out;
  stale acceptance versus a new incident; database/network failures and retry
  backoff. Persisted intents must survive process loss. Queue completion is
  not an SMS/push/human acknowledgment.
- Test immutable publication with actual R2: overwrite staging with the original
  PUT ticket, concurrent completion, conditional create collision, interrupted
  stream and ambiguous metadata commit. Preserve a private candidate after an
  uncertain commit; do not delete potentially referenced evidence.
- Exercise revoked/expired/wrong-project tokens and disabled sessions. Auth or
  session-check failure must prevent request repository access.
- No Cron cadence is approved yet. Scheduled batch capacity and maximum lease
  duration must satisfy an agreed SOS latency budget. Backlog/abandoned-task
  logs need a tested operator response; local tests do not prove that an
  operator receives an alarm.
- After all gates pass, request separate approval for development cutover.
  Production deployment, Firebase removal, real delivery, live data migration
  and production cutover are separate actions, not consequences of this list.

## Known decisions before cutover

Audit retention/erasure and precise-location audit fields; safe account linking
and session-revocation access; notification acknowledgment/consent/delivery
policy; responder eligibility/presence collection and freshness; emergency
processing latency/capacity and operator recovery; privacy/residency approval.
See [notification review](notification-review.md) for the delivery design.


## Mobile API validation before cutover

The default remains `ALEHULSH_DATA_ACCESS=firestore` for existing installations.
An isolated API build must explicitly select `ALEHULSH_DATA_ACCESS=trusted_api`,
`FIREBASE_ENV=dev|prod`, the matching `ALEHULSH_API_ORIGIN_DEV` or
`ALEHULSH_API_ORIGIN_PROD`, and `ALEHULSH_API_AUTH=firebase|supabase`.
No hosted origin is supplied by the repository. Only an origin is accepted:
HTTPS, without user information, query, fragment or a non-root path. HTTP is
limited to loopback in a non-release development emulator build. Missing or
invalid API settings fail closed; alert operations never fall back to SDK writes.

The Firebase token adapter is transitional for the existing Node API. It cannot
be sent to the Supabase verifier. Supabase mode now composes the official GoTrue Auth SDK, origin-restricted transport, Android Keystore session storage and account-generation fencing. Profile/contact reads and supported edits use owned API routes. Release builds reject Firestore data mode and Firebase API identity. Debug compatibility builds retain the existing Firebase path. No hosted cutover is implied: existing-user linking still requires a reviewed dual-proof migration strategy; accounts are never linked by matching email, phone or name.

The configured path connects SOS enqueue/retry, own-state polling, authorized
inbox reads, incident-key-bound acknowledgment, owner acknowledgment counts, keyword updates and resolution. Counts describe in-app actions only and do not establish provider delivery or physical arrival.
A resolve HTTP acknowledgment is not cancellation confirmation: the owner state
must be read again. The Android encrypted outbox persists stable request IDs;
foreground polling retries pending work. Android now enqueues before a native trigger opens Flutter and schedules a persisted network JobScheduler job. Warm callbacks carry the same owner/request ID; expired credentials wait for the official Flutter Auth SDK. Process-death/reboot/OEM behavior still needs physical-device verification. iOS secure persistence remains unavailable. Owner note/urgency edits and response withdrawal have trusted routes for PostgreSQL and Firestore; withdrawal preserves the original acknowledgment row. Voice recordings use bounded signed PUTs and immutable finalization, with stable evidence IDs and a private local retry manifest. Unsupported reveal/erasure operations remain unavailable pending policy.

Hardware detection is debug-only and requires `HARDWARE_SOS_EXPERIMENTAL=true`.
Only non-repeated system power-key down events enter the five-press counter.
No screen or package-name heuristics or indefinite foreground service are used.
Android may reserve the power key and prevent these events reaching accessibility:
physical locked/unlocked, process-death and OEM testing is a release gate.
A successful JVM test or Android build cannot establish that gate.

Migrations 0024 and 0025 add transactional evidence admission and keyword
verification reservations. They must be reviewed before any hosted application.
All Node request/worker and Workers compositions require a dedicated restricted
runtime login. The remote migration runner now serializes operators and verifies
exact file checksums against its ledger; a historical ledger without verified
checksums requires operator review, not automatic backfilling or replay.

`npm run test:local` requires explicit loopback PostgreSQL and Firestore fixtures,
runs compiled API tests sequentially, enables local workerd checks, and fails on
unexpected integration skips. Hosted Supabase and S3 integration suites remain
explicitly separate gates. CI also declares SQL, expiry and Android unit checks;
editing that workflow does not prove a hosted CI run succeeded.


## Target client configuration

Choose `ALEHULSH_DATA_ACCESS=trusted_api`, `FIREBASE_ENV=dev|prod` and
`ALEHULSH_API_AUTH=supabase`. Supply environment-specific public build values:

- `ALEHULSH_API_ORIGIN_DEV` / `ALEHULSH_API_ORIGIN_PROD`: approved API origin.
- `ALEHULSH_SUPABASE_URL_DEV` / `ALEHULSH_SUPABASE_URL_PROD`: approved Auth origin.
- `ALEHULSH_SUPABASE_PUBLISHABLE_KEY_DEV` / `_PROD`: public Auth key only. Service-role/secret keys are rejected.
- `ALEHULSH_EVIDENCE_ORIGIN_DEV` / `_PROD`: exact approved signed-upload storage origin. Missing configuration retains recordings locally and cannot report upload success.

No production origin is supplied by source code. Release initialization refuses
missing/invalid configuration and renders an unavailable screen without sending
an alert. Native public origins use these same build definitions; they contain
no database password, service-account private key, R2 key or keyword pepper.
Email confirmation callbacks, phone verification/provider configuration and
existing-user migration must be verified against approved development settings.
A typed profile phone cannot establish ownership. Contacts may match confirmed
provider email as well as confirmed phone; conflicting identifiers are refused.

## Local migration inventory and identity boundaries

The new migrations are 0026 (API session revocation), 0027 (provider identifier
synchronization), 0028–0030 (private device/outbox delivery and RLS), 0031/0033
(response withdrawal and its narrow update grant), 0032 (owner note/urgency)
0034 (current provider contact proof), and 0035 (ordered device intents and
non-destructive provider session cleanup). They are local implementation files,
not approval to apply them remotely. Review every actual SQL file and the
operator's Auth-schema authority before any hosted migration.

A verified JWT must have an active provider session. Confirmed API logout
revokes that session for this API immediately, even while its JWT signature is
still valid; local logout and unconfirmed/offline revocation are reported
separately. Session limits are explicit server configuration, never guessed.
The restricted runtime login and transaction-local mapped identity remain
mandatory. Administrative development credentials are never request identity.
Contact selection and inbox reads recheck current provider confirmation. A
historical profile hash is insufficient. Missing contact-projection provenance
fails closed in both executable backend compositions. Existing active inboxes
need a reviewed regeneration/cutover procedure before deploying this change;
never infer their original grant or silently grandfather direct SDK access.

## Private delivery activation gate

FCM is an optional private wakeup channel, not another database/backend.
`PUSH_DELIVERY_ENABLED` is off unless explicitly set to `true`. Before activation:

1. Review the recipient consent/opt-out text; configure `PUSH_CONSENT_VERSION`
   and `PUSH_CONSENT_TEXT`. The app shows this server text and requires an
   explicit choice before device registration. OS permission alone is insufficient.
2. Supply restricted backend-only `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL` and
   `FCM_PRIVATE_KEY` through secret management. The official Google Auth SDK
   uses only the fixed Google token endpoint, and FCM uses a fixed project URL.
   Redirects are refused, SDK diagnostic interceptors are disabled and OAuth
   retries are delegated to the existing durable outbox.
3. Validate the real Wrangler bundle, private FCM routing, token refresh,
   logout, provider failures and locked/background/terminated phone behavior
   with an explicitly approved development delivery test. No such real delivery
   is authorized by the local implementation task.
4. Check lease/dead-letter monitoring, recovery ownership, provider quotas and
   failure alerts. The existing PostgreSQL outbox supplies bounded attempts,
   retry/backoff, leases and terminal reconciliation; it is not a new queue service.

Payloads carry only opaque delivery IDs: no owner UID, incident document ID,
name, contact, geohash, coordinates, note or keyword. Current account, incident,
provider proof, device generation, consent and session are checked around
processing. A provider can accept a hint concurrently with closure; the device
must fetch current authorized state and deduplicate by immutable incident.
Provider acceptance, device-reported receipt, opening, active human response
and physical arrival are separate facts. The UI must not infer any of them
from SOS persistence. Missing eligible recipients is explicit.

Legacy `functions/index.js` public topics, old client mutations and reusable
Firestore slots are not retired by this local work. Do not deploy the new API
and tighten active rules piecemeal while existing clients lack a verified API
origin. Cutover requires approved hosting, client/account migration and passing
closed-rules/device gates; only then retire public topic functions and close
legacy rules. There is no release-mobile fallback to those paths.

No SMS channel is activated. SMS acknowledgment/consent/escalation still requires
review and provider configuration. Audit retention, local evidence-copy cleanup,
responder reveal and evidence erasure remain undecided. Failed recordings stay
in private app storage; the retry manifest is Keystore-encrypted. Do not describe
all audio files as independently Keystore-encrypted, or erase them under an
invented retention period. Shared storage/backup is not used by this path.


Legacy plaintext keywords are not considered unset: the transitional API refuses
to replace them through ordinary initial keyword setup, including a concurrent
compare-and-set. Their hash adoption and legacy client cutover require review.
The trusted mobile cache scrubs legacy plaintext keyword and retired health
fields before publishing or rewriting it. This does not erase legacy Firestore
records, migrate their keyword automatically, or close direct legacy rules.

### Ordered device consent intents

Migration 0035 requires a monotonically increasing, installation/owner/device
revision on registration and disable requests. Android persists that counter in
no-backup private storage before HTTP. Foreground recovery retains explicit
pending registration and opt-out state across failure; a newer opt-out defeats
a delayed registration even when its original response was lost. Older cleanup
requests cannot disable a newer opt-in. Background notification display also
requires the current account's saved grant and no pending opt-out.

Confirmed API session revocation clears device tokens under the same provider
session lock used by registration, allowing the next account on an installation
to register its token. An unconfirmed offline logout must not be interpreted as
server revocation. Provider session deletion disables the device without deleting
its application delivery rows or receipts; no retention or erasure policy is
inferred from provider session cleanup. Physical persistence, OEM lifecycle,
and actual push delivery still require device validation.
