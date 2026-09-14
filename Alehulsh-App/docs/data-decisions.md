# Profile fields, retention, and responder access

**Status:** decided by Meron, 2026-09-14. Closes P2-02, P2-12, and the
responder-playback question left open by P2-10.

---

## 1. Profile fields (P2-02)

Every field kept is a field that leaks if an account is compromised. The test
is not "might this be useful" — it is "does a woman in danger get worse help
without it".

| Field | Decision | Reason |
|---|---|---|
| `fullName` | **keep** | A responder needs to know who to look for |
| `phoneNumber` | **keep** | Identity and contact matching |
| `homeAddress` | **keep, optional** | Useful when she cannot describe where she is. Optional because for a woman whose abuser lives with her, her home address is *his* address — storing it is a risk, not a help |
| `emergencyContacts` | **keep** | The core of the alerting model |
| `safetyKeywordHash` | **keep** | Hash only; P1-11 removed the plaintext |
| `bloodType` | **DROP** | We are not a medical service. No responder is authorised to act on it, no ambulance will take it from us, and it is health data — the most sensitive category there is |
| `medicalNotes` | **DROP** | Same, and worse: free text invites her to write things that are far more damaging in the wrong hands than they are useful in the right ones |
| `avatarUrl` | keep | Recognition |
| counters, flags, activity log | keep | Not sensitive |

**Dropping is not just "stop writing it".** P2-03 purges the values already
stored in existing documents. A field we stopped using but left in the database
is a field that still leaks.

## 2. Retention (P2-12)

**Alerts and their recordings are kept for 30 days, then deleted — and she is
warned before that happens.**

The warning is the part that makes this defensible. Thirty days is short for
evidence a court may want; without a warning we would be quietly destroying
the only record of an assault. With one, the choice is hers: download it, or
let it go.

Sequence:

1. Day 0 — alert raised.
2. Day 23 — she is told: *"Recordings from [date] will be deleted in 7 days.
   Download them if you need them."*
3. Day 30 — evidence objects and the alert record are deleted.

Notes that follow from the rest of the design:

- The warning goes to her, on her own device, and **says nothing on a locked
  screen** beyond a neutral prompt — P1-05 applies to this notification like
  any other.
- Deletion must reach the objects as well as the rows, in that order, for the
  reason set out in the account-deletion work: an orphaned row is recoverable,
  an orphaned recording is not.
- 30 days is a starting point, not a law. It is a configured value.

**Still open:** whether a survivor can mark an alert as *retained* — pinned
against deletion because a case is ongoing. Strongly worth doing, and it is
the obvious follow-up.

## 3. Responder playback (P2-10.4)

**Yes — but only for a recording she deliberately made and sent.**

This is the distinction that makes it safe. There are two kinds of audio:

| Kind | What it is | Responder may hear it |
|---|---|---|
| `deliberate` | She pressed record and chose to attach it: "he's outside, I'm in the bathroom" | **yes**, after accepting |
| `automatic` | Ambient capture started by the SOS trigger itself | **no, ever** |

Automatic recordings are made without a decision. They can contain anything
that happened to be audible — her address, other people's conversations, a
child. Handing that to a stranger because he tapped *accept* is not something
she consented to. It stays evidence for her and for a court, not material for
the person coming to help.

Conditions on playback of a deliberate note:

- the responder was **selected** for this alert (holds an inbox projection);
- the responder has **accepted** it (P1-10);
- the alert is **still live** — access ends when the alert does;
- every playback is **logged and attributable**, like a location reveal;
- the URL is short-lived and issued per request.
