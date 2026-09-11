import type {
  Alert, AlertProjection, AlertRepository, AlertStatus, ContactRepository,
  Acceptance, AcceptanceRepository,
  EmergencyContact, InboxRepository, ResponderLocationRepository,
  ResponderRecord, ResponderRepository, UserRecord, UserRepository,
} from '../src/repositories/types.js';
import type { TokenVerifier } from '../src/auth/TokenVerifier.js';

export const OWNER = 'alice_uid';
export const STRANGER = 'bob_uid';
export const ACTIVE_WINDOW = 2 * 60 * 60 * 1000;
export const SAFETY_DELAY = 2 * 60 * 1000;
export const PEPPER = 'pepper-for-tests-only';

export class FakeAlertRepository implements AlertRepository {
  readonly store = new Map<string, Alert>();
  createCalls = 0;

  async findById(id: string) { return this.store.get(id) ?? null; }

  async findActiveByOwner(ownerId: string) {
    const a = this.store.get(ownerId);
    return a && (a.status === 'active' || a.status === 'escalated') ? a : null;
  }

  async create(input: { requestId: string; ownerId: string; latitude: number | null; longitude: number | null }) {
    this.createCalls++;
    const existing = this.store.get(input.ownerId);
    if (existing && (existing.status === 'active' || existing.status === 'escalated')) {
      return { alert: existing, created: false };
    }
    const now = new Date();
    const alert: Alert = {
      id: input.ownerId,
      ownerId: input.ownerId,
      status: 'active',
      createdAt: now,
      expiresAt: new Date(now.getTime() + ACTIVE_WINDOW),
      latitude: input.latitude,
      longitude: input.longitude,
      geohash: input.latitude !== null ? 'sc04zjw4b' : null,
      attemptCount: 0,
    };
    this.store.set(alert.id, alert);
    return { alert, created: true };
  }

  async updateStatus(id: string, next: AlertStatus, fields: Partial<Alert>) {
    const a = this.store.get(id)!;
    const updated: Alert = { ...a, ...fields, status: next };
    this.store.set(id, updated);
    return updated;
  }

  async recordFailedAttempt(id: string, at: Date) {
    const a = this.store.get(id)!;
    const updated: Alert = { ...a, attemptCount: a.attemptCount + 1, lastAttemptAt: at };
    this.store.set(id, updated);
    return updated;
  }

  async deleteAllForOwner(ownerUid: string) {
    let n = 0;
    for (const [id, a] of [...this.store]) {
      if (a.ownerId === ownerUid) { this.store.delete(id); n++; }
    }
    return n;
  }

  /** Test helper — seed an alert directly. */
  seed(alert: Partial<Alert> & { id: string; ownerId: string }): Alert {
    const now = new Date();
    const full: Alert = {
      status: 'active', createdAt: now, expiresAt: new Date(now.getTime() + ACTIVE_WINDOW),
      latitude: null, longitude: null, geohash: null, attemptCount: 0, ...alert,
    };
    this.store.set(full.id, full);
    return full;
  }
}

export class FakeUserRepository implements UserRepository {
  readonly store = new Map<string, UserRecord>();
  /** hash -> uid */
  readonly identifiers = new Map<string, string>();

  async findByUid(uid: string) { return this.store.get(uid) ?? null; }

  async findUidByIdentifierHash(hash: string) { return this.identifiers.get(hash) ?? null; }

  set(uid: string, rec: Partial<UserRecord>): void {
    this.store.set(uid, { uid, safetyKeywordHash: null, mustSetKeyword: false, ...rec });
  }

  async deleteByUid(uid: string) { return this.store.delete(uid) ? 1 : 0; }

  register(uid: string, ...hashes: string[]): void {
    this.set(uid, {});
    for (const h of hashes) this.identifiers.set(h, uid);
  }
}

export class FakeContactRepository implements ContactRepository {
  readonly store = new Map<string, EmergencyContact[]>();
  async listByOwner(ownerUid: string) { return this.store.get(ownerUid) ?? []; }
  async deleteAllForOwner(ownerUid: string) {
    const n = (this.store.get(ownerUid) ?? []).length;
    this.store.delete(ownerUid);
    return n;
  }
  set(ownerUid: string, contacts: EmergencyContact[]): void {
    this.store.set(ownerUid, contacts);
  }
}

