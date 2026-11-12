# Notification consent and acknowledgment review

Draft only, 2026-10-25. No external delivery is activated. An earlier preference
for provider SMS identifies a candidate fallback channel; it does not approve
sending messages, a provider, a template or a timing policy.

## Separate facts

| Event | What it proves | What it must not imply |
| --- | --- | --- |
| Durable alert + task commit | The backend accepted the SOS and scheduled work | Anyone received it or is coming |
| Inbox projection committed | A selected app account can query its permitted view | Push delivered, phone awake, or human acknowledgment |
| Provider accepted request | Provider accepted a particular attempt | Recipient received/read it |
| Authenticated delivery callback | Provider reports transport receipt for that attempt | Human understanding or willingness to help |
| Authenticated recipient acknowledgment | Selected recipient explicitly acknowledged this incident | Owner safe, notification from every channel can stop, or incident resolved |
| Acceptance | Recipient says they intend to help; existing `acceptances` behavior | Keyword verified, owner safe, or escalation cancelled |
| Owner keyword resolution / terminal expiry | Incident follows the established state machine | An already delivered SMS/location can be recalled |

The current code commits inbox work and acceptances. It does not implement the
remaining delivery/acknowledgment states. Never relabel an inbox row as `sent`
or `delivered` in the provider sense.

## Proposed behavior for review

- The owner selects contacts and can inspect which are app-reachable. A label,
  matching display name, or unverified identifier never grants an account
  another person's exact-location audience.
- Capture recipient channel consent and verification separately from the
  owner's choice of contact. Review who may opt in/out, how shared/recycled
  numbers are handled, and what happens when verification expires. No consent
  is inferred from merely being listed as an emergency contact.
- Acknowledgment must be authenticated, bound to recipient + immutable incident
  + channel attempt, and idempotent. An inbound webhook alone, caller-selected
  user ID, delivery receipt or URL fetch must not create a human acknowledgment.
- If an approved non-response deadline is reached, transactionally recheck live
  incident state, selected recipient, channel consent and acknowledgment before
  persisting a delivery intent. Keep this separate from the existing owner
  safety-check escalation, which contacts cannot silence.
- A provider dispatcher would claim a leased durable intent, use the same
  provider idempotency key across ambiguous retries, verify callback signatures,
  and deduplicate out-of-order/repeated callbacks. Review the response when a
  provider cannot support idempotency; do not blindly retry possibly sent SMS.
- Recheck terminal state before irreversible dispatch. A provider may already
  have accepted a message when cancellation arrives. Record that ambiguity;
  never promise cancellation recalls a delivered message.
- Templates, links, lock-screen previews, sender identity and escalation copy
  need explicit privacy review. Do not embed exact coordinates, names,
  recordings or safety keywords in SMS by default. Any link must enforce the
  reviewed recipient authorization and lifetime; possession alone is not
  consent to broader data access.
- Failure must remain visible to the owner/operator without claiming help is
  coming. Missing consent or unavailable provider is a distinct outcome from
  no response by a reachable recipient.

## Decisions required

1. Who must consent, verification and opt-out behavior, and treatment of
   contacts without an app account or private phone access.
2. Exact acknowledgment meaning, acceptable waiting period, which selected
   contacts/channels escalate, and how late acknowledgments affect pending
   deliveries. No timeout or recipient quorum is invented here.
3. Provider, country coverage, sender registration, callback authentication,
   idempotency guarantees, outage/cost limits and permitted message template.
4. Retention/erasure of consent, delivery, callback and acknowledgment records,
   including exceptions for incident evidence. No retention duration is assumed.
5. Safe response to partial delivery, all channels unavailable, terminal-state
   races and operator escalation. No real emergency message is sent to test it.
