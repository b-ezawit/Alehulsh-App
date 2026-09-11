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

## 4. Generic is not the same as deceptive

The SRD proposes disguising notifications as *"System update available"* or
*"New daily tip"*.

**I would not do this**, for three reasons:

1. **Play Store policy.** Notifications that misrepresent their origin or
   purpose are a plausible policy violation, and `P1-24`/`P1-23` already put us
   on a narrow path to a first release.
2. **It degrades the alert.** A responder who learns that "System update
   available" is noise will swipe it away — including the time it is real.
3. **Trust.** A safety app that lies to its user, even protectively, is a safety
   app she cannot calibrate. She cannot reason about what the app will show.

The goal is achievable without lying: a notification that says **"Alehulsh"**
and nothing else reveals no more than the app's presence on the phone — and
hiding the app's presence is a different problem with a different solution
(app camouflage, SRD *App Disguise*), not one to solve with false text.

**This is a recommended deviation from the SRD and needs your decision.** It is
the third; the others are P1-02 §4 and P1-03 §5.

---

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

1. **§4 — no deceptive notification text**, against the SRD's proposal.
   Recommended.
2. **Haptic on SOS confirmation** — on by default, or off? On is friendlier;
   off is safer in the worst case. My instinct is on-by-default with a clear
   setting, but this is a real judgement call about how users hold their phones.
3. **Renaming the persistent notification and channels** changes what existing
   beta testers see. Harmless, but worth telling them.
