# The Trusted API Layer

**Tasks:** P1-07 · P1-08 · P1-09 · P1-10 — **rescoped**
**Decision owner:** Claude, delegated by Meron. Reversible; say so if you disagree.

---

## The problem with the original scope

P1-07 through P1-10 were written as **Firebase Cloud Functions**. Under the
Art 22(1) migration that is throwaway work: Cloud Functions do not run outside
Google Cloud, and Google Cloud has no Ethiopian region.

We cannot simply wait for C-04 either. The API layer is what fixes server-side
keyword verification (CRIT-05), rate limiting, and proximity authorization —
none of which Firestore rules can express. Those are urgent.

---

## Decision

> **Build it as a portable containerised HTTP service. Decide the deploy target
> at deploy time, not at build time.**

- **Language:** TypeScript. The team already ships JavaScript, and the existing
  `functions/` code is JS.
- **Framework:** Fastify. Its built-in JSON-schema validation directly serves
  the input-validation requirement in CLAUDE.md §16; Express is an acceptable
  substitute if preferred.
- **Packaging:** a Dockerfile. Nothing in the code knows where it runs.
- **Deploy target:** open. Cloud Run if we need it live before C-04 lands;
  otherwise straight to the in-country host. **This is the point of the
  decision — it stops blocking on C-04 without betting on Firebase.**

---

## What makes it portable

Everything Firebase-specific sits behind three interfaces. At C-04 we write new
implementations and change nothing else.

| Interface | Firebase now | In-country later |
|---|---|---|
| `TokenVerifier` | Firebase Auth admin SDK | Self-hosted IdP (M-04) |
| `AlertRepository` / `UserRepository` | Firestore admin SDK | PostgreSQL + PostGIS (M-05) |
| `TaskQueue` | Cloud Tasks | Postgres-backed queue (M-07) |

Everything else — routing, validation, the alert state machine (P1-02), keyword
verification and escalation (P1-03), rate limiting, audit logging — is plain
TypeScript with no cloud dependency. That is the great majority of the work, and
none of it is rewritten.

FCM stays on both sides of the migration, so push needs no interface.

---

## What changes in the tasks

| Task | Was | Now |
|---|---|---|
| P1-07 | Scaffold Cloud Functions | Scaffold the containerised service + the three interfaces above |
| P1-08 | `createAlert` callable | `POST /v1/alerts` |
| P1-09 | `cancelAlert` callable | `POST /v1/alerts/:id/resolve` |
| P1-10 | `acceptAlert` callable | `POST /v1/alerts/:id/accept` |

The Flutter client calls HTTPS endpoints rather than the Firebase callable SDK.
Marginally more client code, and it removes a Firebase dependency from the app
that would otherwise have to be unpicked later.

M-01 (repository abstraction, Beza) is the client-side mirror of this and stays
as scoped.

---

## What this does not change

The existing `functions/index.js` triggers — `onAlertCreated`,
`onAlertDeleted`, `cleanupExpiredAlerts` — stay as Cloud Functions for now. They
are event-driven off Firestore writes and have no equivalent until the data
moves. They are small, and they die with Firestore rather than being migrated.

---

## Why not wait for C-04

The urgent P1 fixes need somewhere to run. Deferring the whole API layer until
the hosting decision lands would leave the client-side keyword check (CRIT-05)
in place for weeks. Building portable now costs a few interfaces and buys the
ability to ship safety fixes immediately.
