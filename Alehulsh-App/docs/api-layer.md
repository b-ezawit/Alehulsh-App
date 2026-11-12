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

> **Build it as a portable HTTP service behind narrow interfaces. Decide the
> deploy target at deploy time, not at build time.**

**The deploy target has since been decided: Cloudflare Workers + Supabase.**
See "Target architecture" below. The portability this document argues for is
what makes that migration a rewrite of the HTTP layer rather than of the
system — but note that Fastify itself does NOT port to Workers.

- **Language:** TypeScript. The team already ships JavaScript, and the existing
  `functions/` code is JS.
- **Framework:** Fastify. Its built-in JSON-schema validation directly serves
  the input-validation requirement in CLAUDE.md §16; Express is an acceptable
  substitute if preferred.
- **Packaging:** a Dockerfile. Nothing in the code knows where it runs.
  Superseded for the API: Workers are isolates, not containers.
- **Deploy target:** **DECIDED — Cloudflare Workers.** Fastify must be
  re-expressed in Hono; see `api/MIGRATION-COMPAT.md`.

---

## Target architecture (decided)

```
Flutter / Dart  ──HTTPS──►  Cloudflare Workers (Hono)
                                 │
                                 ├──►  Hyperdrive  ──►  Supabase PostgreSQL 16 + PostGIS
                                 ├──►  Cloudflare R2          (evidence files)
                                 └──►  FCM (wakeup ping only, no personal data)

Cloudflare Cron Trigger ──► Worker ──► task_queue in PostgreSQL

The mobile client holds NO database credentials. API-only access.
```

### Migration status

| Component | State |
|---|---|
| PostgreSQL schema, roles, RLS, 11 migrations | Tested on a local container. **Never run against Supabase.** |
| `PostgresAlertRepository` | Tested locally. 1 of 10 repositories. |
| Durable task queue, worker, abandoned-task ledger, overdue probe | Tested locally, **Node-only runtime** |
| HTTP layer | Fastify. **Not ported.** 14 files import it. |
| `EvidenceStore` / `TokenVerifier` interfaces | Implemented; target implementations not started |
| Anything deployed | **Nothing.** |

### Why Fastify does not simply move

Workers are V8 isolates with no `node:http`. Hono is the near-equivalent and
keeps JSON-schema validation, which is why Fastify was chosen in the first
place. What ports unchanged: the 24 repository interfaces, `AlertFanout`,
`ContactMatcher`, `ResponderRegistry`, `DataExporter`, `geo`, `geoFuzz`,
`staleness`, `errors`, the domain modules, and the `TaskQueue` shape. The
rewrite is the transport, not the system.

`node:crypto` **scrypt** — the safety-keyword KDF — is also absent from
Workers. `users.keyword_algo` exists so a replacement can be staged without a
flag day. See `api/MIGRATION-COMPAT.md`.

### Connectivity: why the transaction boundary matters

Hyperdrive pools in **transaction mode** and resets the connection after each
transaction, so a session-level `SET` does not survive. `SET LOCAL
request.jwt.claim.sub` inside an explicit `BEGIN`/`COMMIT` does — which is
exactly the shape `withTransaction` (`src/db/pool.ts`) already uses. The
transaction-local identity plan is therefore compatible as designed; it is
simply **not plumbed yet**.

### Background work: the queue stays in PostgreSQL

Cloudflare Queues is available even on the free plan, and is still the wrong
tool here: **Queues cannot cancel**, and `TaskQueue.cancel(key)` exists because
a safety check must stop the moment she resolves. The existing `task_queue`
already provides leases, bounded retries, idempotency, cancellation, the
abandoned-task ledger and the overdue probe. A Cron Trigger driving
`claim_tasks` preserves all of it with no new infrastructure.

**Open timing question:** cron granularity is 1 minute, against the worker's
current 2-second poll. A 2-minute safety check would fire between 2:00 and
3:00 — up to 60 s of extra latency on an escalation. Product decision.

### Deployment limitations to plan around

| Constraint | Value |
|---|---|
| Workers CPU per invocation | 10 ms free / 5 min paid. **I/O wait does not count**, so a claim-and-dispatch worker fits |
| Workers subrequests per invocation | **50 free** / 10,000 paid — a wide contact fan-out can approach this |
| Simultaneous outgoing connections | 6 (both plans). `TaskWorker` concurrency defaults to 4 |
| Cron Triggers per account | 5 free / 250 paid |
| Supabase Free: **projects pause after 1 week idle** | A paused database means no SOS escalation. **Not safe for production** |
| Supabase Free: backups | **None.** Pro (from $25/mo) adds 7-day daily backups and removes pausing |
| Supabase Free: size / storage / egress | 500 MB / 1 GB / 5 GB, shared CPU, **no uptime SLA** |

Supabase is the agreed provider; the **tier** is a separate, open cost decision.

### Data residency — deferred, and not claimed

Residency is to be settled at deployment with stakeholders. Documented so it is
not forgotten, and **no compliance claim is made anywhere in this repository**:

- Supabase has **no African region**. Nearest listed: Frankfurt
  `eu-central-1`, Mumbai `ap-south-1`.
- Workers execute at the global edge, so request data transits widely.
- R2 offers jurisdictional location hints (e.g. EU) but no Ethiopian
  jurisdiction.
- Proclamation 1321/2024 Art 2(5) makes audio recordings and in-app messages
  **sensitive**; Art 22(3) requires prior Authority approval to move sensitive
  data abroad.

As specified, evidence audio and in-app messages would be stored outside
Ethiopia. That needs Authority approval, a residency carve-out for evidence, or
acceptance as a recorded risk.

### Unresolved decisions

1. **scrypt replacement** for Workers — cryptographic, affects the
   anti-coercion control.
2. **Authentication provider** — Supabase Auth fits the existing RLS claims,
   but is a third party holding phone numbers.
3. **Supabase tier** for production.
4. **Safety-check latency** under 1-minute cron granularity.
5. **Residency**, as above.

---

## What makes it portable

Everything Firebase-specific sits behind three interfaces. At C-04 we write new
implementations and change nothing else.

| Interface | Firebase now | Target |
|---|---|---|
| `TokenVerifier` | Firebase Auth admin SDK | **Not yet chosen** (M-04) — see below |
| `AlertRepository` / `UserRepository` | Firestore admin SDK | **Supabase** PostgreSQL + PostGIS (M-05) |
| `TaskQueue` | Cloud Tasks | Postgres-backed queue — **implemented** (M-07), driven by a Cloudflare Cron Trigger |
| `EvidenceStore` | Firebase Storage | **Cloudflare R2** (M-06) |

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
