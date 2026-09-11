# Notification Privacy

**Task:** P1-05 · **Status:** draft for review · **Depends on:** P1-03
**Governs:** every notification the app posts (P1-21), contact alerts (P3-03),
the foreground service (P3-11), and FCM payloads (P0-09).

---

## 1. What exists today

Five notification sites. **All five are `VISIBILITY_PUBLIC`**, three set
`fullScreenIntent`, and all play sound and vibrate.

| Site | Content |
|---|---|
| `emergency_ping_service.dart:226` | "🚨 [Name] is requesting for help!!" |
| `emergency_screen.dart:244` | "🚨 Your Alert has been sent." |
| `emergency_gesture_service.dart:119` | "🚨 Your Alert has been sent." |
| `AlehulshForegroundService.kt:333` | "[Name] is requesting for help!!" |
| `AlehulshSosDispatcher.kt:247` | "🚨 Your Alert has been sent." |

So at the moment she triggers an SOS — covertly, by pressing the power button
in her pocket — **her phone lights up, sounds, vibrates, and displays "Your
Alert has been sent" on the lock screen.** The stealth trigger exists to keep
the coercer from knowing. The confirmation tells him immediately.

### The larger leak: the always-on notification

`strings.xml` gives the persistent foreground-service notification:

> **Alehulsh protection is on**
> 5× power SOS and nearby alert pings are active.

This sits in the notification shade **permanently**, not just during an
emergency. Anyone who picks up her phone learns three things at once: that she
runs a safety app, exactly how to trigger it, and that it monitors nearby
alerts. The accessibility-service description in Android Settings repeats it.

This is worse than the SOS notifications, because the SOS notifications only
expose her during an incident. This one exposes her every day, before anything
has happened — which is precisely the period in which an abuser is deciding
whether she has help.

### Channel names leak too

Android Settings lists notification channels by name. Ours read
*"Emergency Proximity Pings"* and *"Alehulsh Safety Radar"*, with descriptions
including *"Urgent alerts from nearby women requesting help."*

---

## 2. Three audiences, three threat profiles

The current code treats all notifications identically. They are not.

| Audience | Threat | Consequence of exposure |
|---|---|---|
| **The user herself** | A coercer is holding or watching her phone | Highest. Reveals she called for help, at the moment she is least safe |
| **Responders** | Bystanders near the responder | Reveals a third party's name and that an emergency is happening nearby |
| **Emergency contacts** | Bystanders near the contact | Same, plus identifies the contact as connected to her |

---

## 3. Rules

### For the user's own device

- **Default: no notification at all.** The SOS screen is already in front of her;
  in-app state is the confirmation (P1-06).
- If the app is backgrounded — the hardware-trigger case — post a **silent**
  notification: no sound, no vibration, no `fullScreenIntent`,
  `VISIBILITY_SECRET`, neutral title, no body.
- **Never** `fullScreenIntent` on the user's own device. It takes over the
  screen, which is the single most visible thing an Android app can do.
- Haptic confirmation is acceptable and preferred — a single short vibration is
  felt in a pocket and not seen across a room. Make it configurable; in some
  situations even that is too much.

### For responders and contacts

- `VISIBILITY_PRIVATE`. Lock screen shows the app name and nothing else.
- Detail — who, where, how far — only after unlock.
- Sound and heads-up display are appropriate here. These are people we are
  trying to wake, and the threat model is a bystander glancing, not a coercer
  in the room.
- **No name, no location, no distance on the lock screen.**

### The persistent foreground notification

Required by Android; cannot be removed. So it must say as little as possible:

- Title: the app name alone.
- No body text. Certainly not the trigger mechanism.
- Lowest importance, no badge, `VISIBILITY_SECRET`.

Channel names and descriptions are user-visible in Settings and must be neutral:
*"Background activity"*, *"Alerts"*. Not *"Emergency Proximity Pings"*.

---

## 4. Concealment: what actually works, and what Play allows

