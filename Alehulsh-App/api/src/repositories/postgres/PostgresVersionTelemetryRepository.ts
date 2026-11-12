import type { Queryable } from '../../db/pool.js';
import { IdentityNotMappedError, type VersionTelemetryRepository } from '../types.js';

/** Latest observation only; no behavioral history is accumulated. */
export class PostgresVersionTelemetryRepository implements VersionTelemetryRepository {
  constructor(private readonly db: Queryable) {}

  async record(uid: string, platform: 'android' | 'ios', version: string, at: Date): Promise<void> {
    const { rowCount } = await this.db.query(
      `INSERT INTO client_versions (user_id, platform, version, last_seen_at)
       SELECT user_id, $2, $3, $4 FROM identity_map WHERE firebase_uid = $1
       ON CONFLICT (user_id) DO UPDATE SET platform = EXCLUDED.platform,
         version = EXCLUDED.version, last_seen_at = EXCLUDED.last_seen_at
       WHERE client_versions.last_seen_at <= EXCLUDED.last_seen_at`,
      [uid, platform, version, at],
    );
    // An older delayed observation is intentionally ignored; distinguish it
    // from an unknown subject without inventing a new account.
    if (rowCount === 0) {
      const { rows } = await this.db.query('SELECT 1 FROM identity_map WHERE firebase_uid = $1', [uid]);
      if (rows.length === 0) throw new IdentityNotMappedError();
    }
  }

  async distribution(): Promise<Record<string, number>> {
    const { rows } = await this.db.query<{ version: string; count: string }>(
      'SELECT version, count FROM client_version_distribution()',
    );
    return Object.fromEntries(rows.map(row => [row.version, Number(row.count)]));
  }

  async deleteForUid(uid: string): Promise<number> {
    const { rowCount } = await this.db.query(
      `DELETE FROM client_versions WHERE user_id =
       (SELECT user_id FROM identity_map WHERE firebase_uid = $1)`, [uid],
    );
    return rowCount ?? 0;
  }
}
