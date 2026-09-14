# Recovering a forgotten safety keyword

**Status:** designed, implemented (P1-11.1). Supersedes the "no recovery at all"
position in `coercion-and-escalation.md` §6, which stands for *live alerts* and
is unchanged.

---

## 1. The problem, stated honestly

The keyword works because it cannot be bypassed. Anything that lets her get
past it is something she can be **forced** to use.

That is why §6 concluded "no recovery" — correctly, for a live alert. But it
left a real person stuck: forget the keyword and the mechanism is dead for her
forever. She keeps triggering escalations she cannot stop, learns the app
punishes her, and stops using it. A safety tool nobody uses protects nobody.

So the question is not *whether* to allow recovery. It is how to allow it in a
way an abuser standing next to her cannot use.

## 2. What other systems do

Every mature system facing "reset a secret without creating a bypass" reaches
for the same lever, which is **time**, not identity:

| System | Mechanism |
|---|---|
| Signal registration lock | Forgotten PIN → 7-day wait before re-registration |
| Apple account recovery | Multi-day delay; recovery contacts can shorten it |
| Google Advanced Protection | Multi-day delay even with full credentials |
| Bank PIN reissue | Out-of-band, days, never at the counter on demand |

The reason it is always time is that **coercion is short**. A man standing over
her with her phone has minutes, maybe an evening. He does not have three days of
standing there, and if he does, the delay is the least of the problem — but the
system has had three days to escalate.

Identity checks do not have this property. Anything she can prove under duress,
she can be forced to prove.

## 3. Decided

**A keyword reset is time-locked, visible, and cancelled by danger.**

1. She requests a reset. **Nothing changes yet.** The old keyword still works.
2. A 72-hour window opens. The pending reset is visible in the app — if it was
   started without her knowledge, she finds out.
3. **Any SOS during the window cancels the reset.** If she is in danger while a
   reset is pending, completing it is exactly wrong.
4. She may cancel it herself at any time, without knowing the keyword.
5. After 72 hours she confirms, and only then does the new keyword take effect.

Plus the rule that does not move: **a reset cannot be requested or confirmed
while an alert is live.** Same reason as `PUT /v1/me/keyword` — during an alert,
the reset would be the bypass.

## 4. Why each part earns its place

**The delay** is the whole defence. It converts "make her reset it now" into
"stand next to her for three days", which is not a thing an abuser can do
covertly.

**Cancellation-by-SOS** closes the obvious attack: he starts a reset, waits out
the window, then coerces her. If anything happens to her in between, the reset
dies. It also means the mechanism she needs most is never weakened at the moment
she needs it.

**Visibility** is what makes a secret reset impossible. He can start one; he
cannot hide it for three days.

**Self-cancellation without the keyword** matters because she has forgotten it —
requiring it to cancel would make the escape hatch as locked as the door.

## 5. What this does not solve, stated plainly

An abuser with sustained access to her phone over three days, who watches it
closely enough to suppress the notice and prevent her cancelling, can complete a
reset. That is a coercive-control situation where he already has continuous
access to her device, and no keyword scheme survives it. The honest framing:
this raises the cost from *seconds* to *three days of sustained control*, and
makes the attempt visible. It does not make it impossible.

The alternative — no recovery — does not beat that attacker either, and it
additionally abandons every woman who simply forgot.

## 6. Rejected

**Security questions.** Everything a partner knows. Mother's maiden name is an
abuser's first guess, not a defence.

**SMS or email reset.** He very often has the phone; sometimes the email.
Also reintroduces an SMS dependency we removed for cost reasons.

**Emergency-contact approval.** Attractive — she has contacts already — but it
moves the coercion to someone with less at stake and no training, and a contact
who does not have the app cannot approve anything. Possible later as a way to
*shorten* the window, never to replace it.

**Support-staff reset.** Does not scale, and creates an insider who can unlock
any woman's keyword. That is a worse thing to exist than a forgotten keyword.

**Shorter delay.** 24 hours is one night. The window has to outlast a single
evening of being watched.
