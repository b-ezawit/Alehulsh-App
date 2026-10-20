-- 0001_init — core schema for the Supabase/Postgres target.
--
-- Synthetic/local use only. Nothing here has run against a hosted project.
--
-- Design rules carried over from the Firestore era, each fixing a defect
-- found in the audit:
--   * location is NULLABLE and its quality is constrained to agree with it,
--     so no row can assert a position it does not have (the old code
--     substituted Addis Ababa city centre);
--   * expires_at is server-stamped, so an alert queued offline past the
--     window is not silently discarded by a client-side clock;
--   * one live alert per owner is a database constraint, not app logic;
--   * evidence survives cancellation - only account deletion removes it.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid only

CREATE TYPE alert_status  AS ENUM ('active','escalated','resolved','cancelled','expired');
CREATE TYPE audience_kind AS ENUM ('contact','responder');
CREATE TYPE loc_quality   AS ENUM ('live','stale','age_unknown','unavailable');
CREATE TYPE notify_state  AS ENUM ('queued','sent','delivered','failed','abandoned');
CREATE TYPE outbox_state  AS ENUM ('pending','claimed','published','failed','abandoned');
CREATE TYPE evidence_state AS ENUM ('pending_upload','stored','invalid','purge_pending');

-- ---------------------------------------------------------------------------
-- users
--
-- id is an internal uuid, NOT a Firebase uid. Firebase uids are 28-character
-- strings and are not uuids, so they are mapped rather than reused; see
-- identity_map below. Nothing is assumed about Supabase accepting a foreign id.
-- ---------------------------------------------------------------------------
CREATE TABLE users (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    display_name      text NOT NULL DEFAULT '',
    -- Her address, as she gave it. Never derived from a GPS fix.
    home_address      text NOT NULL DEFAULT '',
    phone_e164        text,
    phone_verified_at timestamptz,
    -- Set ONLY by the server after OTP. Clients have no grant on these.
    phone_hash        text,
    email_hash        text,
    keyword_hash      text,
    keyword_algo      text NOT NULL DEFAULT 'scrypt',
    must_set_keyword  boolean NOT NULL DEFAULT true,
    created_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT phone_hash_requires_verification
        CHECK (phone_hash IS NULL OR phone_verified_at IS NOT NULL)
);
-- Uniqueness is what stops a planted collision displacing the real contact.
CREATE UNIQUE INDEX users_phone_hash_uq ON users (phone_hash) WHERE phone_hash IS NOT NULL;
CREATE UNIQUE INDEX users_email_hash_uq ON users (email_hash) WHERE email_hash IS NOT NULL;

-- Firebase uid -> internal uuid. Populated by migration, never by clients.
CREATE TABLE identity_map (
    firebase_uid text PRIMARY KEY,
    user_id      uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    migrated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- emergency_contacts
-- contact_user_id is the ONLY identity. Labels and phone strings are not.
-- ---------------------------------------------------------------------------
CREATE TABLE emergency_contacts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label           text NOT NULL DEFAULT '',
    phone_e164      text NOT NULL,
    contact_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    linked_at       timestamptz,
    is_primary      boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (owner_id, phone_e164),
    CONSTRAINT link_requires_timestamp
        CHECK ((contact_user_id IS NULL) = (linked_at IS NULL)),
    CONSTRAINT contact_is_not_owner
        CHECK (contact_user_id IS NULL OR contact_user_id <> owner_id)
);
CREATE INDEX emergency_contacts_owner_idx ON emergency_contacts (owner_id);

-- ---------------------------------------------------------------------------
-- alerts
-- ---------------------------------------------------------------------------
CREATE TABLE alerts (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_id         text NOT NULL,
    status             alert_status NOT NULL DEFAULT 'active',
    location           geography(Point,4326),
    location_quality   loc_quality NOT NULL DEFAULT 'unavailable',
    location_age_ms    bigint,
    accuracy_m         double precision,
    created_at         timestamptz NOT NULL DEFAULT now(),
    expires_at         timestamptz NOT NULL,
    escalated_at       timestamptz,
    escalation_reason  text,
    ended_at           timestamptz,
    end_reason         alert_status,
    device_reported_at timestamptz,
    reported_delay_ms  bigint,
    attempt_count      int NOT NULL DEFAULT 0,
    last_attempt_at    timestamptz,

    CONSTRAINT request_id_length CHECK (char_length(request_id) BETWEEN 8 AND 128),
    UNIQUE (owner_id, request_id),

    -- A row may never claim a position it does not hold, in either direction.
    CONSTRAINT location_quality_agrees CHECK (
        (location IS NULL     AND location_quality  = 'unavailable') OR
        (location IS NOT NULL AND location_quality <> 'unavailable')
    ),
    CONSTRAINT age_not_negative CHECK (location_age_ms IS NULL OR location_age_ms >= 0),
    CONSTRAINT accuracy_positive CHECK (accuracy_m IS NULL OR accuracy_m > 0),
    -- 'live' is a claim about freshness and needs an age to justify it.
    CONSTRAINT live_requires_age CHECK (location_quality <> 'live' OR location_age_ms IS NOT NULL),

    -- Terminal states carry a timestamp and a reason; live states carry neither.
    CONSTRAINT terminal_consistent CHECK (
        (status IN ('active','escalated') AND ended_at IS NULL AND end_reason IS NULL) OR
        (status IN ('resolved','cancelled','expired')
            AND ended_at IS NOT NULL AND end_reason = status)
    ),
    CONSTRAINT expiry_after_creation CHECK (expires_at > created_at)
);

-- One live alert per owner. This is the duplicate-SOS guard.
CREATE UNIQUE INDEX alerts_one_live_per_owner
    ON alerts (owner_id) WHERE status IN ('active','escalated');
