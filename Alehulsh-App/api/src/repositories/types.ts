/**
 * Swap point #2 of 3. See docs/api-layer.md.
 *
 * Firestore now; PostgreSQL + PostGIS after C-04 (M-05). Handlers depend on
 * these interfaces only, so the migration replaces implementations and leaves
 * the alert state machine, keyword verification and escalation untouched.
 *
 * Shapes follow docs/alert-lifecycle.md.
 */

/**
 * Terminal states are distinct and must stay that way:
 *   resolved  - she confirmed she is safe
 *   cancelled - she withdrew an alert raised in error
 *   expired   - the window elapsed with no answer; a failure signal
 * Collapsing cancelled into resolved would tell contacts the wrong thing.
 */
import type { LocationQuality } from '../domain/location.js';

export type { LocationQuality };

export type AlertStatus = 'active' | 'resolved' | 'cancelled' | 'escalated' | 'expired';

/**
 * Whether an alert has ended, for any reason.
 *
 * Call sites used to spell out `=== 'resolved' || === 'expired'`, which
 * silently excluded 'cancelled' the moment it was added: a withdrawn alert
 * would still have accepted responders, evidence uploads and reveals. One
 * definition means the next terminal state cannot be missed the same way.
 */
export function isTerminalStatus(status: AlertStatus): boolean {
  return status === 'resolved' || status === 'cancelled' || status === 'expired';
}

