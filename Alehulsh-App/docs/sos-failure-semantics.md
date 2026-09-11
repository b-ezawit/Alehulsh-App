# SOS Failure Semantics

**Task:** P1-06 · **Status:** draft for review · **Depends on:** P1-02
**Governs:** the SOS UI states (P1-16), the dialler fallback (P1-20), native
failure listeners (P1-19), the offline queue (P3-15/M-02), and contact
escalation (P3-04).

---

## 1. What exists today

`emergency_screen.dart`:

```
setState(() { _isSOSSent = true; ... });   // line ~205 — BEFORE the write
try {
  ... createSOSAlert(...) ...
} catch (e) {
  debugPrint("[EmergencyScreen] Error in _triggerSOS: $e");   // and nothing else
}
```

The active state is entered before anything is attempted, and every failure is
swallowed into a debug log. Permission denied, quota exhausted, oversized
document, expired session, no network — all five produce the same screen:
**an SOS that looks sent.**

The native path is worse. `AlehulshSosDispatcher.kt:133-203` chains three
Firestore calls using only `addOnSuccessListener`, with **no failure listener at
any stage**. If the profile read fails, the chain simply stops. No alert is
written and nothing is reported.

And where the app does speak, it overstates:

> "Your alert has been sent. Help is on the way."
> "SOS alert is queued locally and will broadcast the millisecond connection is
> restored!"

The first is a claim about other people's behaviour that we cannot know. The
second is a promise about delivery we do not verify.

> A user who believes a false confirmation stops looking for other help. This is
> the most dangerous failure a safety app can have, and it is the current
> default behaviour.

---

## 2. The principle

> **Never claim more than we know. Say what actually happened, at the tier it
> actually happened.**

Three consequences:

- Optimistic UI is banned on the SOS path. State follows acknowledgement.
- "Help is on the way" is never displayed unless a human has actually accepted.
- Every tier reports its own real guarantee, not the one above it.

---

## 3. States

Replaces the boolean `_isSOSSent`.

| State | Meaning | Screen |
|---|---|---|
| `sending` | Request issued, no acknowledgement yet | Progress. No claim of success |
| `queued` | No connectivity; durably stored on device | "Saved on your phone. Will send when you have signal." + fallback offered |
| `confirmed` | **Server acknowledged the write** | "Alert recorded." Then live delivery status |
| `failed` | Request rejected, or timed out with no durable queue entry | Loud. Retry + dialler fallback |

`confirmed` is the only state that means an alert exists, and it is reached only
on a server acknowledgement — never on a local write, never on a timer.

A `sending` state that has not resolved within a few seconds is shown as still
sending, not quietly upgraded. Silence is not success.

---

## 4. The delivery ladder

Each tier has a different guarantee. The UI must not borrow a stronger one.

| Tier | Channel | Real guarantee | What she is told |
|---|---|---|---|
| 0 | Server acknowledges the alert | **Strong.** The only thing that means an alert exists | "Alert recorded" |
| 1 | Push to responders | **Best effort.** Doze, disabled notifications, battery optimisers and revoked tokens all fail silently | Nothing until someone *accepts* |
| 2 | In-app alert to emergency contacts | Delivered when their device is reachable; acknowledgement is explicit (P3-03) | "2 contacts reached" — only on a real acknowledgement |
| 3 | Escalation on non-response | Durable, scheduled, retried (P3-06) | Nothing — by design invisible to a coercer (P1-03) |
| 4 | Dialler and device SMS | **Strongest available.** Works with no data connection | "Couldn't reach the network — tap to call 991" |

Tier 1 is the one most likely to be misrepresented. A push that was *sent* is
not a push that was *received*, and a push that was received is not a person who
is coming. **Responder counts shown to the user must come from acceptances, not
from sends.**

---

## 5. Tier 4 is what makes honesty affordable

Without a fallback, admitting failure means telling a frightened person "this
didn't work" and offering nothing. That is why the temptation to fake success
exists at all.

With Tier 4, the honest message is also an actionable one. So `failed` must
always present:

- A one-tap call to emergency services (P3-08, numbers verified in P3-07).
- A pre-filled SMS to her primary contact with whatever location we have.
- A retry.

All three must work with no data connection, which means they cannot depend on
anything we have written. This is why P1-20 is on the critical path and not a
nice-to-have.

---

## 6. Offline

Current behaviour relies on Firestore's implicit queue while telling her it will
send "the millisecond connection is restored" — a promise it does not verify.
There is also a DNS lookup against `example.com` on every SOS: an external
dependency inside the critical path, blocking up to 1.5 seconds.

Required instead:

- The SOS is written to a **durable local queue before any network call**
  (M-02). Disk first, network second.
- `queued` is a real, visible state showing when it was saved and that it has
  not yet sent.
- On send, the screen updates to `confirmed` with the real dispatch time.
- The connectivity probe is removed. Attempt the write; let it fail.
- Tier 4 is offered immediately in `queued`, not after a timeout — if she has no
  data, she may still have voice.

Note the P1-02 interaction: expiry must be stamped **server-side**. An alert
queued offline for over two hours currently arrives already expired and is
deleted (P3-13).

---

## 7. Silent failures to close

| Location | Failure | Fix |
|---|---|---|
| `emergency_screen.dart:~296` | `catch { debugPrint }` on the whole trigger | P1-16 |
| `AlehulshSosDispatcher.kt:133-203` | Three chained calls, no failure listener | P1-19 |
| `alert_service.dart:275-284` | `addVoiceNote` swallows failures — evidence silently lost | P2-10 |
| `alert_service.dart:232-248` | Duplicate cleanup swallows failures | acceptable, note only |
| `functions/index.js` | Broadcast failure logged, never surfaced | P3-04 |

`alert_service.dart:275-284` deserves attention: combined with the ~90-second
base64 ceiling, a user can record what she believes is evidence, see it appear
in the UI, and have none of it saved.

---

## 8. Open for Meron

1. **Wording of the `confirmed` state.** "Alert recorded" is accurate but cold
   for someone frightened. It needs to reassure without promising rescue.
   Worth writing in Amharic first and translating back (P4-15).
2. **Does `queued` offer Tier 4 immediately, or after a delay?** Immediately is
   safer; it may also read as the app admitting defeat too early.
3. **Retry limits on `failed`.** Unlimited retry against a down backend is a
   retry storm; too few feels like abandonment.
