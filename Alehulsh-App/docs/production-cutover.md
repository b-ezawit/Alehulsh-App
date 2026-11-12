# Coordinated API-only cutover

This operator procedure is not deployment approval. The active `firebase.json`
and `firestore.rules` stay unchanged. `firebase.api-only.json` selects the final
SDK-denial candidate, separately from the older alert-only closed rules stage.

## Preconditions and validation

1. Verify the exact Cloudflare account, script/version, routing, API origin and
   bindings. DNS resolution or a Cloudflare edge block is not API health. Hono
   serves `/healthz` before authentication; do not disable protections to get
   HTTP 200. Inspect deployments and existing resources before proposing changes.
2. Obtain approval for precise development migrations/resources and synthetic
   hosted fixture writes. Apply only reviewed unapplied migrations with their
   checksums. Do not bypass migration 0022's Auth ownership/grant precondition.
   Use a restricted runtime login, verified origin TLS and no Hyperdrive query
   caching. Never deploy the operator database credential as request identity.
3. Recover the existing authoritative pepper from its owner/secret manager.
   Do not replace it with JWT_SECRET or a generated value. Link existing users
   only through the reviewed migration protocol, never matching identifiers
   alone. Legacy plaintext presence is not permission to reset a keyword.
4. An authorized Google IAM operator must approve revocation of the exposed
   service-account key and installation of a replacement with only required FCM
   sending permissions. This procedure does not rotate credentials or use the
   exposed key. Keep private delivery off pending reviewed consent and delivery
   approval; a Worker setting does not configure legacy Firebase Functions.
5. Review consent/escalation, retention/erasure, location privacy, release
   identity, processing latency/capacity and incident-response ownership. No
   SMS activation, erasure interval or legal-compliance assumption is implied.
6. Run local compatibility and final-denial rules tests, the complete synthetic
   A/B/C emergency scenario, and isolated hosted Auth/Hyperdrive/R2 integration
   once its fixture writes and cleanup are approved. Automated dispatch remains
   simulated. Real push testing requires separately authorized test devices.
7. Validate a genuinely signed release, upgrade path, package identity, merged
   permissions/backup policy, selected configuration and physical Android
   process death, reboot, network loss, expired sessions, Keystore failures and
   OEM limits. Keep unsupported power-key detection disabled. Verify receipt,
   opening and acknowledgment independently of provider acceptance.
8. Verify supported-client adoption, reviewed account/incident migration and
   pending SOS/evidence continuity. Rehearse backup restoration, queue recovery,
   monitoring alerts and the operator response. Logging alone is not an alarm.

## Approved activation sequence

1. Make the verified API/Auth deployment available while retaining tested
   compatibility. Publishing and data migration need separate approval; verify
   client adoption before closing old paths. Do not strand an active SOS.
2. Set `ALEHULSH_DATA_ACCESS=trusted_api` in the **legacy Firebase Functions
   environment** and deploy its reviewed guard code under explicit approval.
   That suppresses creation, closure and deletion topic sends; expiry
   reconciliation continues. The unset default preserves current beta behavior.
   Malformed explicit modes cannot restore public broadcasts.
3. In the same reviewed cutover, deploy only the reviewed rules selected by
   `firebase.api-only.json`. They deny direct SDK reads and writes, including
   plaintext profiles, keyword edits, contacts, mutable owner slots and inbox
   projections. Trusted SDKs bypass rules, so API authorization remains
   mandatory. Do not activate before replacement account/emergency flows pass
   hosted and device gates. The target manifest does not deploy Functions.
4. Enable private provider delivery only with its approved credentials and
   consent configuration. Verify no public topic receives incident metadata
   and that stale events cannot affect a new incident. Monitor backlog/failures.
5. Retire compatibility resources only when reconciliation and policy allow.
   Neither candidate rules nor the topic guard deletes records. Plaintext
   cleanup needs its own reviewed data migration/erasure operation.

## Rollback boundaries

Before activation, retain the current deployment/rules; local candidates change
no hosted state. After activation, roll back only to a previously verified secure
API/client version compatible with the additive schema. Preserve immutable
incident identities, terminal state, pending outboxes, session revocation and
evidence references. Do not reopen weak SDK rules, recreate owner slots, restore
plaintext authorization, hard-delete evidence or silently switch providers.

Approve and rehearse the supported rollback artifact, schema compatibility,
incident reconciliation and emergency continuity procedure before cutover. Halt
activation if those cannot be demonstrated; no automatic downgrade is implied.
