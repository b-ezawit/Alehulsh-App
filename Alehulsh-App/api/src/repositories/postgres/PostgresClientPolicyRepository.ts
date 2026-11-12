import type { Queryable } from '../../db/pool.js';
import type { ClientPolicy, ClientPolicyRepository } from '../types.js';

/** Same outage behavior as the Firebase adapter: never block launch on a read failure. */
export class PostgresClientPolicyRepository implements ClientPolicyRepository {
  private cache: { value: ClientPolicy; at: number } | undefined;
  constructor(private readonly db: Queryable, private readonly ttlMs = 60_000) {}

  async get(): Promise<ClientPolicy> {
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.value;
    const empty = (): ClientPolicy => ({
      android: { minVersion: null, latestVersion: null },
      ios: { minVersion: null, latestVersion: null },
    });
    try {
      const { rows } = await this.db.query<{
        platform: 'android' | 'ios'; min_version: string | null; latest_version: string | null;
      }>('SELECT platform, min_version, latest_version FROM client_policy');
      const value = empty();
      for (const row of rows) value[row.platform] = {
        minVersion: row.min_version, latestVersion: row.latest_version,
      };
      this.cache = { value, at: Date.now() };
      return value;
    } catch { return this.cache?.value ?? empty(); }
  }
}
