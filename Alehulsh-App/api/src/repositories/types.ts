/**
 * Swap point #2 of 3. See docs/api-layer.md.
 *
 * Firestore now; PostgreSQL + PostGIS after C-04 (M-05). Handlers depend on
 * these interfaces only, so the migration replaces implementations and leaves
 * the alert state machine, keyword verification and escalation untouched.
 *
 * Shapes follow docs/alert-lifecycle.md.
 */

export type AlertStatus = 'active' | 'resolved' | 'escalated' | 'expired';

export interface Alert {
  id: string;
  ownerId: string;
  status: AlertStatus;
  createdAt: Date;
  /** Server-stamped. Never the device clock — see alert-lifecycle.md §3. */
  expiresAt: Date;
  latitude: number | null;
  longitude: number | null;
  geohash: string | null;
  resolvedAt?: Date;
  resolvedBy?: 'owner' | 'owner_late';
  escalatedAt?: Date;
  escalationReason?: 'wrong_keyword' | 'no_answer' | 'attempts_exhausted';
  /**
   * When the device says the trigger happened. Device clock, therefore never
   * trusted for any decision — see docs/alert-lifecycle.md §3 and P3-13. It
   * exists only to tell recipients how old the position is.
   */
  deviceReportedAt?: Date;
  /**
   * createdAt - deviceReportedAt, server-computed, null when we cannot tell.
   * A large value means the alert sat in the offline queue and the coordinates
   * describe where she was then, not where she is.
   */
  reportedDelayMs?: number | null;
  /** Failed keyword attempts. A cluster of these is itself evidence. */
  attemptCount: number;
  lastAttemptAt?: Date;
}

export interface AlertRepository {
  findById(id: string): Promise<Alert | null>;
  findActiveByOwner(ownerId: string): Promise<Alert | null>;
  /**
   * Idempotent — alert-lifecycle.md §7. `created` is false when an alert was
   * already live, so the caller knows not to reschedule the safety check.
   * Re-triggering must not let someone postpone escalation indefinitely.
   */
  create(input: {
    requestId: string;
    ownerId: string;
    latitude: number | null;
    longitude: number | null;
    /** Device-reported trigger time. Stored, never trusted. */
    occurredAt?: Date | null;
  }): Promise<{ alert: Alert; created: boolean }>;
  updateStatus(id: string, next: AlertStatus, fields: Partial<Alert>): Promise<Alert>;
  /** Records a failed keyword attempt. Never resets. */
  recordFailedAttempt(id: string, at: Date): Promise<Alert>;
  /** Every alert she has ever raised, terminal ones included. */
  deleteAllForOwner(ownerUid: string): Promise<number>;
}

export interface UserRecord {
  uid: string;
  /** Hash only. The plaintext keyword never enters this process — CRIT-05. */
  safetyKeywordHash: string | null;
  /**
   * True for users migrated off the shipped default, or who never had one.
   * They cannot resolve until they set a real keyword — see P1-11.
   */
  mustSetKeyword: boolean;
}

export interface UserRepository {
  findByUid(uid: string): Promise<UserRecord | null>;
  /**
   * Resolves a hashed phone or email to an account, so the fan-out can reach a
   * contact who has the app without ever handling her raw number (P2-09).
   * Returns null when the contact is not a user — which at launch is most of
   * them, and is exactly what P3-01 §5 has to answer for.
   */
  findUidByIdentifierHash(hash: string): Promise<string | null>;
  deleteByUid(uid: string): Promise<number>;
}

/**
 * One row per contact, not an array element. P2-01 §4: only rows can be
 * individually deleted (C-16), carry consent state (P2-23), and answer
 * "can we reach this person?" (P3-02).
 */
export interface EmergencyContact {
  id: string;
  ownerUid: string;
  /** Raw values are shown back to her; they never leave the server otherwise. */
  name: string;
  phoneHash: string | null;
  emailHash: string | null;
  isPrimary: boolean;
}

/**
 * What a responder actually receives. Never the alert itself — see
 * docs/responder-projection.md §2.
 */