-- Responder proximity (ST_DWithin). Partial: a terminal alert is never matched.
CREATE INDEX alerts_location_gix ON alerts USING GIST (location)
    WHERE location IS NOT NULL AND status IN ('active','escalated');
-- Expiry sweep.
CREATE INDEX alerts_expiry_idx ON alerts (expires_at) WHERE status IN ('active','escalated');

CREATE TABLE alert_history (
    id          bigserial PRIMARY KEY,
    alert_id    uuid NOT NULL,
    owner_id    uuid NOT NULL,
    from_status alert_status,
    to_status   alert_status NOT NULL,
    actor       text NOT NULL,
    reason      text,
    at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alert_history_alert_idx ON alert_history (alert_id);

-- ---------------------------------------------------------------------------
-- inbox — the per-recipient projection. Holding one is the authorization
-- to accept; it is never writable by a client.
-- ---------------------------------------------------------------------------
CREATE TABLE inbox (
    recipient_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    alert_id     uuid NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    audience     audience_kind NOT NULL,
    projection   jsonb NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (recipient_id, alert_id)
);
CREATE INDEX inbox_alert_idx ON inbox (alert_id);

CREATE TABLE acceptances (
    alert_id     uuid NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    responder_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    audience     audience_kind NOT NULL,
    accepted_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (alert_id, responder_id)
);

-- ---------------------------------------------------------------------------
-- evidence — metadata only. Bytes live in R2; r2_key never reaches a client.
-- ON DELETE RESTRICT so cancelling or resolving cannot destroy evidence.
-- Account deletion is an ordered workflow that clears these first.
-- ---------------------------------------------------------------------------
CREATE TABLE evidence (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_id      uuid NOT NULL REFERENCES alerts(id) ON DELETE RESTRICT,
    owner_id      uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    r2_key        text NOT NULL UNIQUE,
    state         evidence_state NOT NULL DEFAULT 'pending_upload',
    content_type  text NOT NULL,
    size_bytes    bigint,
    declared_sha256 text,
    actual_sha256   text,
    -- Only deliberate notes are ever released to a responder.
    deliberate    boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now(),
    completed_at  timestamptz,
    purge_after   timestamptz,
    CONSTRAINT stored_requires_checksum
        CHECK (state <> 'stored' OR (actual_sha256 IS NOT NULL AND completed_at IS NOT NULL)),
    CONSTRAINT size_sane CHECK (size_bytes IS NULL OR (size_bytes > 0 AND size_bytes <= 104857600))
);
CREATE INDEX evidence_alert_idx ON evidence (alert_id);
-- Orphan sweep: uploads that never completed.
CREATE INDEX evidence_stale_uploads_idx ON evidence (created_at) WHERE state = 'pending_upload';
-- Retryable purge queue for objects whose R2 deletion has not been confirmed.
CREATE INDEX evidence_purge_idx ON evidence (purge_after) WHERE state = 'purge_pending';

CREATE TABLE reveal_log (
    id        bigserial PRIMARY KEY,
    alert_id  uuid NOT NULL,
    actor_id  uuid NOT NULL,
    evidence_id uuid,
    granted   boolean NOT NULL,
    reason    text,
    at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reveal_log_alert_idx ON reveal_log (alert_id);

-- ---------------------------------------------------------------------------
-- notification_attempts — three distinguishable facts, never conflated:
--   sent      = the provider accepted it
--   delivered = a device reported receipt
--   (a human acting is an `acceptances` row, deliberately a different table)
-- ---------------------------------------------------------------------------
CREATE TABLE notification_attempts (
    id           bigserial PRIMARY KEY,
    alert_id     uuid NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    recipient_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel      text NOT NULL,
    attempt_no   int  NOT NULL DEFAULT 1,
    state        notify_state NOT NULL DEFAULT 'queued',
    provider_message_id text,
    sent_at      timestamptz,
    delivered_at timestamptz,
    last_error   text,
    UNIQUE (alert_id, recipient_id, channel, attempt_no),
    CONSTRAINT sent_requires_evidence
        CHECK (state <> 'sent' OR sent_at IS NOT NULL),
    -- Delivery is a device's word, never inferred from a send receipt.
    CONSTRAINT delivered_requires_receipt
        CHECK (state <> 'delivered' OR delivered_at IS NOT NULL)
);
-- At most one attempt in flight per recipient+channel.
CREATE UNIQUE INDEX notification_one_live_attempt
    ON notification_attempts (alert_id, recipient_id, channel)
    WHERE state IN ('queued','sent');

-- ---------------------------------------------------------------------------
-- outbox — durable work, written in the SAME transaction as the alert.
-- Nothing is published to an external queue before this row is committed.
-- ---------------------------------------------------------------------------
CREATE TABLE outbox (
    id            bigserial PRIMARY KEY,
    dedupe_key    text NOT NULL UNIQUE,
    alert_id      uuid NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    recipient_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel       text NOT NULL,
    attempt_no    int  NOT NULL DEFAULT 1,
    payload       jsonb NOT NULL,
    state         outbox_state NOT NULL DEFAULT 'pending',
    claimed_by    text,
    claimed_until timestamptz,
    attempts      int NOT NULL DEFAULT 0,
    max_attempts  int NOT NULL DEFAULT 5,
    next_retry_at timestamptz NOT NULL DEFAULT now(),
    last_error    text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    published_at  timestamptz,
    CONSTRAINT claim_has_lease
        CHECK ((state <> 'claimed') OR (claimed_by IS NOT NULL AND claimed_until IS NOT NULL))
);
-- The dispatcher's claim query; nothing else scans this table hot.
CREATE INDEX outbox_claimable_idx ON outbox (next_retry_at)
    WHERE state IN ('pending','claimed');
