import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import { Timestamp } from 'firebase-admin/firestore';
import type {VerifiedIdentifierSource} from '../../auth/VerifiedIdentifierSource.js';
import {contactProjectionProven} from '../../services/contactProjectionProof.js';
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
  contactIdentifierHashes?:string[];
  alertId: string;
  alertKey?: string;
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

/**
 * Whether a uid can be a Firestore document id at all.
 *
 * Same discipline as FirestoreAlertRepository: a recipient uid is a document
 * path segment here, so a blank one, one containing a slash, or a reserved
 * `__*__` form makes `.doc()` throw or silently address a different path. A
 * real Firebase uid is 28 alphanumerics, so nothing legitimate is refused.
 */
function couldBeRecipientUid(uid: string): boolean {
  if (uid.length === 0) return false;
  if (Buffer.byteLength(uid, 'utf8') > 1500) return false;
  if (/[\u0000-\u001f\u007f]/.test(uid)) return false;
  if (uid.includes('/')) return false;
  if (uid === '.' || uid === '..') return false;
  if (/^__.*__$/.test(uid)) return false;
  return true;
}

function mapProjection(d: ProjectionDoc): AlertProjection {
  return {
    ...(d.contactIdentifierHashes?{contactIdentifierHashes:d.contactIdentifierHashes}:{}),
    alertId: d.alertId,
    ...(d.alertKey ? { alertKey: d.alertKey } : {}),
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

export class FirestoreInboxRepository implements InboxRepository {
  constructor(private readonly db: Firestore,private readonly identifiers?:VerifiedIdentifierSource) {}

  private ref(recipientUid: string, alertId: string) {
    return this.db.collection(ROOT).doc(recipientUid).collection(SUB).doc(alertId);
  }

  async put(recipientUid: string, p: AlertProjection): Promise<void> {
    if (!couldBeRecipientUid(recipientUid) || !couldBeRecipientUid(p.alertId) || !p.alertKey) return;
    const doc: ProjectionDoc = {
      ...(p.contactIdentifierHashes?{contactIdentifierHashes:p.contactIdentifierHashes}:{}),
      alertId: p.alertId,
      alertKey: p.alertKey,
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
    // Reading the source in the write transaction makes a terminal transition
    // or slot replacement conflict and retry before exact coordinates commit.
    await this.db.runTransaction(async (tx) => {
      const source = await tx.get(this.db.collection('active_alerts').doc(p.alertId));
      if (!isLiveSource(source.data(), p.alertKey)) return;
      tx.set(this.ref(recipientUid, p.alertId), doc);
    });
  }

  async remove(recipientUid: string, alertId: string, alertKey?: string): Promise<void> {
    if (!couldBeRecipientUid(recipientUid) || !couldBeRecipientUid(alertId)) return;
    const ref = this.ref(recipientUid, alertId);
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists && (alertKey === undefined || snap.get('alertKey') === alertKey)) tx.delete(ref);
    });
  }

  private async read(recipientUid: string, alertId: string): Promise<AlertProjection | null> {
    if (!couldBeRecipientUid(recipientUid) || !couldBeRecipientUid(alertId)) return null;
    return this.db.runTransaction(async (tx) => {
      const [snap, source] = await Promise.all([
        tx.get(this.ref(recipientUid, alertId)),
        tx.get(this.db.collection('active_alerts').doc(alertId)),
      ]);
      if (!snap.exists) return null;
      const doc = snap.data() as ProjectionDoc;
      return isLiveSource(source.data(), doc.alertKey) ? { ...mapProjection(doc), expiresAt: (source.data()!['expiresAtTimestamp'] as Timestamp).toDate() } : null;
    });
  }
  async get(recipientUid:string,alertId:string):Promise<AlertProjection|null>{
    const projection=await this.read(recipientUid,alertId);
    if(!projection||!await contactProjectionProven(this.identifiers,recipientUid,projection))return null;
    if(!this.identifiers)return projection;
    const current=await this.read(recipientUid,alertId);
    return current&&current.alertKey===projection.alertKey&&current.audience===projection.audience&&
      JSON.stringify(current.contactIdentifierHashes)===JSON.stringify(projection.contactIdentifierHashes)?current:null;
  }

  /**
   * Her own inbox, newest first.
   *
   * One bounded subcollection query plus a source check per result, all in one
   * snapshot. The recipient's uid is the parent path; incident status and key
   * are checked separately so delayed cleanup cannot authorize stale reads.
   *
   * `orderBy('createdAt')` alone needs only the automatic single-field index,
   * so this works with no index configuration change.
   */
  async listForRecipient(recipientUid: string, limit: number): Promise<AlertProjection[]> {
    // A blank or path-breaking uid would throw inside .doc(). An empty inbox
    // is the right answer: it is never another recipient's inbox, and a read
    // must not become a 500.
    if (!couldBeRecipientUid(recipientUid)) return [];

    const projections=await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(this.db.collection(ROOT).doc(recipientUid).collection(SUB)
        .orderBy('createdAt', 'desc')
        .limit(Math.max(1, Math.trunc(limit))));
      const out: AlertProjection[] = [];
      // Check in the SAME snapshot as the projection query. Cleanup may lag,
      // but an ended or replaced incident must never remain an authorized read.
      for (const item of snap.docs) {
        const doc = item.data() as ProjectionDoc;
        if (!couldBeRecipientUid(doc.alertId)) continue;
        const source = await tx.get(this.db.collection('active_alerts').doc(doc.alertId));
        if (isLiveSource(source.data(), doc.alertKey)) out.push({ ...mapProjection(doc), expiresAt: (source.data()!['expiresAtTimestamp'] as Timestamp).toDate() });
      }
      return out;
    });
    if(!this.identifiers)return projections;
    return (await Promise.all(projections.map(p=>this.get(recipientUid,p.alertId)))).filter((p):p is AlertProjection=>p!==null);
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

function isLiveSource(source: DocumentData | undefined, key: string | undefined): boolean {
  if (!source || !key || source['alertKey'] !== key) return false;
  if (source['status'] !== 'active' && source['status'] !== 'escalated') return false;
  const expiry = source['expiresAtTimestamp'];
  return expiry instanceof Timestamp && expiry.toMillis() > Date.now();
}
