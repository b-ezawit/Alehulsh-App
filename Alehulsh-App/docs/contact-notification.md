# Emergency Contact Notification

**Task:** P3-01 · **Status:** draft for review · **Depends on:** P1-03
**Governs:** contact alerts (P3-03), escalation on non-response (P3-04), contact
onboarding (P3-02), and the fallback decision (P3-05).

---

## 1. What exists

Nothing reaches an emergency contact.

There is no SMS anywhere in the codebase. `url_launcher` is imported in exactly
one file and only opens Google Maps. A contact learns about an alert **only if**
they happen to have the app installed, running, and their client-side stream
happens to match — `emergency_ping_service.dart:160-179` matches on name, email
and phone by comparing strings on the device.

So today an SOS can reach nobody at all while the app tells her
*"Help is on the way."*

---

## 2. The channel decision

Meron's call: **in-app notification, not a provider SMS gateway.**

It is the right call, and for more reasons than cost:

| | |
|---|---|
| No provider contract | Africa's Talking' Ethiopian termination was never verified, and that risk disappears |
| No regulatory dependency | A2P sender-ID registration is not on the critical path |
| Richer | Location, acknowledgement, two-way — an SMS is a dead end |
| Real receipts | We learn whether she *opened* it, not whether we handed it to a carrier |
| **Residency** | An SMS via a foreign gateway exports her name, a location link and a phone number. In-app keeps it in-country, which Art 22(1) requires anyway |

That last one is the strongest and was not the reason it was chosen. It means
the decision is consistent with the migration rather than something to revisit
after C-04.

### The dependency it creates

**Every emergency contact must install the app.** At launch that is close to
none of them, and a contact who is her mother on a feature phone can never be
reached this way — not slowly, never.

This is not a reason to reverse the decision. It is the reason §5 exists.

---

## 3. Delivery tiers

Each reports its own real guarantee. Per P1-06, the UI must not borrow a
stronger one from the tier above.

| Tier | Channel | Guarantee | Shown to her |
|---|---|---|---|
| 0 | Alert recorded | Strong | "Alert recorded" |
| 1 | Push to contact devices | **Best effort.** Doze, disabled notifications, battery optimisers, stale tokens all fail silently | Nothing |
| 2 | Contact opens it | Observable | "Seen by 1 contact" |
| 3 | Contact **acknowledges** | Explicit | "2 contacts responding" |
| 4 | Fallback (§5) | Strongest available | "Couldn't reach anyone — tap to call" |

**Only tier 3 counts as reaching someone.** A push that was sent is not a push
that arrived; a push that arrived is not a person who read it; a person who read
it is not a person who is coming. The audit found the app reporting responder
counts from *sends*. It must report them from acknowledgements.

---

## 4. Escalation on non-response

Meron's escalation idea, made precise. "No response" is three different
signals and they deserve different treatment:

| Signal | Meaning | Action |
|---|---|---|
| Not delivered | Device unreachable | Escalate **immediately** — do not wait out the timer |
| Delivered, not opened | Phone is in a pocket | Wait the interval, then escalate |
| Opened, not acknowledged | Seen and not acted on | Wait the interval, then escalate |

The first is the one worth getting right. If the push never landed there is
nothing to wait for, and spending the full interval waiting is dead time in an
emergency.

**Escalation must widen, never repeat.** Escalating from an undelivered push to
another push to the same unreachable phone is not escalation. The order:

1. Remaining contacts who have not acknowledged
2. Nearby responders (once P4-07 and P2-05 land)
3. The §5 fallback

And per P1-03, none of this is visible on her device. The escalation exists
precisely for the case where she cannot act, and a coercer must not see it
happen.

---

## 5. The no-app fallback

**DECIDED: option A — her own phone sends it.** Chosen because it costs nothing,
which was the reason the channel moved off SMS in the first place, and because
it never touches our servers and is therefore residency-clean by construction.

**What is actually achievable, and what is not.** Android splits this in two:

| | Permission | Works when |
|---|---|---|
| `sms:` intent — opens her SMS app pre-filled | **none** | She can tap send |
| Auto-send | `SEND_SMS` | Play restricts this to apps whose core function is SMS. An exception is possible but not assured |

So the version that ships without a Play negotiation requires **a tap**.

That is enough for the case it was designed for. P1-06 offers the fallback when
the alert itself fails — she has just pressed SOS and is looking at the screen,
so a tap is plausible.

It is **not** enough for the hardware trigger with the phone in her pocket. In
that case, if the network is gone, nothing reaches anyone. That gap is real and
should not be papered over; it is the strongest argument for eventually
applying for the `SEND_SMS` exception, and the reason P3-02 (showing her which
contacts are reachable) matters more, not less.

| Option | For | Against |
|---|---|---|
| **A. Device-originated SMS** — her own phone sends it | Free · no provider · no regulator · works with no data · never touches our servers, so residency-clean by construction | Play restricts `SEND_SMS`, so automatic sending needs a policy exception. The permission-free `sms:` intent needs a tap she may not be able to make |
| **B. Server SMS via provider** | Works without her participation | Reintroduces provider risk, cost, and a cross-border transfer question under Art 22(3) |
| **C. No fallback** | Simplest | An SOS can reach nobody, and we would have to say so plainly in the UI |

Option A is residency-clean in a way B is not, and that now matters more than
it did when this was only a cost question.

---

## 6. She must know who is reachable — before anything happens

The requirement that follows from §2 and is easy to miss:

> Her contact list must show, per contact, whether we can actually reach them.

Not a diagnostic screen. A visible state next to each contact: *app installed*,
*invited, not yet accepted*, *cannot be reached*. Finding out in the moment is
finding out too late, and a woman who believes three people will be told when
in fact none will be is worse off than one who knows to call directly.

This makes contact onboarding (P3-02) a core flow, not a nicety.

---

## 7. Open

1. ~~**P3-05** — the fallback channel.~~ **DECIDED — device-originated SMS.**
   Open sub-question: do we apply for the `SEND_SMS` Play exception so the
   pocket case works, or accept the tap requirement?
2. **Escalation interval.** P1-03 sets the safety check at 2 minutes; contact
   escalation is a separate clock and needs its own number.
3. **Does an acknowledging contact see her location?** P1-01 §4 says yes, and
   immediately — she chose them in advance. Confirm that survives the channel
   change.
