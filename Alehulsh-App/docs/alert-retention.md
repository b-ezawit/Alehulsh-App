# Alert retention and expiry

**Status:** decided (P3-14). Supersedes the TTL approach that task originally proposed.

---

## 1. What was there

Two mechanisms, both of which hard-deleted alerts:

- `cleanupExpiredAlerts` ran every fifteen minutes and called `batch.delete()`
  on every alert whose `expiresAtTimestamp` had passed — **regardless of
  status**;
- a native TTL policy on the same field, declared in `firestore.indexes.json`,
  which tells Firestore to delete those documents itself.

So two hours after an SOS was raised, the alert was destroyed. An escalated
alert, an alert carrying a cluster of failed keyword attempts, one a survivor
might need for a protection order — all of it, on a timer.

This is CRIT-05 again. That finding was that *cancelling* deleted the alert and
its evidence; this deleted the same things without anyone touching a button.

## 2. Why the original task was wrong

P3-14 said to let native TTL do the deletion and reduce the function to a
reconciliation net. Its two premises do not hold:

**"The backlog grows unbounded."** It cannot. `active_alerts` is keyed by the
owner's uid, so it holds at most one document per user. The 200-per-run limit
was never the constraint it appeared to be.

**"Let TTL do the deletion."** Deletion is the problem, not the throughput.
Handing the job to Firestore would have made it faster and unthrottled.

## 3. Decided

**Expiry is a state transition. Deletion is not how an alert ends.**

- The TTL policy is removed from `firestore.indexes.json`.
- `cleanupExpiredAlerts` transitions `active` and `escalated` alerts to
  `expired` and leaves terminal ones alone.
- Reaching it is a **bug signal**, logged at error. `alert-lifecycle.md` §2:
  an alert that expires while still open is evidence that escalation never ran.

## 4. The consequence that needed handling

Responders see a high-priority notification for a live emergency. It used to be
dismissed by `onAlertDeleted`, which fired when the document went away.

Once alerts stop being deleted, that trigger stops firing — so `onAlertClosed`
was added, on the status transition instead.

This was **already broken before this change**: P1-09 resolves by transition,
not deletion, so resolving through the API left the notification standing on
every responder's phone. Nobody would have seen it until responders started
arriving at emergencies that were already over.

`onAlertDeleted` stays only because `alert_service.dart` still deletes on
cancel. It should be removed with P1-08.5.

## 5. Still open

**How long does an alert live?** This decides that it is not two hours, and
not by deletion. It does not decide the real retention period — that is P2-12,
which is gated on Meron, and it has to answer a question no schedule can:
a survivor may need this evidence years later, and holding it is itself a risk
if the account is ever compromised.

Until P2-12 lands, alerts persist. Bounded by user count, so the cost of
waiting for a considered answer is close to nothing.
