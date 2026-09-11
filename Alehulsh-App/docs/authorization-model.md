# Authorization Model

**Task:** P1-01 · **Status:** decisions resolved against the SRD · **Depends on:** P0-05, P0-06
**Governs:** the interim Firestore rules, the callable layer (P1-07…P1-10), the
fan-out projection (P2-04), staged location reveal (P2-08), and the Postgres
schema and RLS policies when we migrate (M-05).

---

## 1. The mistake this document exists to prevent

Every critical finding in the audit traces to one error:

> **Being signed in was treated as a grant.**

`allow read: if isAuthenticated()` on `/users` and `/active_alerts` meant any
account could read every user's live location, phone number, home address,
emergency contacts and safety keyword. That was not an oversight in a single
rule — it followed inevitably from asking a client-direct database to enforce
"only if you are near this alert," which Firestore rules cannot express.

The correction is a single principle:

> **A role is a relationship to a specific resource, not a property of an
> account. The client never asserts its own role. Every relationship is
> established server-side from stored facts.**

Everything below follows from that.

---

## 2. Roles

None of these are global. Each is a relationship, scoped to one resource.

| Role | How it is established | Scope |
|---|---|---|
| `owner` | The authenticated subject is the subject of the record | Her own profile, alerts, evidence |
| `responder` | Server selected her for *this* alert (P2-05) **and** she accepted (P1-10) | One alert, while active |
| `contact` | The owner designated her, matched server-side on a hashed identifier (P2-09) | One alert, while active |
| `stranger` | Signed in, no stored relationship to this resource | Nothing |
| `anonymous` | Not signed in | Nothing |

Deliberately **not** defined yet, because no agreement exists and speculative
roles become speculative access:

- `officer` — gated on P5-03. Will be per-case, never per-force.
- `institution` — aggregate data only, never row-level. Gated on P5-02.
- `support` — see §6.

**`stranger` and `anonymous` collapse to the same access: none.** That equality
is the whole fix. Today they differ, and that difference is the vulnerability.

---

## 3. Resources

Splitting these apart is what makes least privilege expressible. Today they are
fused into two documents, which is why access is all-or-nothing.

| Resource | Contents |
|---|---|
| `profile.private` | Phone, home address, medical notes, safety-keyword hash, emergency contacts |
| `profile.public` | Display name, avatar letter — **see §7, open question 3** |
| `alert.raw` | Exact coordinates, victim phone/email, full contact list |
| `alert.projection` | Fuzzed location, display name, distance band, urgency |
| `alert.precise_location` | Exact coordinates, released under staged conditions |
| `voice_note` | A short clip the user **deliberately** records to explain her situation |
| `evidence_recording` | Auto-captured interval audio (P3-16/P3-17) |
| `inbox` | One private collection per user, holding projections sent to her |
| `audit_log` | Append-only record of every precise-location release and evidence access |

`alert.raw` is the important one: **it never leaves the server.** Responders
receive a projection derived from it, never the record itself.

Splitting `voice_note` from `evidence_recording` is what resolves the apparent
contradiction in the SRD — see §7, question 2.

---

## 4. Access matrix

`R` read · `W` write · `—` denied. Lifecycle stages are coarse here;
P1-02 formalises the state machine.

| Resource | Owner | Responder (accepted) | Contact | Stranger |
|---|---|---|---|---|
| `profile.private` | RW | — | — | — |
| `profile.public` | RW | R | R | — |
| `alert.raw` | R | — | — | — |
| `alert.projection` | R | R *(while active)* | R *(while active)* | — |
| `alert.precise_location` | R | R *(after accept **and** within 50 m)* | R *(immediately)* | — |
| `voice_note` | R | R *(while active)* | R *(while active)* | — |
| `evidence_recording` | R | — | — | — |
| `inbox` | R *(own)* | R *(own)* | R *(own)* | — |
| `audit_log` | R *(accesses to her data)* | — | — | — |

### Why each non-obvious cell is what it is

**Owner cannot write `alert.raw` directly.** Creation, cancellation and
resolution go through callables (P1-08, P1-09) so the server can stamp
timestamps, enforce idempotency, verify the safety keyword against a hash, and
schedule escalation. A client that can write its own alert can also write a
false one, or delete evidence.

**Responder hears `voice_note` but never `evidence_recording`.** A voice note is
something the user chose to record and chose to send — it is how she explains
where she is and what is happening, and withholding it makes the responder less
useful. Auto-captured evidence is the opposite: she did not choose each clip,
and it may capture a third party mid-assault. Per the SRD, only she and
authorised police reach it.

**Contact gets precise location immediately; responder does not.** A contact was
chosen by the user in advance. A responder is a stranger the system selected.
Those are not the same trust relationship and should not carry the same access.

**Responder access ends when the alert does.** It is scoped to one alert while
active — not to the user, and not afterwards.

**Owner reads her own `audit_log`.** Art 24–32 gives a data subject the right to
know who accessed her data. Building it into the model now is cheaper than
retrofitting it for C-16.

---

## 5. How relationships are proven

The client sends an identity token and nothing else about who it claims to be.
The server resolves every relationship from stored data:

```
owner      subject == record.owner_id
responder  a row exists in alert_responders(alert_id, responder_id)
           written by the fan-out (P2-05), with accepted_at set (P1-10)
contact    a row exists in alert_contacts(alert_id, contact_hash)
           matched server-side on a hashed identifier (P2-09)
```

Three rules that must hold in every implementation:

1. **No client-supplied role claim is ever trusted.** Not a field, not a header,
   not a custom claim the client could influence.