export interface AlertProjection {
  alertId: string;
  displayName: string;
  /** Centre of the alert's precision-7 geohash cell. Never the true position. */
  fuzzedLat: number | null;
  fuzzedLng: number | null;
  fuzzedPrecision: string;
  isUrgent: boolean;
  status: 'active' | 'escalated';
  createdAt: Date;
  /** Whether a voice note exists — not the note. */
  hasVoiceNote: boolean;
  /**
   * How long the alert sat before reaching us, when we can tell. A responder
   * must be able to see that a position is two hours old rather than assume
   * every alert is happening now.
   */
  reportedDelayMs: number | null;
  /** 'responder' sees less than 'contact'. */
  audience: 'responder' | 'contact';
}

export interface InboxRepository {
  /** Idempotent on (recipientUid, alertId). */
  put(recipientUid: string, projection: AlertProjection): Promise<void>;
  remove(recipientUid: string, alertId: string): Promise<void>;
  listRecipients(alertId: string): Promise<string[]>;
  /**
   * The authorization surface for P1-10. A projection exists only where the
   * server chose to write one, so "do you hold one?" is the same question as
   * "did we select you for this alert?" — asked without trusting the caller.
   */
  get(recipientUid: string, alertId: string): Promise<AlertProjection | null>;
}

/**
 * A responder or contact answering an alert.  (P1-10)
 *
 * Deliberately a record of its own rather than a field on the alert. Appending
 * to an array on the alert document is what CRIT-03 exploited: a writer who can
 * append can also overwrite. One row per acceptance, owned by the server, means
 * nobody can rewrite anyone else's.
 *
 * This does NOT change the alert's status. alert-lifecycle.md §6: only she
 * resolves, only the server escalates or expires. A helper on his way is not
 * evidence that she is safe.
 */
export interface Acceptance {
  alertId: string;
  responderUid: string;
  acceptedAt: Date;
  /** How they were reached. A chosen contact answering is not the same event
   *  as a selected stranger answering, and escalation (P3-06) reads this. */
  audience: 'responder' | 'contact';
}

export interface AcceptanceRepository {
  /** Idempotent on (alertId, responderUid) — `created` false on a replay. */
  record(acceptance: Acceptance): Promise<{ acceptance: Acceptance; created: boolean }>;
  findFor(alertId: string, responderUid: string): Promise<Acceptance | null>;
  listForAlert(alertId: string): Promise<Acceptance[]>;
  /** C-16. Acceptances name the responder, so deletion must reach them. */
  deleteAllForResponder(responderUid: string): Promise<number>;
}

/** Active responders whose last known cell falls in one of the given prefixes. */
export interface ResponderLocationRepository {
  findByGeohashPrefixes(prefixes: readonly string[]): Promise<Array<{ uid: string }>>;
}

export interface ContactRepository {
  listByOwner(ownerUid: string): Promise<EmergencyContact[]>;
  deleteAllForOwner(ownerUid: string): Promise<number>;
}

/**
 * Responder eligibility by peer vouching.  (P4-07)
 *
 * ID verification is phase 2 — it needs reviewers we do not have. Vouching
 * substitutes accountability for verification: the voucher is named and is
 * actioned alongside anyone they admitted who causes harm.
 */
export type ResponderStatus =
  /** Vouched for, has not accepted yet. */
  | 'pending'
  /** Accepted. Eligible to receive alerts. */
  | 'active'
  /** Actioned for cause. Their vouches cascade. */
  | 'suspended'
  /** Their voucher was suspended. Not accused of anything — needs a new voucher. */
  | 'needs_revouch';

export interface ResponderRecord {
  uid: string;
  status: ResponderStatus;
  /** null only for the bootstrap set, who have nobody to vouch for them. */
  vouchedBy: string | null;
  vouchedAt: Date | null;
  activatedAt?: Date;
  suspendedAt?: Date;
  suspensionReason?: string;
}

export interface ResponderRepository {
  findByUid(uid: string): Promise<ResponderRecord | null>;
  /** Everyone this person vouched for, for the suspension cascade. */
  findVouchedBy(voucherUid: string): Promise<ResponderRecord[]>;
  /** Counts against the per-voucher cap. */
  countActiveVouchesBy(voucherUid: string): Promise<number>;
  upsert(record: ResponderRecord): Promise<ResponderRecord>;
}

