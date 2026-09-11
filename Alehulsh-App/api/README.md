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
FIREBASE_PROJECT_ID=... npm start
docker build -t alehulsh-api .
```

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