2. **Proximity is computed server-side.** The client's self-reported position is
   an input to a server decision, never the decision itself.
3. **Every precise-location release and evidence access is written to
   `audit_log` before the data is returned.**

### Interim (Firestore) vs target (Postgres)

| | Interim | Target |
|---|---|---|
| Owner check | Rule: `request.auth.uid == alertId` | RLS: `owner_id = current_subject()` |
| Responder check | **Not expressible** — responder access is off | RLS over `alert_responders` |
| Proximity | **Not expressible** | Computed in the API layer, never in RLS |
| Audit | Not enforced | Append-only table, immutability enforced by the database |

The interim column is why responder discovery is currently disabled rather than
narrowed: Firestore rules cannot express the responder relationship, so there is
no safe partial version. It returns with the fan-out in P2-04/P2-05, which
converts the unexpressible proximity question into an expressible ownership one
("can you read your own inbox?").

---

## 6. Break-glass and administrative access

Currently **undefined, which means unlimited** — anyone with Firebase console
access can read everything. That is a real exposure, not a theoretical one, and
it is the access path an insider would actually use.

Minimum position, to be confirmed with C-13 (DPO):

- No standing administrative access to `profile.private`, `alert.raw` or
  `evidence`.
- Any break-glass access is time-boxed, reason-logged, and written to
  `audit_log` with the accessing identity.
- The affected user is notified that her data was accessed.
- Console and database credentials are held by named individuals, not shared.

---

## 7. Resolved from the SRD

All four questions are answered by the SRD rather than by preference. Where the
SRD is internally inconsistent, the resolution is stated.

### 1. Contact receives precise location immediately — **yes**

SRD, *Emergency Contacts → Alert Flow*: the message sent to contacts carries the
user's nickname and a **Google Maps location link**. That is precise location,
delivered at the moment the alert is raised, with no staging.

The channel changes (in-app rather than SMS) but the access decision does not.
Matrix unchanged.

### 2. Responder hears the voice note, not the evidence recording

The SRD appears to contradict itself here, and the contradiction is worth
stating because it looks like a conflict and is not:

- *Auto-Interval Evidence Recording → Key Features*: "**Privacy:** Only user +
  authorized police can access recordings (RLS policies)."
- *Flow 4, Helper Accepting Alert*: the helper's alert card shows an "Audio
  player (if has audio)" and an "Audio" badge.

These describe **two different things**, which the SRD's own schema makes
explicit: `panic_alerts.audio_url` is commented `-- One-time audio (optional)`,
while auto-captured clips live in a separate `alert_recordings` table.

So: the deliberate voice note is shareable with responders; the auto-captured
evidence stream is not. §3 and §4 are updated to model these as separate
resources.

This also dissolves the tension with C-09 — encrypting the evidence stream
client-side no longer breaks the responder experience, because responders were
never meant to reach that stream.

### 3. No `profile.public` document — **confirmed**

The SRD never exposes a readable profile. Helpers see a **nickname**, and that
nickname travels inside the alert notification, not via a profile read
(*Helper Network → Helpers receive push notification: alert details (nickname,
fuzzed location, time)*).

`profile.public` is therefore dropped as a resource. The display name is a field
on `alert.projection`. This is also the data-minimisation answer: a name that is
only ever carried in a projection never needs a readable profile behind it.

### 4. Break-glass — the SRD's police protocol supplies the pattern

The SRD does not address internal administrative access, but it is explicit that
"No individual user data exposed (except to police with warrant)", and its
*Police Evidence Access Protocol* gives a reusable shape:

> valid case number or digital warrant · all access logged immutably · evidence
> links expire after 72 hours · GPS tracks redacted beyond the incident radius ·
> **user notified when her evidence is accessed**

Applied to internal access, that means:

- **No standing administrative access** to `profile.private`, `alert.raw`,
  `voice_note` or `evidence_recording`.
- Break-glass is time-boxed, reason-logged, and written to `audit_log` with the
  accessing identity.
- **The affected user is notified.**
- Credentials are held by named individuals, never shared.

§6 already states this; the SRD confirms it rather than changing it. Still needs
formal sign-off with the DPO (C-13), which is the one thing here that remains
open — the policy is settled, the ratification is not.

## 8. Threat model review (P1-01.3)

Against CLAUDE.md §8.

| Threat | Under this model |
|---|---|
| External attacker | No unauthenticated access to any resource. App Check (P0-10) raises the cost of scripted access. |
| Malicious user | `stranger` has no access to another user's anything. The previous global read is closed. |
| **Malicious helper** | The threat this model is shaped around. A responder gets a fuzzed projection, never the raw alert, never a phone number, never evidence; precise location only after accepting *and* proving proximity; access ends with the alert; every reveal is logged and attributable. |
| Compromised account | Blast radius is that account's own data plus projections for alerts she was actually selected for. Previously: the entire user base. |
| Compromised admin | **Still the weakest point.** §6 is the mitigation and it is not yet implemented. |
| Device compromise | Out of scope here — covered by P1-05 (notification privacy) and P4-01 (safety check redesign). |
| Insider threat | Same as compromised admin. §6. |
| API abuse | Rate limiting in P1-14/P1-15. Enumeration is closed by removing collection-wide reads. |
| **Location abuse** | Background location writes stop entirely (P0-08). Location is captured at SOS time, attached to the alert, fuzzed in projections, released precisely only under §4 conditions, and every release is logged. |

Two threats are not closed by this document: **compromised admin** (needs §6
implemented) and **device compromise** (needs P1-05 and P4-01). Everything else
is addressed by the model, subject to the implementation landing.
