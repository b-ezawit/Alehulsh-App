# User Data Model

**Task:** P2-01 · **Status:** draft for review · **Depends on:** P1-01
**Governs:** field removal (P2-03), the responder projection (P2-04/P2-05),
contact matching (P2-09), data-subject rights (C-16), sensitivity
classification (C-14), and the PostgreSQL schema (M-05).

---

## 1. Current state

One document, `users/{uid}`, holding 21 fields plus four more written by
`location_service.dart`. Until the containment merge it was readable by every
authenticated account.

```
identity      uid · fullName · email · phoneNumber · avatarUrl
health        bloodType · medicalNotes
location      homeAddress · geo · lastKnownLat · lastKnownLng · lastActive
secret        catName                     ← plaintext, default 'Milo'
third party   emergencyContacts[]         ← name · email · phone · relationship
scores        safetyScore · alertsTriggeredCount · alertsRespondedCount
settings      isLocationSharingEnabled · isAutoAudioRecording
              isFakeCallEnabled · isCommunityAlertsEnabled
history       activities[]                ← 50 entries, rewritten on every change
metadata      createdAt · lastActiveAt
```

Three structural problems, separate from the access-control one:

- **Everything is rewritten together.** `syncToFirestore()` writes the whole map
  on every toggle, contact edit and SOS, including the 50-entry activity array
  (SCALE-05). There are no transactions anywhere, so concurrent edits from two
  devices silently clobber each other.
- **Third-party data is an array.** Emergency contacts cannot be queried,
  indexed, individually deleted, or given their own consent record — all of
  which C-16 and P2-23 require.
- **Sensitivity is not expressible.** Health data, a shared secret, settings and
  a display name have identical protection because they are fields of one
  object.

---

## 2. The principle

Minimise first, then partition by **who reads it**, not by what it is about.

P1-01 §7 already settled the top-level shape: **there is no public profile
document.** A responder never reads a profile. She reads an alert projection,
and the display name travels inside it.

So the split is not public/private. It is:

| | |
|---|---|
| **Owner + server** | everything below |
| **Everyone else** | nothing — no profile read exists |

---

## 3. Field disposition

| Field | Disposition | Why |
|---|---|---|
| `uid` | **keep** — identity | Primary key |
| `fullName` | **keep**, private | Source for the display name on the projection. Never read directly by another user |
| `phoneNumber` | **keep**, private + hashed index | Needed for contact matching (P2-09). The raw value never leaves the server |
| `email` | **keep**, private + hashed index | Same |
| `avatarUrl` | **drop** | Always empty in practice; no upload path exists |
| `bloodType` | **PENDING P2-02** | Health data — the heaviest obligation in the model, and Art 2(5) sensitive. No code path reads it |
| `medicalNotes` | **PENDING P2-02** | As above |
| `homeAddress` | **PENDING P2-02** | Collected at signup, read by nothing. Defaults to a real Addis sub-city string for users who never entered one |
| `catName` | **replaced** | Becomes `safetyKeywordHash` + `mustSetKeyword` (P1-11). Plaintext is deleted, not migrated |
| `emergencyContacts[]` | **own entity** | §4 |
| `activities[]` | **own entity** | §4 |
| `safetyScore` | **PENDING P4-12** | Starts at 92, +3 per contact. Communicates an assessment we cannot make |
| `alertsTriggeredCount` | **keep**, counter | Must become an atomic increment, not read-modify-write |
| `alertsRespondedCount` | **keep**, counter | As above |
| `isLocationSharingEnabled` | **keep**, settings | |
| `isAutoAudioRecording` | **keep**, settings | Becomes meaningful with P3-17 |
| `isFakeCallEnabled` | **drop** | No fake-call feature exists |
| `isCommunityAlertsEnabled` | **keep**, settings | |
| `createdAt` / `lastActiveAt` | **keep**, metadata | |
| `geo` · `lastKnownLat` · `lastKnownLng` · `lastActive` | **delete outright** | P0-08 stopped writing these. Location belongs on an alert, at the moment she raises one — not as a continuously-updated field on a profile |