/**
 * Remotely configured client policy.  (P1-26.1)
 *
 * Stored rather than configured by environment variable, because the point is
 * to be able to raise the floor without a restart of a service that is meant to
 * be receiving SOS traffic at the time.
 */
export interface PlatformPolicy {
  /** Below this, the client blocks. Null or unparseable means never block. */
  minVersion: string | null;
  /** Shown as "an update is available". Advisory only. */
  latestVersion: string | null;
}

export interface ClientPolicy {
  android: PlatformPolicy;
  ios: PlatformPolicy;
}

export interface ClientPolicyRepository {
  get(): Promise<ClientPolicy>;
}

/**
 * Which app version each account was last seen on.  (P1-26.3)
 *
 * P1-27 closes direct client writes, and doing that blind would cut off
 * whoever had not updated. This is the measurement that makes it a decision
 * rather than a gamble.
 *
 * Keyed on the account uid, deliberately. No device identifier is introduced —
 * CLAUDE.md §6 — and the uid already exists, so this adds no new way to follow
 * anyone. It stores a version string and a timestamp, nothing else.
 */
export interface VersionTelemetryRepository {
  record(uid: string, platform: 'android' | 'ios', version: string, at: Date): Promise<void>;
  /** uid count per version, for the adoption call. */
  distribution(): Promise<Record<string, number>>;
  deleteForUid(uid: string): Promise<number>;
}

/**
 * A piece of evidence — today always a voice note.  (P2-10.3)
 *
 * The document holds a path and metadata, never bytes. Base64 in the alert
 * document capped total evidence at roughly 90 seconds against Firestore's
 * 1MiB limit, after which the write failed and the recording was lost with no
 * error surfaced to her.
 */
export interface EvidenceRecord {
  id: string;
  alertId: string;
  ownerUid: string;
  storagePath: string;
  contentType: string;
  /** Set once the object is confirmed present. Null means upload never landed. */
  sizeBytes: number | null;
  durationMs: number | null;
  createdAt: Date;
  /** False until the client's PUT is confirmed server-side. */
  uploaded: boolean;
}

export interface EvidenceRepository {
  create(record: EvidenceRecord): Promise<EvidenceRecord>;
  findById(id: string): Promise<EvidenceRecord | null>;
  listForAlert(alertId: string): Promise<EvidenceRecord[]>;
  markUploaded(id: string, sizeBytes: number | null): Promise<EvidenceRecord>;
  deleteAllForOwner(ownerUid: string): Promise<number>;
}

/**
 * One reveal attempt.  (P2-08.3)
 *
 * Append-only, and it records denials as well as grants. A responder working
 * through claimed positions to find her looks exactly like a responder who
 * walked the wrong way — until you can see the sequence. Only the log
 * distinguishes them, so the failures are the part worth keeping.
 */
export interface LocationRevealAttempt {
  alertId: string;
  responderUid: string;
  at: Date;
  /** What they claimed. Unverified — recorded precisely because of that. */
  claimedLat: number;
  claimedLng: number;
  /** Server-computed. Never returned to the caller: see routes/reveal.ts. */
  distanceM: number | null;
  granted: boolean;
  deniedReason?: 'too_far' | 'not_accepted' | 'alert_has_no_location' | 'throttled';
}

export interface LocationRevealRepository {
  /** Append-only. There is no update and no delete by alert. */
  append(attempt: LocationRevealAttempt): Promise<void>;
  /** Attempts by this responder on this alert since `since`, granted or not. */
  countSince(alertId: string, responderUid: string, since: Date): Promise<number>;
  /** The trail for one alert, oldest first. */
  listForAlert(alertId: string): Promise<LocationRevealAttempt[]>;
  /** C-16. Attempts name the responder. */
  deleteAllForResponder(responderUid: string): Promise<number>;
}

/**
 * Everything holding data about a person, so deletion can be exhaustive rather
 * than "the places we remembered". P2-01 §6 and C-16.
 */
export interface DeletableStore {
  /** For logs and the deletion receipt. Never a user-facing string. */
  readonly name: string;
  /** Returns how many records were removed. */
  purge(uid: string): Promise<number>;
}
