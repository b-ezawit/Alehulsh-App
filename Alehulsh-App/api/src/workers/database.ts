import { requireRestrictedRuntimeLogin } from '../db/runtimeLogin.js';
import { Pool } from 'pg';
import { createApiDatabase, closePool, type Queryable } from '../db/pool.js';
export interface DatabaseBinding { HYPERDRIVE?: { connectionString: string; }; }
/** Cloudflare supplies the connection; no administrator URL fallback. */
export async function withWorkerDatabase<T>(env: DatabaseBinding, subject: string | null, run: (db: Queryable) => Promise<T>): Promise<T> {
  if (!env.HYPERDRIVE?.connectionString) throw Error('Hyperdrive binding required');
  const pool = new Pool({
    connectionString: env.HYPERDRIVE.connectionString, max: 1, connectionTimeoutMillis: 5000,
    query_timeout: 5000, statement_timeout: 5000, idleTimeoutMillis: 1000
  });
  try { const db = createApiDatabase(pool, subject); await requireRestrictedRuntimeLogin(db); return await run(db); } finally { await closePool(pool); }
}
