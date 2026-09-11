import type { Firestore } from 'firebase-admin/firestore';
import { Timestamp } from 'firebase-admin/firestore';
import { AppError } from '../../errors.js';
import { encodeGeohash } from '../../geo.js';
import { reportedDelayMs } from '../../staleness.js';
import type { Alert, AlertRepository, AlertStatus } from '../types.js';

/**
 * Interim implementation. Replaced by Postgres at C-04 (M-05) — see
 * docs/api-layer.md. The interface is the contract; this file is disposable.
 *
 * Document id is the owner's uid, which is what makes "one active alert per
 * user" a property of the schema rather than of a query.
 */
const COLLECTION = 'active_alerts';

interface AlertDoc {
  requestId?: string;
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
}

function toAlert(id: string, d: AlertDoc): Alert {
  const a: Alert = {
    id,
    ownerId: d.userId,
    status: d.status,
    createdAt: d.createdAt.toDate(),
    expiresAt: d.expiresAtTimestamp.toDate(),
    latitude: d.latitude ?? null,
    longitude: d.longitude ?? null,
    geohash: d.geohash ?? null,
    attemptCount: d.attemptCount ?? 0,
  };
  if (d.resolvedAt) a.resolvedAt = d.resolvedAt.toDate();
  if (d.resolvedBy) a.resolvedBy = d.resolvedBy;
  if (d.escalatedAt) a.escalatedAt = d.escalatedAt.toDate();
  if (d.escalationReason) a.escalationReason = d.escalationReason;
  if (d.lastAttemptAt) a.lastAttemptAt = d.lastAttemptAt.toDate();
  if (d.deviceReportedAt) a.deviceReportedAt = d.deviceReportedAt.toDate();
  a.reportedDelayMs = d.reportedDelayMs ?? null;
  return a;
}

export class FirestoreAlertRepository implements AlertRepository {
  constructor(
    private readonly db: Firestore,
    private readonly activeWindowMs: number,
  ) {}

  async findById(id: string): Promise<Alert | null> {
    const snap = await this.db.collection(COLLECTION).doc(id).get();
    const data = snap.data() as AlertDoc | undefined;
    return snap.exists && data ? toAlert(snap.id, data) : null;
  }

  async findActiveByOwner(ownerId: string): Promise<Alert | null> {
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
  async create(input: {
    requestId: string;
    ownerId: string;
    latitude: number | null;
    longitude: number | null;
    occurredAt?: Date | null;
  }): Promise<{ alert: Alert; created: boolean }> {
    const ref = this.db.collection(COLLECTION).doc(input.ownerId);
    const now = new Date();

    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const existing = snap.exists ? (snap.data() as AlertDoc) : undefined;

      if (existing && (existing.status === 'active' || existing.status === 'escalated')) {
        // Pure retry, or a re-trigger. Either way, one alert.
        return { alert: toAlert(ref.id, existing), created: false };
      }

      const hasFix = input.latitude !== null && input.longitude !== null;
      const doc: AlertDoc = {
        requestId: input.requestId,
        userId: input.ownerId,
        status: 'active',
        // Server clock. Never the device's — docs/alert-lifecycle.md §3.
        createdAt: Timestamp.fromDate(now),
        expiresAtTimestamp: Timestamp.fromDate(new Date(now.getTime() + this.activeWindowMs)),
        latitude: input.latitude,
        longitude: input.longitude,
        geohash: hasFix ? encodeGeohash(input.latitude!, input.longitude!) : null,
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

  async updateStatus(id: string, next: AlertStatus, fields: Partial<Alert>): Promise<Alert> {
    const ref = this.db.collection(COLLECTION).doc(id);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new AppError('not_found', `alert ${id} missing`);
      const patch: Record<string, unknown> = { status: next };
      if (fields.resolvedAt) patch['resolvedAt'] = Timestamp.fromDate(fields.resolvedAt);
      if (fields.resolvedBy) patch['resolvedBy'] = fields.resolvedBy;
      if (fields.escalatedAt) patch['escalatedAt'] = Timestamp.fromDate(fields.escalatedAt);
      if (fields.escalationReason) patch['escalationReason'] = fields.escalationReason;
      tx.update(ref, patch);
      return toAlert(id, { ...(snap.data() as AlertDoc), ...patch } as AlertDoc);
    });
  }

  async recordFailedAttempt(id: string, at: Date): Promise<Alert> {
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

  async deleteAllForOwner(ownerUid: string): Promise<number> {
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
    return removed;
  }
}