export interface Alert {
  message?:string;
  isUrgent?:boolean;
  /** The document slot — the owner's uid. One live alert per user. */
  id: string;
  /**
   * This alert instance, unique forever.  (P2-22)
   *
   * `id` is the uid, so it is the same string for every alert she ever raises.
   * Without a separate key, a recording from March and one from June are
   * indistinguishable, and an archived alert has nothing to be addressed by.
   * Everything that needs to point at *one* alert points at this.
   */
  key: string;
  ownerId: string;
  status: AlertStatus;
  createdAt: Date;
  /** Server-stamped. Never the device clock — see alert-lifecycle.md §3. */
  expiresAt: Date;
  latitude: number | null;
  longitude: number | null;
  geohash: string | null;
  /**
   * What the position may be said to be - derived by the SERVER from the
   * evidence, never taken from the client.  (sprint 3)
   *
   * Required, not optional, because "we forgot to set it" and "we do not know
   * how fresh this is" must not look the same to a recipient. 'unavailable'
   * is the only value permitted when latitude/longitude are null, and no
   * other value is permitted when they are not.
   *
   * See src/domain/location.ts for the rules and why the client's own claim
   * is ignored.
   */
  locationQuality: LocationQuality;
  /**
   * How old the fix was when it was taken, per the device. Null when unknown,
   * nonsensical, or when there is no position to describe.
   */
  locationAgeMs?: number | null;
  /**
   * Horizontal accuracy in metres, as the provider reported it. Evidence that
   * a fix is real - never a quality bar, so nothing is discarded for being
   * imprecise. Null when the provider offered none.
   */
  accuracyMeters?: number | null;
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

/**
 * The verified subject has no account on this backend.
 *
 * Lives here rather than in the PostgreSQL module because it is a condition of
 * the repository CONTRACT, not of one implementation: any backend that keeps
 * its own account identifiers can be handed a subject it does not know.
 * Putting it here also lets the HTTP layer map it without importing a specific
 * backend.
 *
 * Deliberately NOT a reason to create an account. An unknown subject is an
 * unknown person, and minting one would attach someone's emergency to a record
 * nobody owns - and would let anyone fill the user table by presenting fresh
 * tokens.
 *
 * Carries no subject value: it reaches logs, and a subject identifies a person.
 */
export class IdentityNotMappedError extends Error {
  constructor() {
    super('identity not mapped');
    this.name = 'IdentityNotMappedError';
  }
}

/**
 * What a caller may assert when raising an alert.
 *
 * Note what is absent: locationQuality. The client sends evidence and the
 * server decides what that evidence supports - see src/domain/location.ts.
 * Adding a quality field here would hand a hostile client the ability to
 * label a two-hour-old position "live".
 */
export interface AlertCreateInput {
  requestId: string;
  ownerId: string;
  latitude: number | null;
  longitude: number | null;
  /** Device-reported trigger time. Stored, never trusted. */
  occurredAt?: Date | null;
  /** How old the fix was, per the device. Evidence, not a decision. */
  locationAgeMs?: number | null;
  /** Horizontal accuracy in metres, as reported. Evidence of measurement. */
  accuracyMeters?: number | null;
}

export interface AlertRepository {
  updateOwnedDetails?(uid:string,id:string,key:string,details:{message?:string;isUrgent?:boolean}):Promise<void>;
  /** Atomically reserves a verification slot. Does not record a wrong answer. */
  admitKeywordVerification(id: string, key: string, cap: number, cooldownMs: number): Promise<boolean>;
  findById(id: string): Promise<Alert | null>;
  findActiveByOwner(ownerId: string): Promise<Alert | null>;
  /**
   * Idempotent — alert-lifecycle.md §7. `created` is false when an alert was
   * already live, so the caller knows not to reschedule the safety check.
   * Re-triggering must not let someone postpone escalation indefinitely.
   */
  create(input: AlertCreateInput): Promise<{ alert: Alert; created: boolean }>;
  /**
   * Attempt a transition, and return the alert AS IT STANDS.
   *
   * The returned status may NOT be `next`: terminal states are final, so a
   * transition against an alert that has already ended does nothing and is
   * not an error - that is what makes a cancel racing a resolve safe.
   *
   * **A caller that is about to do something irreversible must check the
   * returned status**, not assume the transition happened. Notifying contacts
   * after an escalation that silently did not occur tells them about an
   * emergency that is over.
   */
  updateStatus(id: string, next: AlertStatus, fields: Partial<Alert>, expectedKey?: string): Promise<Alert>;
  /** Atomically records a failed keyword, escalates if active, and persists work. */
  failKeywordAttempt(id: string, at: Date, expectedKey?: string): Promise<Alert>;
  /** Records a failed keyword attempt. Never resets. */
  recordFailedAttempt(id: string, at: Date, expectedKey?: string): Promise<Alert>;
  /**
   * Every alert she has raised, newest first, archive included.  (P2-22)
   *
   * A single incident proves little; a pattern over months is what a
   * protection order rests on. The archive is why P2-21's export can show one.
   */
  listHistoryForOwner(ownerUid: string, limit?: number): Promise<Alert[]>;
  /** Every alert she has ever raised, terminal ones included. */
  deleteAllForOwner(ownerUid: string): Promise<number>;
}

export interface UserRecord {
  /** Legacy keyword exists but has not passed the reviewed hash migration. */
  legacyKeywordMigrationRequired?:boolean;
  uid: string;
  /** Hash only. The plaintext keyword never enters this process — CRIT-05. */
  safetyKeywordHash: string | null;
  /**
   * True for users migrated off the shipped default, or who never had one.
   * They cannot resolve until they set a real keyword — see P1-11.
   */
  mustSetKeyword: boolean;
}

/**
 * A pending time-locked keyword reset.  (P1-11.1)
 *
 * See docs/keyword-recovery.md. The short version: the keyword works because
 * it cannot be bypassed, so any recovery she can use under duress is one she
 * can be forced to use. Time is the only lever that does not have that
 * property — a coercer has an evening, not three days.
 */
export interface KeywordReset {
  uid: string;
  requestedAt: Date;
  /** Not before this. The delay IS the defence. */
  eligibleAt: Date;
  /** 'pending' until confirmed, cancelled, or voided by an alert. */
  status: 'pending' | 'confirmed' | 'cancelled' | 'voided_by_alert';
  cancelledAt?: Date;
  cancelledReason?: 'user' | 'alert_raised';
}

export interface KeywordResetRepository {
  findPending(uid: string): Promise<KeywordReset | null>;
  create(reset: KeywordReset): Promise<KeywordReset>;
  update(uid: string, fields: Partial<KeywordReset>): Promise<void>;
  /** Rechecks incident state and reset generation; commits hash and confirmation together. */
  confirm(uid: string, requestedAt: Date, hash: string, now: Date): Promise<void>;
  deleteForUid(uid: string): Promise<number>;
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
  /**
   * Stores a new keyword hash and clears mustSetKeyword. The plaintext never
   * reaches this layer — hashing happens in the route, with the pepper.
   */
  setSafetyKeywordHash(uid: string, hash: string): Promise<void>;
  /** Compare-and-set with the live-incident check inside the same transaction. */
  compareAndSetSafetyKeyword(uid: string, expectedHash: string | null, hash: string): Promise<void>;
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
  /** Server-only provenance. Never included in HTTP/FCM recipient DTOs. */
  contactIdentifierHashes?:string[];
  alertId: string;
  /** Immutable incident identity. Required by Firestore because its slot is reused. */
  alertKey?: string;
  /** Authoritative source deadline attached at read time, never a client TTL. */
  expiresAt?: Date;
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
  remove(recipientUid: string, alertId: string, alertKey?: string): Promise<void>;
  listRecipients(alertId: string): Promise<string[]>;
  /**
   * The authorization surface for P1-10. A projection exists only where the
   * server chose to write one, so "do you hold one?" is the same question as
   * "did we select you for this alert?" — asked without trusting the caller.
   */
  get(recipientUid: string, alertId: string): Promise<AlertProjection | null>;

