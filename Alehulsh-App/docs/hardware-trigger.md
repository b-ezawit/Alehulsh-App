# Hardware Trigger Thresholds

**Task:** P1-04 · **Status:** draft for review · **Depends on:** P1-03
**Governs:** P1-22 (retune triggers, Beza), and the abort window in P1-16.

---

## 1. What is actually implemented

Three independent paths fire the SOS. All three call
`AlehulshSosDispatcher.trigger()` with the label `"5x Power Button Gesture"`.
**None of them counts five power presses.**

| # | Where | Condition | What it measures |
|---|---|---|---|
| 1 | `HardwareSosAccessibilityService.kt:60` | **3** power key events within 3500 ms | Power presses — directly |
| 2 | `AlehulshForegroundService.kt:76` | **2** `SCREEN_OFF` events within 2500 ms | Screen state — a *proxy* |
| 3 | `AlehulshForegroundService.kt:97` | **3** screen toggles of any kind within 3000 ms | Screen state — a *proxy* |

Paths 2 and 3 are the problem. The screen changes state for many reasons that
are not a power press: display timeout, a notification waking the screen,
fingerprint or face unlock, lift-to-wake, an app requesting a wake lock.

Path 3 in particular fires on **three screen toggles in three seconds**. Glancing
at the time, putting the phone down, and glancing again satisfies it.

Path 1 is sound in principle — it reads real `KEYCODE_POWER` events — but its
threshold is 3, and it only checks total elapsed time. A sequence of three
presses spread across 3.4 seconds, which is not a deliberate gesture, counts.

---

## 2. Why this matters more than it used to

A false trigger is no longer a minor annoyance. As of P1-03, it:

- broadcasts her identity, location and contact list;
- **cannot be cancelled for two minutes** — there is no on-screen resolve button
  by design, only the safety check at the 2-minute mark;
- requires her safety keyword to resolve when the check does arrive;
- escalates to her contacts if she gets that keyword wrong.

So an accidental press in her pocket now means her emergency contacts are told
she is in danger. The tolerance for false positives is close to zero.

---

## 3. Recommendation

### Delete paths 2 and 3

They are proxies for a thing we can measure directly, and they are the source of
essentially all false positives. A proxy that fires during normal phone use is
not a safety feature.

This has a real cost and it should be stated plainly: **path 1 requires the
accessibility service.** If the user has not granted it, deleting paths 2 and 3
means there is no hardware trigger at all.

That is the honest position. An unreliable trigger that fires while the phone is
in her bag is worse than no trigger, because it burns her contacts' attention
and trains her to distrust the app. If accessibility is not granted, the app
should **tell her the hardware trigger is off**, not silently substitute a
guess.

### Retune path 1

| Parameter | Current | Recommended | Why |
|---|---|---|---|
| Press count | 3 | **5** | Matches the documented behaviour, the user-facing string, and Android's own Emergency SOS convention |
| Total window | 3500 ms | **4000 ms** | Five presses need slightly longer than three |
| **Max gap between presses** | *not checked* | **1200 ms** | The important addition — enforces a deliberate rhythm rather than five presses that happen to fall inside a window |

The inter-press gap is the change that does the real work. Total-elapsed alone
cannot distinguish a deliberate burst from incidental presses that land in the
same few seconds.

### Unify the constant

The thresholds live in two files and two languages today. They should be one
constant, referenced by every path, so they cannot drift apart again.

---

## 4. The pre-dispatch abort window

P1-03 removes the on-screen cancel button, so the only protection against an
accidental trigger has to come *before* dispatch.

- **3 seconds**, after detection, before anything is sent.
- **Silent** — no sound, no vibration (P1-05). A discreet banner.
- **Visually minimal.** Not "CANCEL SOS" in red. A coercer who sees an obvious
  cancel affordance will press it.
- If the screen is **off or locked**, skip the window and dispatch. She cannot
  see it, so waiting only delays real help.

This does create a narrow coercion window. I judge it net-positive: it is three
seconds, it happens before anything is sent, and a coercer close enough to catch
it is close enough to have stopped her pressing the button. Worth revisiting if
testing suggests otherwise.

---

## 5. A safety hole in the current cooldown

`AlehulshSosDispatcher.kt:50` — after a cancellation, **all hardware triggers
are disabled for 20 seconds**.

That is exploitable. Force her to cancel, and the hardware trigger is dead for
the next 20 seconds — which is the window in which an attack would begin. It
also blocks the legitimate case: she cancels an accidental trigger, is then
genuinely attacked moments later, and the button does nothing.

**Recommendation: remove the post-cancellation lockout entirely.** Keep the
20-second *debounce* on repeat triggers — that prevents duplicate alerts and is
harmless, because P1-02 §7 makes a repeat trigger extend the existing alert
rather than create a second one.

A safety feature should never be disabled as a side effect of the user using it.

---

## 6. Test plan (P1-22)

The numbers above are reasoned, not measured. They need validating before they
ship.

**False positives** — three devices, at least one low-end, one week of normal
use each, trigger logging on but dispatch stubbed. Target: **zero** accidental
dispatches. Anything above zero means the thresholds are still wrong.

**True positives** — each tester performs the gesture 20 times: in hand, in a
pocket, in a bag, with gloves, one-handed. Target: **>95%** detection. If the
gesture is hard to perform deliberately it will fail when it matters.

**Cross-device** — Samsung, Xiaomi/Transsion and a stock-Android device at
minimum. OEM power-button handling differs, and Transsion brands (Tecno, Infinix,
itel) are worth prioritising given their share of the Ethiopian market.

Both numbers matter and they pull against each other. If we cannot get both,
**favour fewer false positives** — a missed trigger is recoverable by opening
the app; a false trigger under the P1-03 rules is not.

---

## 7. Open for Meron

1. **Deleting paths 2 and 3 means no hardware trigger without the accessibility
   permission.** Recommended, but it is a real capability loss and you should
   decide it consciously.
2. **Five presses, 4 s window, 1.2 s max gap.** Reasoned defaults, to be
   confirmed by §6.
3. **Removing the post-cancellation lockout** (§5). I consider this a bug fix
   rather than a preference, but it changes behaviour Beza wrote deliberately.
4. **The 3-second abort window** creates a narrow coercion surface. I judge it
   worth it; you may not.
