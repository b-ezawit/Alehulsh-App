# Responder Projection

**Task:** P2-04 · **Status:** draft for review · **Depends on:** P1-01, P2-01
**Governs:** the fan-out writer (P2-05), the client read path (P2-06), staged
location reveal (P2-08), and the accept endpoint (P1-10).

---

## 1. The problem this solves

Firestore rules cannot express "only if you are near this alert". That is not a
gap in our rules — it is a property of the rule language, and it is why
`allow read: if isAuthenticated()` was the only thing that made responder
discovery work at all. Every responder could read every alert: exact GPS, the
victim's phone, and every emergency contact's number (CRIT-02).

Containment switched discovery off rather than narrowing it, because there was
no safe partial version.

The fix is to stop asking the database an unanswerable question. Instead of
"can this reader see that alert?", a server writes a per-responder copy and the
database is only ever asked **"is this your own inbox?"** — which rules and RLS
both express trivially.

---

## 2. What a responder receives

```
inbox/{responderUid}/alerts/{alertId}
  alertId          opaque
  displayName      derived from fullName — a first name or initial, not the full one
  fuzzedLat        centre of the alert's precision-7 geohash cell
  fuzzedLng
  fuzzedPrecision  "~150m"
  isUrgent
  createdAt
  status           active | escalated
  hasVoiceNote     boolean, not the note itself
```

And what it must never contain:

| Excluded | Why |
|---|---|
| exact coordinates | Released only under §4 |
| `alerterPhone`, `alerterEmail` | The audit found these in every alert document |
| emergency contact names, phones, emails | Third-party data, no consent for this (P2-23) |
| `fullName` | A first name identifies her to a neighbour without identifying her to a stranger |
| the voice note itself | P1-01 §4 — a responder hears the deliberate voice note only after accepting, fetched separately and logged |
| medical data | No responder needs it, and it is Art 2(5) sensitive |

---

## 3. Fuzzing must be deterministic

The obvious implementation — add a random offset within 200m — **is wrong, and
dangerously so.**

If the projection is ever regenerated, or written to two responders, each copy
carries an independent random offset. Two samples halve the error; ten samples
put you within metres. A responder who can prompt a re-fan-out can average his
way to her exact position, and the fuzzing that was supposed to protect her
becomes a slow leak.

So: **snap, do not jitter.** Truncate the alert's geohash to precision 7 and
report the centre of that cell. Precision 7 is roughly 153 m × 153 m, so the
true position is within about 108 m of the reported point. The same alert always
produces the same fuzzed point, for every responder, forever. Sampling gains
nothing.

One consequence worth stating plainly: a cell boundary can put two people who
are 10 m apart into different cells, and someone 140 m away into the same one.
That is inherent to grid snapping and is an acceptable cost — the alternative
leaks.

---

## 4. Staged reveal, and an honest account of what it buys

P1-01 §4: a responder receives exact coordinates only after she accepts **and**
her own position is within 50 m.

The mechanics:

1. Responder accepts (P1-10). `accepted_at` is recorded.
2. Responder reports her position to the server.
3. The **server** computes the distance to the true location and decides.
   Her self-reported position is an input to that decision, never the decision.
4. Release is written to the audit log before the coordinates are returned.

**What this does not do.** Her reported position is unverified, so a determined
responder can claim positions until one lands within 50 m of the true point.
Since the fuzzed cell already narrows the search to ~150 m, that is a small
number of guesses.

Staged reveal is therefore a speed bump, not a boundary. It is still worth
building — it makes casual snooping cost something and leaves an audit trail —
but the load-bearing protections are the other three:

- only responders the server **selected** receive anything at all;
- every precise-location release is **logged and attributable**;
- access **ends when the alert does**, not when the responder loses interest.

Overstating this layer would be worse than not having it, because it would let
us stop thinking about the other three.

---

## 5. Fan-out shape (for P2-05)

Write, do not query. A responder's client reads only
`inbox/{ownUid}/alerts/*`, so the rule is an ownership check and nothing else.

- Cost is alerts × selected responders, not alerts × every listening device.
  The audit measured the current global-listener design at roughly 330 M reads
  per day at 100 K users (SCALE-02); this is about 33 K.
- **Idempotent on (alertId, responderUid)** — a re-run must not duplicate.
- Inbox entries are removed when the alert reaches a terminal state, so a
  responder's inbox is never a history of other people's emergencies.
- Status changes update existing entries rather than appending.

**Who gets selected — DECIDED (P4-07): peer vouching with shared
accountability.** ID verification moves to phase 2; it needs reviewers we do
not have.

A prospective responder must be vouched for by an existing one. Both are named
on the vouch, and if the vouched-for person causes harm, **both accounts are
actioned**. Accountability rather than verification — the voucher is staking
something real, which is what a self-declared gender field never did.

This replaces "check the gender they entered". A dropdown gives a predator a
box to tick; a vouch gives him a person who has to be willing to answer for him.

### What the mechanism needs to work

Not objections — the parts that make it hold up.

1. **The chain is recorded and traceable.** Every account carries who vouched
   for it. Without that, "both in trouble" has nobody to point at.
2. **Removal cascades.** If a voucher is removed for cause, everyone they
   vouched for is at minimum flagged for re-vouching. Otherwise one bad actor
   admits a chain and leaves it behind.
3. **Vouches are capped per person.** Uncapped, a single account can grow an
   arbitrary network, and the accountability thins to nothing.
4. **Someone bootstraps.** The first responders have no one to vouch for them,
   so Meron designates them explicitly — a named starting set, not whoever
   signs up first.
5. **"Both in trouble" needs a real consequence.** Realistically that is
   suspension of both accounts. Legal liability is unlikely to be enforceable
   and should not be implied to users.
6. **Declining must be easy.** A woman asked to vouch for someone she is unsure
   about should be able to say no without it being visible to him.

### Still true regardless

The responder network stays small at launch, which makes the contact channel
(P3-01) the one carrying the weight. And until vouching is implemented, the
fan-out predicate returns nobody — a policy without an implementation selects
no one safely.

---

## 6. Open for Meron

1. **`displayName` — first name, or initial only?** A first name helps a genuine
   responder ("Meron needs help" reads as a person). An initial reveals less to
   someone collecting names. I lean first name; it is the difference between a
   neighbour and a record.
2. **Precision 7 (~150 m)** against the SRD's stated 200 m. Close, and
   deterministic, which the SRD's phrasing is not. Confirm the trade.
3. **P4-07 still gates P2-05.** The projection can be built now; selection
   cannot.
