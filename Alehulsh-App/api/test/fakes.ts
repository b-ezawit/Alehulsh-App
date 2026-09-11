import type {
  Alert, AlertRepository, AlertStatus, UserRecord, UserRepository,
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
  async findByUid(uid: string) { return this.store.get(uid) ?? null; }
  set(uid: string, rec: Partial<UserRecord>): void {
    this.store.set(uid, { uid, safetyKeywordHash: null, mustSetKeyword: false, ...rec });
  }
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
};
