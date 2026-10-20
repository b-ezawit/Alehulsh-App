# Alehulsh API

The trusted API layer. Owns every privileged operation — the client no longer
decides what it is allowed to do.

**Read `../docs/api-layer.md` first.** This is a portable container by design,
not a Firebase service. Nothing outside `src/auth/`, `src/repositories/` and
`src/queue/` knows Firebase exists.

```bash
npm install
npm test          # typecheck + unit tests
npm run build
docker build -t alehulsh-api .
```

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
KEYWORD_PEPPER=local-dev-only \
TASK_RUNNER_SECRET=local-dev-only \
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

## The three swap points

At C-04 the hosting decision lands and these three are reimplemented. Nothing
else changes.

| Interface | Now | After C-04 |
|---|---|---|
| `TokenVerifier` | Firebase Auth | Self-hosted IdP (M-04) |
| `AlertRepository` / `UserRepository` | Firestore | PostgreSQL + PostGIS (M-05) |
| `TaskQueue` | Cloud Tasks | Postgres-backed queue (M-07) |

`src/index.ts` is the only file that names an implementation.

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

Routes. `POST /v1/alerts` (P1-08), `/resolve` (P1-09), `/accept` (P1-10).
The repositories are proxies that throw until then.
