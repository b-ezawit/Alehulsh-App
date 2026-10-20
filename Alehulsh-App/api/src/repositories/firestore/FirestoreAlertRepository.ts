import { randomUUID } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { Timestamp } from 'firebase-admin/firestore';
import { AppError } from '../../errors.js';
import { encodeGeohash } from '../../geo.js';
import { reportedDelayMs } from '../../staleness.js';
import type { Alert, AlertCreateInput, AlertRepository, AlertStatus } from '../types.js';
import { isTerminalStatus } from '../types.js';
import {
  deriveLocationQuality, normalizeLocation, type LocationQuality,
} from '../../domain/location.js';

/**
 * Interim implementation. Replaced by Postgres at C-04 (M-05) — see
 * docs/api-layer.md. The interface is the contract; this file is disposable.
 *
 * Document id is the owner's uid, which is what makes "one active alert per
 * user" a property of the schema rather than of a query.
 */
const COLLECTION = 'active_alerts';
/**
 * Could this string be a Firestore document id for an alert?
 *
 * In THIS repository every `.doc()` is keyed by the owner's uid - the header
 * above says so, and it is what makes "one active alert per user" a property
 * of the schema. So the id here is a Firebase uid, NOT a uuid. The PostgreSQL
 * predicate (32 hex digits) would reject every real id in this collection, so
 * it deliberately is not reused.
 *
 * What is checked are Firestore's own document-id constraints. Measured
 * against the emulator, a malformed id fails in one of two places and neither
 * is a "not found":
 *
 *   doc() throws synchronously   - '' and any id containing '/' mid-string
 *   .get() throws gRPC 3         - '.', '..', and reserved '__*__' ids
 *
 * Either way a caller asking about an id that cannot name a document got an
 * exception where the contract promises null - and for a task that became a
 * 500, indistinguishable from a transient failure, so the worker retried it to
 * `abandoned`.
 *
 * TWO DELIBERATE CHOICES, both stricter than the emulator:
 *
 *   - the 1500-byte limit is enforced here although the emulator accepted
 *     1501 bytes. Production Firestore documents the limit; the emulator being
 *     lenient is not a reason to pass it on.
 *   - the reserved `__*__` pattern is rejected although the emulator accepted
 *     `__id1__` while rejecting `__proto__`. The documented rule is the whole
 *     pattern, and no Firebase uid can match it - they are 28 alphanumerics -
 *     so nothing real is refused.
 *
 * A slash is rejected ANYWHERE, which is stricter than Firestore: it
 * normalises a single leading or trailing slash, so `doc('/victim')` resolves
 * to `active_alerts/victim`. Accepting that alias is wrong on the write path -
 * `create` keyed by '/victim' would store the document at
 * `active_alerts/victim` while writing `userId: '/victim'`, leaving the id and
 * the ownership field disagreeing, and every route authorises on that field.
 * A Firebase uid cannot contain a slash, so nothing real is refused.
 */
function couldBeAlertDocId(id: string): boolean {
  if (id.length === 0) return false;
  if (Buffer.byteLength(id, 'utf8') > 1500) return false;
  // A NUL byte is never a legitimate identifier, and PostgreSQL's equivalent
  // guard rejects it because the column cannot store one. Firestore WILL
  // accept it - measured, `create` wrote a document whose id contained a NUL -
  // so it is rejected here to keep the two backends agreeing and to stop a
  // document being written under an id nothing else can reasonably address.
  if (/[\u0000-\u001f\u007f]/.test(id)) return false;
  // NO SLASH ANYWHERE - deliberately stricter than Firestore.
  //
  // Measured: 'a/b' and '//x' throw, but '/victim' and 'victim/' are
  // NORMALISED to active_alerts/victim. Accepting those aliases would be
  // closer to the backend, and an earlier version of this guard did. It is the
  // wrong call on the WRITE path: `create` keyed by '/victim' stores the
  // document at active_alerts/victim while writing userId: '/victim', so the
  // id and the ownership field disagree - and every route authorises on that
  // field. The owner could then not resolve her own alert.
  //
  // Unlike the PostgreSQL guard, strictness costs nothing here: a Firebase uid
  // is 28 alphanumerics and cannot contain a slash, so no real id is refused.
  if (id.includes('/')) return false;
  if (id === '.' || id === '..') return false;
  if (/^__.*__$/.test(id)) return false;
  return true;
}

/**
 * Terminal alerts, keyed by alert key.  (P2-22)
 *
 * active_alerts holds one document per user, so raising a new SOS used to
 * overwrite the previous one and destroy it. For a woman in a repeated-abuse
 * situation that is exactly the evidence that matters, so the outgoing alert
 * is copied here first, inside the same transaction as the overwrite.
 */
