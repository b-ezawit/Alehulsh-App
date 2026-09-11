# Coercion Resistance and Escalation

**Task:** P1-03 · **Status:** draft for review · **Depends on:** P1-02
**Governs:** cancelAlert (P1-09), the escalation timer (P3-06), notification
privacy (P1-05), contact alerts (P3-03/P3-04), and the safety-check redesign
(P4-01).

---

## 1. What exists today

The SRD specifies five layers of coercion resistance. **All five are inverted in
the current build.**

| SRD layer | Current implementation |
|---|---|
| 1. No on-screen resolve button | `emergency_screen.dart:776` — a visible cancel button |
| 2. Keyword hashed, never in the database | Plaintext in a world-readable field, default `'Milo'` |
| 3. Discreet UI, no mention of emergency | Dialog titled **"Security SOS Cancel"**, body "To cancel emergency broadcast, answer your security verification question", buttons "Confirm & Cancel SOS" / "Keep SOS Active" |
| 4. Escalate without alerting the abuser | **No escalation exists.** A wrong answer shows red text: "Incorrect security code. Verification failed!" |
| 5. Evidence preserved | Cancelling deletes the alert and every recording |

The single worst line is layer 4. A coercer standing over her shoulder is shown,
in red, that the check failed — which tells him the keyword was wrong, that he
should make her try again, and that a mechanism exists to defeat him.

---

## 2. Adversary model

The threat this is designed against is specific and it is not a remote attacker:

> A person physically present, who can see the screen, can compel her to touch
> it, and may know the app exists.

He can: watch every pixel, force any tap, take the phone, and retry.
He cannot: know the keyword, and — if this is built correctly — tell the
difference between success and failure.

**The design goal is not to stop him cancelling. It is to make the outcome of
his coercion unobservable to him.**

---

## 3. The safety check

| Property | Value | Source |
|---|---|---|
| Fires at | 2 minutes after the alert | SRD, Layer 2 |
| Timer authority | **Server** (scheduled task, P3-06) | — |
| Appearance | Ordinary notification, not an alert | SRD, Layer 3 |
| Title | Neutral — "Quick question" | SRD, Layer 3 |
| Colours | Normal app surface. No red, no warning iconography | SRD, Layer 3 |
| Forbidden words | emergency, safety, SOS, police, alert, cancel, verify, security | SRD, Layer 3 |
| Countdown | Shown as an indeterminate loading indicator, never a countdown | SRD, Layer 3 |

The question itself must be **chosen by the user during onboarding**, alongside
the keyword. The SRD's "How's your cat doing? 🐱" works only for someone with a
cat; the current build's "What is your pet's name?" reads as an interrogation.
A question she wrote is plausible in a way a generic one never is.

**There is no on-screen resolve button** (SRD Layer 1). Between the trigger and
the 2-minute check she cannot cancel. That is deliberate — an always-available
cancel is an always-available coercion target. The cost is accidental triggers,
which is why P1-04 adds a brief silent abort window *before* dispatch rather
than a cancel button after it.

---

## 4. Response paths

| Input | Alert becomes | Contacts receive | Recording |
|---|---|---|---|
| Correct keyword | `resolved` | "She is safe" | stops |
| Wrong keyword | `escalated` | Escalation message | **continues** |
| Dismissed / ignored | `escalated` at the window | Escalation message | **continues** |
| Attempts exhausted | `escalated` | Escalation message | **continues** |

Note the default in every ambiguous case is **escalate**. Silence is not
consent, and a failed attempt is evidence of duress, not evidence of error.

Recording continuing through escalation is SRD Layer 5 and it is the point:
the moments after a failed safety check are the moments most worth capturing.

---

## 5. What the coercer observes — the crux

This is the requirement everything else serves:

> **The immediate on-screen response must be identical in every case.**

### Recommended deviation from the SRD

The SRD gives two different responses — correct → "All good ✨", wrong →
"Got it 👍". **These are distinguishable.** A coercer who has seen the flow once,
or who has read about the app, learns which one means failure. The layer then
protects only against an adversary who has never encountered it before, which
is not the adversary we have.

Recommendation: **one response, identical in text, timing and animation,
regardless of outcome.**

The obvious objection is that a genuinely safe user then has no confirmation.
That is real but survivable, and it is answered outside the popup:

- The app's own state reflects the truth when she next looks at it.
- Her contacts receive either "she is safe" or the escalation — she can confirm
  with them afterwards.
- The popup is the surface he is watching *in that moment*; it is the one that
  has to be silent. It is not her only channel.

This is the second recommended deviation from the SRD (the first is P1-02 §4).
Both need your decision.

---

## 6. The forgotten keyword

The SRD does not address this. The current build has no recovery path at all —
forget the keyword and the alert cannot be cancelled, ever.

**There must be no bypass for an active alert.** A recovery path usable under
duress is a coercion target, and the entire mechanism rests on the keyword being
unbypassable. So the honest answer is:

> If she forgets the keyword, the alert escalates. Her contacts are told to
> check on her. That is inconvenient and it is also *correct* — a person who
> cannot confirm she is safe is a person worth checking on.

Recovery happens **after**, not during, via transition 4 in P1-02
(`escalated` → `resolved`), from a recognised device, after a delay, with the
resolution recorded as `owner_late`. She is not left permanently marked as in
danger, and nothing she can be forced to do shortens the path.

---

## 7. Brute force

No limit exists today. A coercer can make her guess indefinitely.

- Attempts are limited per alert (P1-14), counted **server-side**.
- Every failed attempt escalates immediately — the limit is not a gate before
  escalation, it is a cap on how long he can keep trying.
- **Exhausting attempts never locks her out.** Lockout would hand him a way to
  permanently disable her resolution path. The alert stays resolvable.
- Failed attempts are recorded on the alert. A cluster of them is itself
  evidence.

---

## 8. Messages

Escalation text reaches contacts, not the phone in the room, so it can be
explicit. Per the SRD:

- **Escalation** — "URGENT: [Name]'s safety check failed. Location: [link].
  Please check on her immediately."
- **Resolution** — "[Name] is safe. Alert resolved."

Both need Amharic review (P4-15). Neither may be delivered as a notification to
*her* device — see P1-05.

---

## 9. Open for Meron

1. **§5 — one identical response instead of the SRD's two.** Recommended.
   This is the deviation that most changes the SRD's described behaviour.
2. **User-authored safety question** at onboarding, rather than a fixed one.
   Recommended; adds an onboarding step (P4-03).
3. **No cancel button at all between trigger and the 2-minute check.** This is
   the SRD's design and I agree with it, but it makes accidental triggers
   costly and depends on P1-04 landing the pre-dispatch abort window first.
4. **Attempt limit.** How many? Low enough to bound his retries, high enough to
   survive a typo under stress. My suggestion is 3, but this is a judgement call
   about real users under duress and should be tested (P4-01).
