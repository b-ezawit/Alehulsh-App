/**
 * PostgreSQL connection for local development and tests.
 *
 * Fails closed: there is no default connection string, so an unconfigured
 * process cannot silently reach anything - least of all a hosted database.
 * Credentials come from the environment and are never written to source,
 * logs or error messages.
 */
import { Pool, type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from 'pg';

/**
 * Anything that can run a statement: a Pool, or one client inside a
 * transaction.
 *
 * Repositories take this rather than a Pool so the SAME repository instance
 * can serve an ordinary single-statement call and a caller-managed
 * transaction. Without it, a repository bound to the Pool takes an arbitrary
 * pooled connection and commits on its own - so an alert and its outbox work
 * could not be written atomically, which is the one guarantee an outbox
 * exists to provide.
 *
 * Note what is NOT here: begin, commit or rollback. A repository must never
 * end a transaction it does not own. Transaction control belongs to
 * withTransaction, and to nothing else.
 */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

export interface DbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

/**
 * Read the connection from the environment.
 *
 * @throws when anything required is missing. A safety app must not guess at
 *   which database it is talking to.
 */
export function loadDbConfig(env: NodeJS.ProcessEnv = process.env): DbConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (value === undefined || value.trim() === '') {
      throw new Error(`Missing required database environment variable: ${name}`);
    }
    return value;
  };

  const port = Number(required('PGPORT'));
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('PGPORT must be a positive integer');
  }

  return {
    host: required('PGHOST'),
    port,
    database: required('PGDATABASE'),
    user: required('PGUSER'),
    password: required('PGPASSWORD'),
  };
}

/** A pool for the given config. The caller owns its lifecycle. */
export function createPool(config: DbConfig, extra: PoolConfig = {}): Pool {
  return new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    max: 10,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    ...extra,
  });
}

/**
 * A Queryable that stops working the moment its transaction ends.
 *
 * Needed because `pg` does NOT invalidate a released client: a handle kept
 * past the end of its transaction goes on issuing statements on the same
 * backend connection, which the pool has by then handed to someone else.
 * Verified, not assumed - the released client reported the same
 * pg_backend_pid as the next caller, and could run BEGIN and COMMIT on it.
 *
 * The consequence of leaving that unguarded is not a leak but a corruption: a
 * stray COMMIT from code holding an old handle would commit a different
 * request's half-finished unit of work. Requires a misuse to trigger, so it is
 * unlikely - and it is one line to make it fail loudly instead.
 */
class TransactionScope implements Queryable {
  private live = true;

  constructor(private readonly client: PoolClient) {}

  async query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<R>> {
    if (!this.live) {
      throw new Error('transaction has ended: this handle must not be used again');
    }
    return this.client.query<R>(sql, params as unknown[]);
  }

  /** Called once the transaction is over, before the connection is released. */
  close(): void {
    this.live = false;
  }
}

/**
 * Runs `fn` inside one transaction on one connection.
 *
 * Commits when `fn` returns, rolls back when it throws, and releases the
 * connection either way - including when the ROLLBACK itself fails, which
 * happens when the connection has already died. A leaked client is worse than
 * a failed request: the pool runs out and every later SOS waits on a
 * connection that will never come back.
 *
 * The original error is always what propagates. A failure during cleanup must
 * not replace the reason the work was abandoned.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (tx: Queryable) => Promise<T>,
): Promise<T> {
  const client: PoolClient = await pool.connect();
  const scope = new TransactionScope(client);
  try {
    await client.query('BEGIN');
    let result: T;
    try {
      result = await fn(scope);
    } catch (cause) {
      // Rollback is best-effort: if it fails the connection is broken, and
      // releasing it with an error tells the pool to discard rather than reuse
      // it. Either way `cause` is what the caller sees.
      try {
        await client.query('ROLLBACK');
      } catch {
        client.release(true);
        throw cause;
      }
      throw cause;
    }
    await client.query('COMMIT');
    return result;
  } finally {
    // Disarmed BEFORE the connection goes back to the pool, so there is no
    // window in which an escaped handle and a new owner share a connection.
    scope.close();
    // release() is idempotent in pg; a second call after release(true) above
    // is ignored, so this cannot double-release.
    client.release();
  }
}

/**
 * Closes the pool, once, without throwing.
 *
 * Shutdown runs when something has already gone wrong as often as not, so a
 * failure to close must not mask the original fault or stop the rest of the
 * teardown. Idempotent because both a signal handler and a server hook may
 * reasonably call it.
 */
export async function closePool(pool: Pool): Promise<void> {
  try {
    await pool.end();
  } catch {
    // Already ended, or the connection is gone. Nothing left to do.
  }
}