const HISTORY = 'alert_history';

/**
 * The only states an alert may be moved TO.
 *
 * 'active' is absent deliberately: an alert is born active and never returns.
 * Mirrors transition_alert's `p_to NOT IN (...)` check.
 */
const TRANSITION_TARGETS: ReadonlySet<AlertStatus> =
  new Set<AlertStatus>(['escalated', 'resolved', 'cancelled', 'expired']);

interface AlertDoc {
  requestId?: string;
  alertKey?: string;
  userId: string;
  status: AlertStatus;
  createdAt: Timestamp;
  expiresAtTimestamp: Timestamp;
  latitude: number | null;
  longitude: number | null;
  geohash: string | null;
  resolvedAt?: Timestamp;
  resolvedBy?: Alert['resolvedBy'];
  escalatedAt?: Timestamp;
  escalationReason?: Alert['escalationReason'];
  attemptCount?: number;
  lastAttemptAt?: Timestamp;
  deviceReportedAt?: Timestamp;
  reportedDelayMs?: number | null;
  /**
   * Added in sprint 3. Absent on every document written before it, which is
   * why toAlert derives rather than defaults - see there.
   */
  locationQuality?: LocationQuality;
  locationAgeMs?: number | null;
  accuracyMeters?: number | null;
}

function toAlert(id: string, d: AlertDoc): Alert {
  const a: Alert = {
    id,
    // Older documents predate the key. Falling back to the slot id keeps them
    // readable; they simply cannot be told apart, which is the bug this fixes.
    key: d.alertKey ?? id,
    ownerId: d.userId,
    status: d.status,
    createdAt: d.createdAt.toDate(),
    expiresAt: d.expiresAtTimestamp.toDate(),
    latitude: d.latitude ?? null,
    longitude: d.longitude ?? null,
    geohash: d.geohash ?? null,
    // Derived, never defaulted.
    //
    // Documents written before sprint 3 carry no quality at all. Defaulting
    // those to 'live' would invent a freshness claim for every alert in the
    // existing data; defaulting to 'unavailable' would hide positions that
    // are really there. So the quality is recomputed from the evidence the
    // document actually holds, which for an older document means: there is a
    // position but nothing says how old it is -> 'age_unknown'.
    locationQuality: d.locationQuality
      ?? deriveLocationQuality(
        d.latitude ?? null, d.longitude ?? null,
        d.locationAgeMs ?? null, d.accuracyMeters ?? null,
        undefined, d.reportedDelayMs ?? 0,
      ),
    attemptCount: d.attemptCount ?? 0,
  };
  if (d.resolvedAt) a.resolvedAt = d.resolvedAt.toDate();
  if (d.resolvedBy) a.resolvedBy = d.resolvedBy;
  if (d.escalatedAt) a.escalatedAt = d.escalatedAt.toDate();
  if (d.escalationReason) a.escalationReason = d.escalationReason;
  if (d.lastAttemptAt) a.lastAttemptAt = d.lastAttemptAt.toDate();
  a.locationAgeMs = d.locationAgeMs ?? null;
  a.accuracyMeters = d.accuracyMeters ?? null;
  if (d.deviceReportedAt) a.deviceReportedAt = d.deviceReportedAt.toDate();
  a.reportedDelayMs = d.reportedDelayMs ?? null;
  return a;
}

export class FirestoreAlertRepository implements AlertRepository {
  constructor(
    private readonly db: Firestore,
    private readonly activeWindowMs: number,
  ) {}

  /**
   * An alert by id, or null when there is no such alert.
   *
   * A malformed id is "no such alert": it cannot name a document, and the
   * caller's next move is identical either way. Guarded BEFORE `doc()`, which
   * throws synchronously for some of these.
   *
   * Deliberately NOT a try/catch around the fetch. Converting every Firestore
   * error to null would hide an outage behind a 404 - the alert would appear
   * not to exist, a responder would be told to stand down, and nothing would
   * page. Only the id's shape is checked; a real failure still propagates.
   */
  async findById(id: string): Promise<Alert | null> {
    if (!couldBeAlertDocId(id)) return null;
    const snap = await this.db.collection(COLLECTION).doc(id).get();
    const data = snap.data() as AlertDoc | undefined;
    return snap.exists && data ? toAlert(snap.id, data) : null;
  }

  async findActiveByOwner(ownerId: string): Promise<Alert | null> {
    if (!couldBeAlertDocId(ownerId)) return null;
    const alert = await this.findById(ownerId);
    if (!alert) return null;
    return alert.status === 'active' || alert.status === 'escalated' ? alert : null;
  }