  /**
   * ONE recipient's own inbox, newest first, bounded by `limit`.  (P1-02)
   *
   * Scoped by argument, not by filter: the recipient is the only way in, so
   * there is no query shape this method can express that returns somebody
   * else's projections. That is what makes it safe to expose through
   * GET /v1/me/inbox, where the uid comes from the verified token.
   *
   * `limit` is required rather than defaulted, so a caller cannot ask for an
   * unbounded read by forgetting an argument - her inbox grows with every
   * alert she is sent.
   *
   * Ordered by `createdAt` descending, and NOT cursor-paginated.
   *
   * Deliberate: `createdAt` alone is not a total order - two alerts in the
   * same millisecond tie, and nothing breaks the tie deterministically - so a
   * `startAfter(createdAt)` cursor could skip or repeat an entry across pages.
   * A stable cursor needs a second ordering key and the composite index that
   * implies, which is a storage-configuration change. Until then this is a
   * bounded first page, which is honest about what it offers.
   */
  listForRecipient(recipientUid: string, limit: number): Promise<AlertProjection[]>;
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
  /** Immutable incident identity; legacy rows without it grant no new access. */
  alertKey?: string;
  alertId: string;
  responderUid: string;
  acceptedAt: Date;
  /** How they were reached. A chosen contact answering is not the same event
   *  as a selected stranger answering, and escalation (P3-06) reads this. */
  audience: 'responder' | 'contact';
}

export interface AcceptanceRepository {
  withdraw?(alertId:string,responderUid:string,incidentKey:string):Promise<void>;
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
/**
 * Why the recording exists — and therefore who may hear it.  (P2-10.4)
 *
 * 'deliberate' means she pressed record and chose to attach it. 'automatic'
 * means the SOS trigger started capturing on its own. The difference is
 * consent: an automatic recording can contain anything that happened to be
 * audible — her address, other people's conversations, a child — and she made
 * no decision to share any of it. A responder hears deliberate notes only.
 */
export type EvidenceKind = 'deliberate' | 'automatic';

export interface EvidenceRecord {
  sha256?: string;
  id: string;
  alertId: string;
  /** Which alert instance. alertId is the uid and cannot tell two apart. */
  alertKey: string;
  /** Gates responder playback. Defaults to the safe value, never the open one. */
  kind: EvidenceKind;
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
  markPublished(id: string, sourcePath: string, publication: import('../evidence/EvidenceStore.js').PublishedEvidence): Promise<EvidenceRecord>;
  create(record: EvidenceRecord): Promise<EvidenceRecord>;
  findById(id: string): Promise<EvidenceRecord | null>;
  listForAlert(alertId: string): Promise<EvidenceRecord[]>;
  /** Everything of hers, for the export (P2-21). */
  listForOwner(ownerUid: string): Promise<EvidenceRecord[]>;
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