export class FakeResponderRepository implements ResponderRepository {
  readonly store = new Map<string, ResponderRecord>();
  async findByUid(uid: string) { return this.store.get(uid) ?? null; }
  async findVouchedBy(voucherUid: string) {
    return [...this.store.values()].filter((r) => r.vouchedBy === voucherUid);
  }
  async countActiveVouchesBy(voucherUid: string) {
    return [...this.store.values()]
      .filter((r) => r.vouchedBy === voucherUid && (r.status === 'active' || r.status === 'pending'))
      .length;
  }
  async upsert(record: ResponderRecord) { this.store.set(record.uid, record); return record; }
}

export class FakeInboxRepository implements InboxRepository {
  /** recipientUid -> alertId -> projection */
  readonly store = new Map<string, Map<string, AlertProjection>>();
  putCalls = 0;

  async put(recipientUid: string, projection: AlertProjection) {
    this.putCalls++;
    const box = this.store.get(recipientUid) ?? new Map();
    box.set(projection.alertId, projection);
    this.store.set(recipientUid, box);
  }
  async remove(recipientUid: string, alertId: string) {
    this.store.get(recipientUid)?.delete(alertId);
  }
  async listRecipients(alertId: string) {
    return [...this.store.entries()].filter(([, b]) => b.has(alertId)).map(([uid]) => uid);
  }
  async get(recipientUid: string, alertId: string) {
    return this.store.get(recipientUid)?.get(alertId) ?? null;
  }
  projectionFor(uid: string, alertId: string) { return this.store.get(uid)?.get(alertId); }
}

export class FakeResponderLocationRepository implements ResponderLocationRepository {
  /** uid -> geohash */
  readonly store = new Map<string, string>();
  async findByGeohashPrefixes(prefixes: readonly string[]) {
    return [...this.store.entries()]
      .filter(([, gh]) => prefixes.some((p) => gh.startsWith(p)))
      .map(([uid]) => ({ uid }));
  }
  set(uid: string, geohash: string) { this.store.set(uid, geohash); }
}

/** Maps a bearer token straight to a uid, so tests can act as anyone. */
export const fakeVerifier: TokenVerifier = {
  verify: async (t) => {
    if (!t.startsWith('token-')) throw new Error('bad token');
    return { uid: t.slice('token-'.length) };
  },
};

export const authAs = (uid: string) => ({ authorization: `Bearer token-${uid}` });

export const testConfig = {
  port: 0,
  logLevel: 'error' as const,
  firebaseProjectId: 'test',
  env: 'development' as const,
  activeWindowMs: ACTIVE_WINDOW,
  safetyCheckDelayMs: SAFETY_DELAY,
  keywordPepper: PEPPER,
  keywordAttemptCap: 3,
  keywordAttemptCooldownMs: 30_000,
  taskRunnerSecret: 'task-secret-for-tests',
  maxVouchesPerResponder: 3,
};


export class FakeAcceptanceRepository implements AcceptanceRepository {
  /** `${alertId}\u0000${responderUid}` -> acceptance */
  readonly store = new Map<string, Acceptance>();

  private key(alertId: string, uid: string) { return `${alertId}\u0000${uid}`; }

  async record(acceptance: Acceptance) {
    const k = this.key(acceptance.alertId, acceptance.responderUid);
    const existing = this.store.get(k);
    // First write wins. Re-accepting must not move the timestamp — it is the
    // audit record of when they actually answered.
    if (existing) return { acceptance: existing, created: false };
    this.store.set(k, acceptance);
    return { acceptance, created: true };
  }
  async findFor(alertId: string, responderUid: string) {
    return this.store.get(this.key(alertId, responderUid)) ?? null;
  }
  async listForAlert(alertId: string) {
    return [...this.store.values()].filter((a) => a.alertId === alertId);
  }
  async deleteAllForResponder(responderUid: string) {
    let n = 0;
    for (const [k, a] of this.store) {
      if (a.responderUid === responderUid) { this.store.delete(k); n++; }
    }
    return n;
  }
}
