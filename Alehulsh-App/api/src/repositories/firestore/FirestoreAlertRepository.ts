import { randomUUID } from 'node:crypto';
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
/**
 * Terminal alerts, keyed by alert key.  (P2-22)
 *
 * active_alerts holds one document per user, so raising a new SOS used to
 * overwrite the previous one and destroy it. For a woman in a repeated-abuse
 * situation that is exactly the evidence that matters, so the outgoing alert
 * is copied here first, inside the same transaction as the overwrite.
 */
const HISTORY = 'alert_history';

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

      const hasFix = input.latitude !== null && input.longitude !== null;
      const doc: AlertDoc = {
        requestId: input.requestId,
        alertKey: randomUUID(),
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

  async listHistoryForOwner(ownerUid: string, limit = 100): Promise<Alert[]> {
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