Meron's direction is that picking up her phone should not reveal a safety app.
Agreed — but **notification text cannot achieve that**, and it is worth being
precise about why before we spend effort in the wrong place.

Android renders the **app's own name** on every notification it posts. We do not
control that string per-notification; it comes from the app label. So however
neutral the title and body are, the notification still reads *Alehulsh*. The
same label appears in the launcher, in Settings → Apps, in battery usage, and in
the permission manager.

**The lever is the app's name and icon, not the notification copy.**

### What Play actually prohibits

Play's Deceptive Behavior policy requires that "all metadata, including the
store listing, screenshots, and title, must precisely reflect the app's
functionality", and separately prohibits apps that **mimic other apps or OS
warnings**.

That settles the SRD's proposal directly: *"System update available"* is an
OS-warning mimic and is prohibited. This is a policy line, not my preference.

### What works instead — the Aspire News pattern

Aspire News is a domestic-violence app that ships on both stores while
presenting as a news app. It does not violate the policy, and the reason is
instructive:

> **It is genuinely a news app.** It carries real news content. The store
> listing describes a news reader that also contains a help feature. Nothing in
> the metadata is false.

The principle generalises:

> Do not disguise the app as something it is not. Make the app **genuinely be**
> that thing, and put the safety feature inside it.

Applied here, the SRD's own *App Disguise* idea ("Alehulsh Notes") is viable
precisely if the notes app is real — a working notes surface that is also,
behind a PIN or gesture, the SOS app. The listing then honestly describes both.

Two further patterns worth taking from Aspire:

- **User-selectable icon and label.** The user picks which icon appears on her
  home screen, post-install, from a set. Android supports this via
  `activity-alias`, and because she chooses it after install, the store listing
  is untouched. It also changes the name shown on notifications — which is the
  thing we actually needed.
- **The escape control navigates rather than exits.** Aspire's panic button
  jumps to a random innocuous screen inside the app. Closing an app when someone
  walks in looks guilty; being on a different page does not. Better than a
  "hide" button.

### The counter-argument, which is real

Research on technology-facilitated abuse is consistent that **discovery
escalates danger**. A concealment layer that fails is worse than none, because
it proves intent to seek help. Two implications:

1. Concealment must never be presented as safety. If she is told the app is
   hidden and it is found, we have caused the harm.
2. It must be **her choice**, defaulted off, with a plain explanation of what it
   does and does not hide.

The honest framing is: this raises the cost of casual discovery. It does not
survive someone who searches her phone.

### Recommendation

- **Adopt** user-selectable icon and label (Aspire pattern), defaulted off.
- **Adopt** navigate-don't-exit for any panic-hide control.
- **Reject** deceptive notification text — prohibited by Play, and it trains
  responders to ignore real alerts.
- **Neutral-but-true** notification content stands as specified in §3.

This supersedes my earlier recommendation, which treated the question as purely
one of notification wording. That was too narrow — it would not have delivered
what you asked for.

**New work implied:** app camouflage is not currently a task. It needs one, and
it belongs after the P0 and P1 safety work rather than before it.

## 5. What this does not solve

Notification privacy protects the moment. It does not protect against someone
who opens the phone and looks at the app. That needs:

- App camouflage and an app-lock — SRD *App Disguise*, not yet a task.
- Android notification history, which retains dismissed notifications and is
  outside our control.

Worth stating plainly so the layer is not over-trusted: **a determined person
with her unlocked phone will find out.** This raises the cost and removes the
accidental disclosure. It is not concealment.

---

## 6. Open for Meron

1. **§4 — RESOLVED.** Deceptive text is out (Play policy, not preference).
   Concealment moves to user-selectable icon and label. Needs a new task.
2. **Haptic on SOS confirmation** — on by default, or off? On is friendlier;
   off is safer in the worst case. My instinct is on-by-default with a clear
   setting, but this is a real judgement call about how users hold their phones.
3. **Renaming the persistent notification and channels** changes what existing
   beta testers see. Harmless, but worth telling them.
