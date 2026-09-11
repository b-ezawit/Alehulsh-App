import type { Firestore } from 'firebase-admin/firestore';
import type { ClientPolicy, ClientPolicyRepository, PlatformPolicy } from '../types.js';

/** Interim. Replaced at C-04 (M-05). */
const DOC = 'app_config/client_policy';

const NEVER_BLOCK: PlatformPolicy = { minVersion: null, latestVersion: null };

/**
 * Reads the policy document, with a short cache.
 *
 * The cache exists because this is called on every app launch. Sixty seconds
 * is short enough that raising the floor takes effect almost immediately and
 * long enough that a launch spike does not become a read spike.
 *
 * If the read fails, the cached value is reused and a missing document yields
 * "never block". The alternative — an unreachable config store blocking every
 * install — is the failure mode this whole feature must not have.
 */
export class FirestoreClientPolicyRepository implements ClientPolicyRepository {
  private cache: { value: ClientPolicy; at: number } | null = null;

  constructor(
    private readonly db: Firestore,
    private readonly ttlMs = 60_000,
  ) {}

  async get(): Promise<ClientPolicy> {
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.value;

    try {
      const snap = await this.db.doc(DOC).get();
      const d = snap.exists ? snap.data() ?? {} : {};
      const value: ClientPolicy = {
        android: platform(d['android']),
        ios: platform(d['ios']),
      };
      this.cache = { value, at: Date.now() };
      return value;
    } catch {
      // Stale policy beats no app.
      if (this.cache) return this.cache.value;
      return { android: NEVER_BLOCK, ios: NEVER_BLOCK };
    }
  }
}

function platform(raw: unknown): PlatformPolicy {
  if (typeof raw !== 'object' || raw === null) return NEVER_BLOCK;
  const r = raw as Record<string, unknown>;
  return {
    minVersion: typeof r['minVersion'] === 'string' ? r['minVersion'] : null,
    latestVersion: typeof r['latestVersion'] === 'string' ? r['latestVersion'] : null,
  };
}
