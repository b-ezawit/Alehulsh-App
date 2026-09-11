# Alert Lifecycle

**Task:** P1-02 · **Status:** draft for review · **Depends on:** P1-01
**Governs:** createAlert (P1-08), cancelAlert (P1-09), the escalation timer
(P3-06), TTL handling (P3-13/P3-14), and the SOS UI states (P1-16).

---

## 1. What exists today

There is no lifecycle. An alert exists or it does not.

- `alert_model.dart:57` documents `// 'active' or 'safe'`. **`'safe'` is never
  written anywhere in the codebase.**
- `alert_service.dart:314` — cancelling calls `.delete()`.
- `functions/index.js:113` — the TTL cleaner calls `batch.delete()`.

Both ways an alert can end are deletion. So:

> **An emergency leaves no record that it happened.** The alert, the location,
> and every voice note are destroyed together, by the same call, with no
> archive and no audit entry.

That is the behaviour this document replaces. It is also why cancellation is
the attack surface it is (CRIT-05) — deletion is indistinguishable from
resolution, and both are one client-side call away.

---

## 2. States

Aligned with the SRD's schema (`status IN ('active','resolved','escalated')`),
plus one terminal state the SRD does not name.

| State | Meaning | Terminal |
|---|---|---|
| `active` | Alert raised. Help is being summoned, recording is running. | no |
| `resolved` | The owner confirmed she is safe, with a verified keyword. | yes* |
| `escalated` | The safety check failed or went unanswered. Contacts notified. | no |
| `expired` | The active window elapsed without resolution **or** escalation. | yes |

\* `resolved` is terminal for this alert. A new SOS creates a new alert.

### Why `expired` exists

If the escalation machinery works, an unanswered alert becomes `escalated` at
the safety-check deadline and never reaches the end of the active window. So
`expired` should be **unreachable in normal operation**.

That makes it valuable: reaching `expired` means our own escalation did not run.
It is a system-failure signal, and it must raise an alarm to us, not be swept up
silently the way the current TTL cleaner does.

---

## 3. Transitions

```
   [no alert] ──1──▶ active ──2──▶ resolved ◀──┐
                       │ │                     │
                       │ └──3──▶ escalated ──4─┘
                       │              │
                       └──5──▶ expired ◀──5────┘
```

| # | From → To | Trigger | Who |
|---|---|---|---|
| 1 | — → `active` | SOS raised | **Owner only**, via createAlert (P1-08) |
| 2 | `active` → `resolved` | Correct keyword submitted | **Owner only**, verified server-side (P1-09) |
| 3 | `active` → `escalated` | Wrong keyword, **or** safety-check window elapsed unanswered | **Server only** |
| 4 | `escalated` → `resolved` | Correct keyword submitted late | **Owner only** |
| 5 | `active`/`escalated` → `expired` | Active window elapsed with no resolution | **Server only** — and this is a bug signal (§2) |

Transition 4 matters: **an escalated alert must remain resolvable.** She may
answer late, after she is safe. Closing that path would leave her permanently
marked as in danger with no way to correct it.

### Timings (from the SRD)

| Window | Value | Source |
|---|---|---|
| Safety check sent after | 2 minutes | *Coercion-Resistant Safety Check, Layer 2* |
| Recording maximum | 30 minutes | *Auto-Interval Evidence Recording* |
| Active window | 2 hours | current implementation |

All three are **server-side** values. Today the 2-hour expiry is stamped from
the device clock in three places, so a wrong clock breaks expiry entirely and an
alert queued offline for over two hours arrives already expired (P3-13).

---

## 4. Who may not change state

Stated explicitly because the current rules got this wrong, and because it is
the one place this document **departs from the SRD**.

The SRD's schema has `resolved_by TEXT -- 'user', 'helper', 'police', 'timeout'`,
which implies a helper or an officer can mark an alert resolved.

**Recommendation: they cannot.** Only the owner, with a verified keyword, moves
an alert to `resolved`.

The reason is the threat model. If a helper can close an alert, then an attacker
who registers as a helper can close his victim's alert — silencing the very
signal the system exists to raise. Responder verification (P4-07) does not fix
this, because the account may be genuine and the person still hostile.

What helpers and officers *can* do is recorded separately, and none of it
changes the safety status:

| Actor | May record | Changes `status`? |
|---|---|---|
| Responder | accepted, en route, arrived | no |
| Officer | dispatched, en route, arrived, case closed | no |
| Server | escalation, expiry | yes (3, 5) |
| Owner | resolution | yes (2, 4) |

`resolved_by` is kept, but its only valid values become `'owner'` and
`'owner_late'`. A `'timeout'` resolution is a contradiction — a timeout is
evidence that nobody confirmed safety, which is `escalated` or `expired`, never
`resolved`.

**This needs Meron's sign-off**, since it contradicts the SRD schema.

---

## 5. What each transition must do

Beyond writing the status. These are the side effects P1-08, P1-09 and P3-06
must implement.

| Transition | Side effects |
|---|---|
| → `active` | Stamp server timestamp · schedule the safety check (2 min) and the expiry backstop · notify contacts and responders · start recording |
| → `resolved` | Cancel pending scheduled tasks · stop recording · notify contacts that she is safe · write `resolved_at`, `resolved_by` |
| → `escalated` | Notify contacts with the escalation message · **keep recording** · keep responders engaged · write `escalated_at` and the reason |
| → `expired` | Stop recording · **raise an operational alarm** · write `expired_at` · notify nobody — the window has passed and a late notification is misleading |

Two rules hold across all of them:

1. **No transition deletes anything.** Not the alert, not the location history,
   not a single voice note.
2. **Every transition is written to the audit log** with the actor, the time and
   the reason — before the state change is acknowledged to the client.

---

## 6. Retention

State is not retention. An alert stays readable by its owner long after it is
terminal.

| Data | Retention | Source |
|---|---|---|
| Audio recordings | 90 days | SRD, *Data Retention* |
| Alert records | archive after 1 year | SRD, *Data Retention* |
| Audit log | longer than the data it describes | — |

Under Art 22(1) all of this lives in Ethiopia, and deletion must be real
deletion across every store — that is P2-20's cascade. Final numbers are
confirmed by P2-12 (retention policy) and C-09 (evidence encryption).

---

## 7. Idempotency

`createSOSAlert` currently keys the document by uid, so re-triggering merges
into the existing alert. That is the right instinct, and it should become
explicit rather than remaining a side effect of the document id:

- A second SOS while one is `active` **extends the existing alert**. It does not
  create a second one, and it does **not** reset the safety-check timer —
  resetting it would let repeated triggering postpone escalation indefinitely.
- A second SOS after `resolved` creates a **new** alert.
- A second SOS while `escalated` **re-notifies** contacts but does not create a
  new alert.
- Replaying the same client request id is a no-op that returns the original
  alert (P1-08).

---

## 8. Open for Meron

1. **§4 — only the owner can resolve.** This contradicts the SRD's
   `resolved_by` values. I recommend the deviation; it needs your decision.
2. **Active window length.** 2 hours is inherited from the current code, not
   from the SRD. Is 2 hours right, given the safety check fires at 2 minutes?
3. **`expired` alarm routing.** It signals our escalation failed. Who gets
   woken? Needs the monitoring from P2-17 to exist first.
