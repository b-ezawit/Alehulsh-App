import type { Firestore } from 'firebase-admin/firestore';
import { Timestamp } from 'firebase-admin/firestore';
import type { AlertProjection, InboxRepository } from '../types.js';

/**
 * Interim. Replaced by Postgres at C-04 (M-05) — the interface is the contract.
 *
 * Layout: inbox/{recipientUid}/alerts/{alertId}, per
 * docs/responder-projection.md §5. The recipient's uid is the document path,
 * which is what lets the security rule be a pure ownership check — the thing
 * Firestore can express, unlike "only if you are near this alert".
 */
const ROOT = 'inbox';
const SUB = 'alerts';

interface ProjectionDoc {
  alertId: string;
  displayName: string;
  fuzzedLat: number | null;
  fuzzedLng: number | null;
  fuzzedPrecision: string;
  isUrgent: boolean;
  status: 'active' | 'escalated';
  createdAt: Timestamp;
  hasVoiceNote: boolean;
  reportedDelayMs: number | null;
  audience: 'responder' | 'contact';
}

export class FirestoreInboxRepository implements InboxRepository {
  constructor(private readonly db: Firestore) {}

  private ref(recipientUid: string, alertId: string) {
    return this.db.collection(ROOT).doc(recipientUid).collection(SUB).doc(alertId);
  }

  async put(recipientUid: string, p: AlertProjection): Promise<void> {
    const doc: ProjectionDoc = {
      alertId: p.alertId,
      displayName: p.displayName,
      fuzzedLat: p.fuzzedLat,
      fuzzedLng: p.fuzzedLng,
      fuzzedPrecision: p.fuzzedPrecision,
      isUrgent: p.isUrgent,
      status: p.status,
      createdAt: Timestamp.fromDate(p.createdAt),
      hasVoiceNote: p.hasVoiceNote,
      reportedDelayMs: p.reportedDelayMs,
      audience: p.audience,
    };
    // set, not create: re-running the fan-out must refresh rather than fail,
    // and (recipientUid, alertId) is already the natural key.
    await this.ref(recipientUid, p.alertId).set(doc);
  }

  async remove(recipientUid: string, alertId: string): Promise<void> {
    await this.ref(recipientUid, alertId).delete();
  }

  async get(recipientUid: string, alertId: string): Promise<AlertProjection | null> {
    const snap = await this.ref(recipientUid, alertId).get();
    if (!snap.exists) return null;
    const d = snap.data() as ProjectionDoc;
    return {
      alertId: d.alertId,
      displayName: d.displayName ?? '',
      fuzzedLat: d.fuzzedLat ?? null,
      fuzzedLng: d.fuzzedLng ?? null,
      fuzzedPrecision: d.fuzzedPrecision,
      isUrgent: d.isUrgent === true,
      status: d.status,
      createdAt: d.createdAt.toDate(),
      hasVoiceNote: d.hasVoiceNote === true,
      reportedDelayMs: d.reportedDelayMs ?? null,
      audience: d.audience,
    };
  }

  async listRecipients(alertId: string): Promise<string[]> {
    // Collection-group query across every inbox. Needs the `alerts` group
    // index on alertId — see firestore.indexes.json. Only ever called by the
    // server, to retract an alert when it ends.
    const snap = await this.db.collectionGroup(SUB).where('alertId', '==', alertId).get();
    return snap.docs
      .map((d) => d.ref.parent.parent?.id)
      .filter((id): id is string => typeof id === 'string');
  }
}
