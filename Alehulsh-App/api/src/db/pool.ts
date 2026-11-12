/**
 * PostgreSQL connection for local development and tests.
 *
 * Fails closed: there is no default connection string, so an unconfigured
 * process cannot silently reach anything - least of all a hosted database.
 * Credentials come from the environment and are never written to source,
 * logs or error messages.
 */
import { Pool, type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from 'pg';
import { IdentityNotMappedError } from '../repositories/types.js';

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
  /** PEM certificate chain, if the host does not use a publicly trusted CA. */
  sslCa?: string;
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
    ...(env['PGSSL_CA_PEM'] ? { sslCa: env['PGSSL_CA_PEM'] } : {}),
  };
}

export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || host === '[::1]'
    || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host);
}

/** Remote PostgreSQL always authenticates its server certificate. */
export function databaseTls(config: Pick<DbConfig, 'host' | 'sslCa'>): PoolConfig['ssl'] {
  return isLoopbackHost(config.host) ? false : {
    rejectUnauthorized: true,
    ...(config.sslCa ? { ca: config.sslCa } : {}),
  };
}

/** A pool for the given config. The caller owns its lifecycle. */
export function createPool(config: DbConfig, extra: PoolConfig = {}): Pool {
  if (extra.connectionString) {
    throw new Error('pool connection strings must be parsed into DbConfig before use');
  }
  if (!isLoopbackHost(config.host)
    && (extra.ssl === false || (typeof extra.ssl === 'object' && extra.ssl?.rejectUnauthorized === false))) {
    throw new Error('remote database TLS certificate verification cannot be disabled');
  }
  return new Pool({
    max: 10,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    ...extra,
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: extra.ssl ?? databaseTls(config),
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
 * connection either way. BEGIN/COMMIT failures discard the connection because
 * transaction state may be unknown; a failed ROLLBACK does the same. A leaked client is worse than
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
  let discard = false;
  try {
    try {
      await client.query('BEGIN');
    } catch (cause) {
      discard = true;
      throw cause;
    }
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
        discard = true;
      }
      throw cause;
    }
    try {
      await client.query('COMMIT');
    } catch (cause) {
      // A deferred constraint can fail at COMMIT; a network failure can also
      // leave its outcome unknown. Never lend that connection or its local
      // identity context to another request. Discarding closes it and aborts
      // any still-open transaction; it cannot undo a commit already accepted.
      discard = true;
      throw cause;
    }
    return result;
  } finally {
    // Disarmed BEFORE the connection goes back to the pool, so there is no
    // window in which an escaped handle and a new owner share a connection.
    scope.close();
    client.release(discard ? true : undefined);
  }
}

/**
 * Application transaction boundary. The pool credential is only a connection
 * credential: no application statement runs before the restricted role and
 * transaction-local identity are established. A null subject is explicitly
 * system work, with no person's evidence access.
 *
 * Most existing API policies intentionally grant cross-user operations to this
 * role; routes/repositories must still authorize those operations. Evidence
 * SELECT policies additionally enforce owner/accepted-recipient isolation.
 */
export async function withApiTransaction<T>(
  pool: Pool,
  subject: string | null,
  fn: (tx: Queryable) => Promise<T>,
): Promise<T> {
  if (subject !== null && (!subject || subject.includes('\u0000'))) {
    throw new IdentityNotMappedError();
  }
  return withTransaction(pool, async (tx) => {
    await tx.query('SET LOCAL ROLE alehulsh_api');
    const { rows } = await tx.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    const role = rows[0];
    if (!role || role.rolname !== 'alehulsh_api' || role.rolsuper || role.rolbypassrls) {
      throw new Error('application database role must be alehulsh_api without superuser or BYPASSRLS');
    }
    // Clear BOTH accessors before identity resolution. Supabase auth.uid() can
    // fall back to request.jwt.claims if the scalar claim is blank.
    await tx.query(
      `SELECT set_config('request.jwt.claim.sub', '', true),
              set_config('request.jwt.claims', '{}', true)`,
    );
    if (subject !== null) {
      const result = await tx.query<{ user_id: string | null }>(
        `SELECT public.resolve_identity($1::text)::text AS user_id`, [subject],
      );
      const userId = result.rows[0]?.user_id;
      if (!userId) throw new IdentityNotMappedError();
      await tx.query(
        `SELECT set_config('request.jwt.claim.sub', $1, true),
                set_config('request.jwt.claims', $2, true)`,
        [userId, JSON.stringify({ sub: userId })],
      );
    }
    return fn(tx);
  });
}

/** Pass this to application repositories/queues rather than the raw pool. */
export class ApiDatabase implements Queryable {
  constructor(private readonly pool: Pool, private readonly subject: string | null = null) {}

  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return withApiTransaction(this.pool, this.subject, fn);
  }

  query<R extends QueryResultRow = QueryResultRow>(
    sql: string, params?: readonly unknown[],
  ): Promise<QueryResult<R>> {
    return this.transaction((tx) => tx.query<R>(sql, params));
  }
}

export function createApiDatabase(pool: Pool, subject: string | null = null): ApiDatabase {
  return new ApiDatabase(pool, subject);
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