Two fields that look harmless and are not: `homeAddress` defaults to
`'Bole Sub-city, Addis Ababa'`, so users who never entered one have a plausible
but false address stored about them; and `avatarUrl` is dead weight that
survived because nothing ever audited the model.

---

## 4. Entities

### `user` — private, owner and server only

Identity, secret, settings, counters, metadata. Never read by another user.

### `emergency_contact` — one row per contact, not an array

This is the change that unlocks the most:

- **Deletion becomes real.** Removing a contact removes a row, which is what
  C-16 (erasure) and P2-23 (a contact's own right to be removed) need.
- **Matching moves server-side.** Store `phone_hash` and `email_hash` alongside
  the raw values. P2-09 matches on the hash, so raw contact details stop being
  copied into every alert document where the audit found them.
- **Consent gets somewhere to live.** P2-23 needs a state per contact —
  invited, accepted, revoked — which an array element cannot carry.
- **Reachability becomes answerable.** P3-02 requires showing her which
  contacts the system can actually reach. That is a per-contact fact.

### `activity` — append-only, not a rewritten array

Fixes SCALE-05, and gives C-16 a place to serve an access request from without
reading the whole profile. Retention applies here: this log records every SOS
she has ever raised.

### `alert_projection` — what a responder sees

Defined fully in P2-04. Sourced from here so the dependency is explicit:
**display name** (derived from `fullName`), fuzzed location, distance band,
urgency. No phone, no email, no contact list, no exact coordinates.

---

## 5. Shape for M-05

Storage-agnostic above; this is the translation, so M-05 is transcription
rather than redesign.

```
user(uid PK, full_name, phone, phone_hash, email, email_hash,
     safety_keyword_hash, must_set_keyword,
     alerts_triggered, alerts_responded,
     settings JSONB, created_at, last_active_at)

emergency_contact(id PK, owner_uid FK -> user,
                  name, phone, phone_hash, email, email_hash,
                  relationship, is_primary,
                  consent_state, invited_at, accepted_at, revoked_at)
    index (owner_uid), index (phone_hash), index (email_hash)

activity(id PK, owner_uid FK -> user, kind, occurred_at, detail JSONB)
    index (owner_uid, occurred_at DESC)
```

Notes for M-05:

- `phone_hash` / `email_hash` are keyed HMACs using the same pepper discipline
  as the keyword (P1-11), not bare SHA-256. A bare hash of a phone number is
  reversible — the space of Ethiopian mobile numbers is small enough to
  enumerate exhaustively.
- Settings stay a JSONB blob. They are read and written as a unit and none of
  them is ever queried.
- Row-level security enforces owner-only on all three tables. Unlike Firestore
  rules, RLS can express this without a projection — but the projection stays,
  because staged location reveal (P2-08) is stateful logic that belongs in the
  API layer regardless.

---

## 6. Migration

Ordered so nothing is destroyed before its replacement works:

1. Add the new fields alongside the old. Dual-read, old wins.
2. Backfill `phone_hash` / `email_hash`; contacts out of the array into rows;
   activities out of the array into rows.
3. Switch reads to the new shape.
4. Delete `avatarUrl`, `isFakeCallEnabled`, `geo`, `lastKnownLat`,
   `lastKnownLng`, `lastActive`, and whatever P2-02 drops.
5. Verify no document retains a deleted field. **Deleting the write path is not
   deleting the data** — the values already stored must be purged too, which is
   the part P2-03 has to be explicit about.

Step 4 is irreversible. Run it on a copy first, as with P1-11.

---

## 7. Open for Meron

1. **P2-02 — `bloodType`, `medicalNotes`, `homeAddress`.** All three collected,
   none read by any code. Health data carries the heaviest obligations of
   anything here. Drop, or give each a named consumer and a retention period.
2. **`safetyScore` (P4-12).** Remove, or define it as something real.
3. **Do we keep raw phone and email at all**, or only the hashes? Raw values are
   needed to *display* her contact list back to her. If the in-app contact alert
   (P3-01) replaces dialling entirely, the raw phone may become unnecessary —
   which would be a meaningful reduction in what a breach exposes.