  /**
   * Transactional so two concurrent triggers cannot produce two alerts.
   * Idempotent on requestId: a retried request returns the original.
   * A genuine re-trigger while one is live extends rather than duplicating
   * (docs/alert-lifecycle.md §7).
   */
  async create(input: AlertCreateInput): Promise<{ alert: Alert; created: boolean }> {
    // Cannot report absence - it is creating. A malformed owner id is a bad
    // request, so that is what it raises. (PostgreSQL raises
    // IdentityNotMappedError here instead, because it has an identity map to
    // miss; Firestore has none, and 'not found' would be a lie about a create.)
    if (!couldBeAlertDocId(input.ownerId)) {
      throw new AppError('invalid_request', 'owner id cannot name a document');
    }
    const ref = this.db.collection(COLLECTION).doc(input.ownerId);
    const now = new Date();

    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const existing = snap.exists ? (snap.data() as AlertDoc) : undefined;

      if (existing && (existing.status === 'active' || existing.status === 'escalated')) {
        // Pure retry, or a re-trigger. Either way, one alert.
        return { alert: toAlert(ref.id, existing), created: false };
      }

      // A terminal alert is about to be overwritten. Copy it to the archive
      // FIRST, in this transaction, so there is no window where the only copy
      // has been replaced. Losing an alert here is losing her evidence.
      if (existing) {
        const previous = toAlert(ref.id, existing);
        tx.set(this.db.collection(HISTORY).doc(previous.key), {
          ...existing,
          alertKey: previous.key,
          archivedAt: Timestamp.fromDate(now),
        });
      }

      // The same normalisation the Postgres path applies, from the same
      // module, so the two backends cannot disagree about what a position is.
      // An unusable coordinate - including a bare (0,0) - becomes no position
      // rather than a pin in the Gulf of Guinea.
      // The transit delay is passed in, so an alert replayed from the offline
      // queue is not labelled fresh on the strength of how old the fix was
      // when the device took it. Same rule as the PostgreSQL path.
      const fix = normalizeLocation({
        ...input,
        queuedDelayMs: reportedDelayMs(now, input.occurredAt ?? null),
      });
      const hasFix = fix.latitude !== null && fix.longitude !== null;
      const doc: AlertDoc = {
        requestId: input.requestId,
        alertKey: randomUUID(),
        userId: input.ownerId,
        status: 'active',
        // Server clock. Never the device's — docs/alert-lifecycle.md §3.
        createdAt: Timestamp.fromDate(now),
        expiresAtTimestamp: Timestamp.fromDate(new Date(now.getTime() + this.activeWindowMs)),
        latitude: fix.latitude,
        longitude: fix.longitude,
        geohash: hasFix ? encodeGeohash(fix.latitude!, fix.longitude!) : null,
        locationQuality: fix.quality,
        locationAgeMs: fix.ageMs,
        accuracyMeters: fix.accuracyMeters,
        attemptCount: 0,
        // Stored as reported, plus the delay we computed from it. Neither is
        // ever consulted for expiry — that is the server clock above, which is
        // what lets a queued alert dispatch instead of arriving pre-expired.
        ...(input.occurredAt ? { deviceReportedAt: Timestamp.fromDate(input.occurredAt) } : {}),
        reportedDelayMs: reportedDelayMs(now, input.occurredAt ?? null),
      };
      tx.set(ref, doc);
      return { alert: toAlert(ref.id, doc), created: true };
    });
  }

  /**
   * Attempt a transition. Returns the alert AS IT STANDS - see the interface.
   *
   * The guard below mirrors `transition_alert` (0004) rule for rule, because
   * two backends that disagree about when an alert may escalate is worse than
   * either rule on its own. Verified against the real emulator: before this,
   * a RESOLVED alert could be moved back to 'escalated' with `escalatedAt`
   * written. The PostgreSQL path refused that write; this one did not.
   *
   * Why it matters, not just that it is inconsistent: an escalation is what
   * tells her emergency contacts. Re-escalating an alert she has already
   * resolved tells them about an emergency that is over - and the handler that
   * would do it is the safety-check task, which runs on a timer after she has
   * put her phone down.
   *
   * ATOMICITY: the read and the write are both inside `runTransaction`.
   * Firestore aborts and retries the transaction if a document read inside it
   * changed before commit, so the status cannot go terminal between the check
   * and the write. A read outside the transaction followed by an
   * unconditional write would NOT be safe, which is why this stays here.
   */
  async updateStatus(id: string, next: AlertStatus, fields: Partial<Alert>): Promise<Alert> {
    // Matches transition_alert's first rule, which RAISES rather than
    // returning false: a target of 'active' is a programming error, not a
    // race. No caller does this; the check exists so none can start.
    if (!TRANSITION_TARGETS.has(next)) {
      throw new AppError('invalid_request', `unsupported transition target ${next}`);
    }
    // This method returns Alert, so null is not available. It uses THIS
    // repository's established missing-alert signal - the same
    // AppError('not_found') raised below when the document does not exist.
    // (PostgreSQL throws AlertNotFoundError, which is defined in its own
    // module; importing it here would couple the two backends for no gain.
    // Both are 4xx refusals carrying no detail.)
    if (!couldBeAlertDocId(id)) throw new AppError('not_found', 'alert not found');

    const ref = this.db.collection(COLLECTION).doc(id);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new AppError('not_found', `alert ${id} missing`);

      const current = snap.data() as AlertDoc;

      // Terminal states are final. NOT an error: a cancel racing a resolve,
      // or a queued safety check arriving after she resolved, are both normal.
      // The caller is told what the alert actually is and decides from there.
      if (isTerminalStatus(current.status)) {
        return toAlert(id, current);
      }

      // No double escalation. transition_alert refuses escalated -> escalated,
      // so a redelivered safety check cannot overwrite the original
      // escalatedAt and reason with a later one.
      if (next === 'escalated' && current.status === 'escalated') {
        return toAlert(id, current);
      }

      const patch: Record<string, unknown> = { status: next };
      if (fields.resolvedAt) patch['resolvedAt'] = Timestamp.fromDate(fields.resolvedAt);
      if (fields.resolvedBy) patch['resolvedBy'] = fields.resolvedBy;
      if (fields.escalatedAt) patch['escalatedAt'] = Timestamp.fromDate(fields.escalatedAt);
      if (fields.escalationReason) patch['escalationReason'] = fields.escalationReason;
      tx.update(ref, patch);
      return toAlert(id, { ...current, ...patch } as AlertDoc);
    });
  }

  async recordFailedAttempt(id: string, at: Date): Promise<Alert> {
    if (!couldBeAlertDocId(id)) throw new AppError('not_found', 'alert not found');
    const ref = this.db.collection(COLLECTION).doc(id);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new AppError('not_found', `alert ${id} missing`);
      const current = snap.data() as AlertDoc;
      const patch = {
        attemptCount: (current.attemptCount ?? 0) + 1,
        lastAttemptAt: Timestamp.fromDate(at),
      };
      tx.update(ref, patch);
      return toAlert(id, { ...current, ...patch });
    });
  }

  async listHistoryForOwner(ownerUid: string, limit = 100): Promise<Alert[]> {
    if (!couldBeAlertDocId(ownerUid)) return [];
    // The live slot plus the archive. The slot holds the most recent alert,
    // which has not been archived yet because nothing has replaced it.
    const [current, archived] = await Promise.all([
      this.db.collection(COLLECTION).doc(ownerUid).get(),
      this.db.collection(HISTORY).where('userId', '==', ownerUid)
        .orderBy('createdAt', 'desc').limit(limit).get(),
    ]);

    const out: Alert[] = [];
    if (current.exists) out.push(toAlert(ownerUid, current.data() as AlertDoc));
    for (const d of archived.docs) {
      out.push(toAlert(ownerUid, d.data() as AlertDoc));
    }
    return out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, limit);
  }

  async deleteAllForOwner(ownerUid: string): Promise<number> {
    // Never returns 0 for a malformed id: on a privacy operation "we deleted
    // everything" and "that id cannot name anything" must not look the same.
    if (!couldBeAlertDocId(ownerUid)) {
      throw new AppError('invalid_request', 'owner id cannot name a document');
    }
    // Document id is the owner uid, plus any legacy duplicates keyed otherwise.
    let removed = 0;
    const own = this.db.collection(COLLECTION).doc(ownerUid);
    if ((await own.get()).exists) { await own.delete(); removed++; }

    const strays = await this.db.collection(COLLECTION).where('userId', '==', ownerUid).get();
    for (const doc of strays.docs) {
      if (doc.id === ownerUid) continue;
      await doc.ref.delete();
      removed++;
    }

    // The archive too. Adding history without adding this would have made
    // deletion quietly incomplete — she asks for her data to be gone and every
    // alert she ever raised stays behind (C-16).
    const archived = await this.db.collection(HISTORY).where('userId', '==', ownerUid).get();
    for (let i = 0; i < archived.docs.length; i += 400) {
      const batch = this.db.batch();
      for (const d of archived.docs.slice(i, i + 400)) batch.delete(d.ref);
      await batch.commit();
      removed += Math.min(400, archived.docs.length - i);
    }
    return removed;
  }
}
