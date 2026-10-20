/**
 * AlertRepository backed by PostgreSQL + PostGIS.  (M-05)
 *
 * Implements the SAME interface as FirestoreAlertRepository rather than a
 * parallel abstraction, so it is swapped in at the composition root and
 * nothing above it changes. Firebase remains the default; this is opt-in.
 *
 * Every state change goes through a database function (create_alert,
 * transition_alert, record_failed_attempt). Those hold the invariants -
 * server-stamped expiry, one live alert per owner, terminal states being
 * final - so they cannot be bypassed by a future caller that forgets them.
 *
 * All SQL here is parameterised. No caller-supplied value is ever
 * concatenated into a statement.
 */
import type { Pool } from 'pg';
import type { Queryable } from '../../db/pool.js';
import { FRESH_FIX_MS, type LocationQuality } from '../../domain/location.js';
import type { Alert, AlertCreateInput, AlertRepository, AlertStatus } from '../types.js';
import { IdentityNotMappedError } from '../types.js';

export { IdentityNotMappedError };

/** Row shape returned by alertColumns(). */
interface AlertRow {
  id: string;
  /**
   * The owner's EXTERNAL subject, joined back through identity_map - not the
   * internal uuid. See the note on ALERT_COLUMNS.
   */
  owner_subject: string;
  request_id: string;
  status: AlertStatus;
  lat: string | number | null;
  lng: string | number | null;
  location_quality: LocationQuality;
  location_age_ms: string | number | null;
  accuracy_m: string | number | null;
  created_at: Date;
  expires_at: Date;
  escalated_at: Date | null;
  escalation_reason: string | null;
  ended_at: Date | null;
  end_reason: AlertStatus | null;
  resolved_by: string | null;
  device_reported_at: Date | null;
  reported_delay_ms: string | number | null;
  attempt_count: number;
  last_attempt_at: Date | null;
}

/**
 * Coordinates come back through ST_Y/ST_X rather than as WKB, so the mapper
 * never has to parse geometry. Absent location stays absent.
 *
 * owner_id is deliberately NOT selected. The internal uuid is the one
 * identifier that must never leave the database: routes compare
 * `alert.ownerId !== uid` against the verified external subject, so the
 * domain object carries that subject and the uuid stays here. A client has no
 * way to name an internal account because it never sees one.
 *
 * INNER JOIN, not LEFT: an alert whose owner has no external mapping cannot be
 * described in this contract, and returning it with a NULL or placeholder
 * owner would hand the authorization check a value to get wrong. It is simply
 * not visible through this repository - which is literally true, since this
 * repository speaks the Firebase-subject contract.
 */
const ALERT_SELECT = `
  SELECT
    a.id, m.firebase_uid AS owner_subject, a.request_id, a.status,
    ST_Y(a.location::geometry) AS lat,
    ST_X(a.location::geometry) AS lng,
    a.location_quality, a.location_age_ms, a.accuracy_m,
    a.created_at, a.expires_at, a.escalated_at, a.escalation_reason,
    a.ended_at, a.end_reason, a.resolved_by,
    a.device_reported_at, a.reported_delay_ms, a.attempt_count, a.last_attempt_at
  FROM alerts a
  JOIN identity_map m ON m.user_id = a.owner_id
`;

/** bigint arrives from pg as a string; NUMERIC likewise. */
function toNumberOrNull(value: string | number | null): number | null {
  if (value === null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function mapAlert(row: AlertRow): Alert {
  const lat = toNumberOrNull(row.lat);
  const lng = toNumberOrNull(row.lng);

  const alert: Alert = {
    // The document-era `id` was the owner's uid and `key` the instance.
    // Here the row id IS the instance, so both point at it and nothing
    // upstream has to care which era it came from.
    id: row.id,
    key: row.id,
    ownerId: row.owner_subject,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    // Half a coordinate is not a location.
    latitude: lat !== null && lng !== null ? lat : null,
    longitude: lat !== null && lng !== null ? lng : null,
    // Geohash is a Firestore-era index; PostGIS does radius queries directly.
    geohash: null,
    // Read back, not recomputed. The database derived and stored it under a
    // CHECK constraint that keeps it consistent with the coordinates; a second
    // derivation here could only disagree with the row it is describing.
    locationQuality: row.location_quality,
    attemptCount: Number(row.attempt_count),
  };

  if (row.ended_at && row.end_reason === 'resolved') alert.resolvedAt = row.ended_at;
  if (row.resolved_by === 'owner' || row.resolved_by === 'owner_late') {
    alert.resolvedBy = row.resolved_by;
  }
  if (row.escalated_at) alert.escalatedAt = row.escalated_at;
  if (row.escalation_reason === 'wrong_keyword' ||
      row.escalation_reason === 'no_answer' ||
      row.escalation_reason === 'attempts_exhausted') {
    alert.escalationReason = row.escalation_reason;
  }
  if (row.device_reported_at) alert.deviceReportedAt = row.device_reported_at;
  alert.reportedDelayMs = toNumberOrNull(row.reported_delay_ms);
  alert.locationAgeMs = toNumberOrNull(row.location_age_ms);
  alert.accuracyMeters = toNumberOrNull(row.accuracy_m);
  if (row.last_attempt_at) alert.lastAttemptAt = row.last_attempt_at;

  return alert;
}

/**
 * Raised when a row that must exist does not.
 *
 * Carries no SQL and no identifier. Sprint 2 put the alert id in the message;
 * it told the caller nothing it had not just supplied, but it also reached the
 * logs, where it links a log line to one woman's emergency. There is no reason
 * to pay that for an error string.
 */
export class AlertNotFoundError extends Error {
  constructor() {
    super('alert not found');
    this.name = 'AlertNotFoundError';
  }
}

/** Raised by create_alert_for_subject when resolve_identity finds nothing. */
const UNMAPPED_IDENTITY_SQLSTATE = 'AL001';

/**
 * Could this string be an identifier at all?
 *
 * Deliberately almost nothing: no length, no character class, no shape. A
 * subject is whatever the IdP issued, and Firebase's 28 characters are not a
 * contract we should encode here - C-04 replaces it with a self-hosted IdP
 * whose subjects look different.
 *
 * The one exception is a NUL byte, which Postgres cannot store in `text` at
 * all: sending one aborts the statement with an encoding error, and that
 * error names the encoding and the byte. Refusing it here turns a database
 * detail into the ordinary "we do not know who this is".
 */
function couldBeSubject(subject: string): boolean {
  return subject.length > 0 && !subject.includes('\u0000');
}

/**
 * Could this string be an alert id at all?
 *
 * `alerts.id` is a `uuid`, and comparing a non-uuid against it raises
 * SQLSTATE 22P02 rather than matching nothing. That broke findById's own
 * contract - it is declared `Promise<Alert | null>` and has a test named
 * "returns null for an unknown id rather than throwing", which passed only
 * because it used a well-formed uuid. A malformed id turned a task-runner
 * request into a 500, which the worker then retried on its bounded budget
 * until the task was abandoned: work dropped, and someone paged, for an input
 * that simply does not name an alert.
 *
 * MIRRORS the database rather than tightening it. Postgres is more permissive
 * than canonical uuid - measured, it accepts the canonical form, uppercase,
 * no hyphens, surrounding braces, and even arbitrary hyphen placement
 * (`a0ee-bc99-9c0b-4ef8-bb6d-6bb9-bd38-0a11`), while rejecting a `urn:uuid:`
 * prefix, surrounding whitespace, wrong length and non-hex. A canonical-only
 * regex would therefore be STRICTER than the column and would return null for
 * ids that currently match a real row. So: strip optional braces, drop
 * hyphens, require exactly 32 hex digits.
 *
 * This is a shape check, not error handling. A genuine database failure must
 * still propagate - see the note on findById.
 */
function looksLikeAlertId(id: string): boolean {
  if (id.length === 0 || id.length > 64) return false;
  const bare = id.startsWith('{') && id.endsWith('}') ? id.slice(1, -1) : id;
  return /^[0-9a-fA-F]{32}$/.test(bare.replace(/-/g, ''));
}

function isUnmappedIdentity(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null
    && (cause as { code?: unknown }).code === UNMAPPED_IDENTITY_SQLSTATE;
}

export class PostgresAlertRepository implements AlertRepository {
  /**
   * @param db a Pool for ordinary calls, or one transaction's client when the
   *   caller owns a transaction. This repository NEVER issues BEGIN, COMMIT or
   *   ROLLBACK: a repository that ended a transaction it did not open could
   *   commit half of someone else's unit of work. Transaction control lives in
   *   withTransaction and nowhere else.
   * @param activeWindowMs matches the API's active window; create_alert stamps
   *   expiry from it, on the server clock.
   * @param freshFixMs the age at or under which a fix counts as current. The
   *   server's value is authoritative - it is passed into SQL rather than
   *   letting the function's own default decide, so there is one threshold.
   */
  constructor(
    private readonly db: Queryable,
    private readonly activeWindowMs: number,
    private readonly freshFixMs: number = FRESH_FIX_MS,
  ) {}

  /**
   * The same repository, bound to one transaction.
   *
   * Returns a new instance rather than mutating this one, so a long-lived
   * repository shared across requests cannot be accidentally pinned to a
   * finished transaction by a concurrent caller.
   */
  withQueryable(db: Queryable): PostgresAlertRepository {
    return new PostgresAlertRepository(db, this.activeWindowMs, this.freshFixMs);
  }

  /**
   * An alert by id, or null when there is no such alert.
   *
   * A malformed id is "no such alert", not an error: it cannot name a row, and
   * the caller's next move is the same either way. The guard runs BEFORE the
   * query, so a bad id costs no round trip.
   *
   * Deliberately NOT a try/catch around the query. Converting every database
   * error to null would hide an outage behind a 404 - the alert would appear
   * not to exist, a responder would be told to stand down, and nothing would
   * page. Only the shape is checked here; a real failure still propagates.
   */
  async findById(id: string): Promise<Alert | null> {
    if (!looksLikeAlertId(id)) return null;
    const { rows } = await this.db.query<AlertRow>(
      `${ALERT_SELECT} WHERE a.id = $1`, [id],
    );
    return rows[0] ? mapAlert(rows[0]) : null;
  }

  /** @param ownerSubject the VERIFIED external subject, never an internal uuid. */
  async findActiveByOwner(ownerSubject: string): Promise<Alert | null> {
    if (!couldBeSubject(ownerSubject)) return null;
    const { rows } = await this.db.query<AlertRow>(
      `${ALERT_SELECT}
        WHERE m.firebase_uid = $1 AND a.status IN ('active','escalated')
        LIMIT 1`, [ownerSubject],
    );
    return rows[0] ? mapAlert(rows[0]) : null;
  }

  /**
   * Idempotent in both senses: a retry of the same requestId, and a second
   * trigger under a different requestId while one is live, both fold onto the
   * existing alert. create_alert decides; this method does not duplicate that
   * logic, so the two cannot drift apart.
   *
   * `ownerId` here is the verified external subject. It is resolved to an
   * internal uuid inside create_alert_for_subject - in the same statement, so
   * there is no window between resolving an identity and using it, and no way
   * for a caller to supply the uuid directly.
   *
   * Location QUALITY is not accepted from the caller and is not computed here.
   * The database derives it from the coordinates, accuracy and age, under the
   * CHECK constraints that keep it consistent with what was actually stored.
   */
  async create(input: AlertCreateInput): Promise<{ alert: Alert; created: boolean }> {
    if (!couldBeSubject(input.ownerId)) throw new IdentityNotMappedError();
    const windowInterval = `${Math.max(1, Math.round(this.activeWindowMs / 1000))} seconds`;

    let result: { alert_id: string; created: boolean } | undefined;
    try {
      const { rows } = await this.db.query<{ alert_id: string; created: boolean }>(
        `SELECT alert_id, created FROM create_alert_for_subject(
           $1::text, $2::text, $3::double precision, $4::double precision,
           $5::bigint, $6::double precision, $7::interval, $8::timestamptz, $9::bigint)`,
        [
          input.ownerId, input.requestId, input.latitude, input.longitude,
          input.locationAgeMs ?? null, input.accuracyMeters ?? null,
          windowInterval, input.occurredAt ?? null, this.freshFixMs,
        ],
      );
      result = rows[0];
    } catch (cause) {
      // Translated at the boundary so no SQLSTATE, table name or column type
      // can travel outward in an error message.
      if (isUnmappedIdentity(cause)) throw new IdentityNotMappedError();
      throw cause;
    }

    if (!result?.alert_id) {
      // create_alert always returns a row; an empty result means the
      // invariants were violated in a way we must not paper over.
      throw new Error('create_alert returned no alert');
    }
    const alert = await this.findById(result.alert_id);
    if (!alert) throw new AlertNotFoundError();
    return { alert, created: result.created };
  }

  /**
   * Terminal states are final. When the alert has already ended, the function
   * reports no transition and this returns the alert as it stands rather than
   * forcing a contradictory state - that is what makes a cancel racing a
   * resolve safe.
   */
  async updateStatus(id: string, next: AlertStatus, fields: Partial<Alert>): Promise<Alert> {
    // Same 22P02 as findById, but this method returns Alert and cannot report
    // absence with null - so it uses the signal it already has for a missing
    // alert. Unreachable through any current route, because every caller
    // obtains the id from a prior findById; guarded so a future one cannot
    // reintroduce it.
    if (!looksLikeAlertId(id)) throw new AlertNotFoundError();
    const reason = next === 'escalated' ? (fields.escalationReason ?? null) : null;
    const resolvedBy = next === 'resolved' ? (fields.resolvedBy ?? null) : null;

    await this.db.query(
      `SELECT transition_alert($1::uuid, $2::alert_status, $3::text, $4::text, $5::text)`,
      [id, next, 'api', reason, resolvedBy],
    );

    const alert = await this.findById(id);
    if (!alert) throw new AlertNotFoundError();
    return alert;
  }

  async recordFailedAttempt(id: string, at: Date): Promise<Alert> {
    if (!looksLikeAlertId(id)) throw new AlertNotFoundError();
    const { rows } = await this.db.query<{ record_failed_attempt: boolean }>(
      `SELECT record_failed_attempt($1::uuid, $2::timestamptz)`, [id, at],
    );
    if (!rows[0]?.record_failed_attempt) throw new AlertNotFoundError();

    const alert = await this.findById(id);
    if (!alert) throw new AlertNotFoundError();
    return alert;
  }

  /** Newest first, terminal alerts included: the pattern is the evidence. */
  async listHistoryForOwner(ownerSubject: string, limit = 50): Promise<Alert[]> {
    if (!couldBeSubject(ownerSubject)) return [];
    const { rows } = await this.db.query<AlertRow>(
      `${ALERT_SELECT}
        WHERE m.firebase_uid = $1 ORDER BY a.created_at DESC LIMIT $2`,
      [ownerSubject, Math.max(1, Math.min(limit, 500))],
    );
    return rows.map(mapAlert);
  }

  /**
   * Evidence rows reference alerts with ON DELETE RESTRICT, so this fails
   * loudly while any remain. That is deliberate: account deletion removes R2
   * objects and evidence rows first, in that order, and must not be able to
   * strand objects by deleting their only index.
   *
   * An unmapped subject RAISES rather than reporting zero. "We deleted
   * everything" and "we could not find who you meant" must never look the
   * same on a privacy operation.
   */
  async deleteAllForOwner(ownerSubject: string): Promise<number> {
    if (!couldBeSubject(ownerSubject)) throw new IdentityNotMappedError();
    const { rows } = await this.db.query<{ user_id: string }>(
      `SELECT user_id FROM identity_map WHERE firebase_uid = $1`, [ownerSubject],
    );
    const internal = rows[0]?.user_id;
    if (!internal) throw new IdentityNotMappedError();

    const { rowCount } = await this.db.query(
      `DELETE FROM alerts WHERE owner_id = $1::uuid`, [internal],
    );
    return rowCount ?? 0;
  }
}

/**
 * A pool-backed repository. The ordinary construction path.
 *
 * Exists so call sites read as what they are rather than relying on Pool
 * happening to satisfy Queryable.
 */
export function alertRepositoryFromPool(
  pool: Pool,
  activeWindowMs: number,
  freshFixMs: number = FRESH_FIX_MS,
): PostgresAlertRepository {
  return new PostgresAlertRepository(pool, activeWindowMs, freshFixMs);
}
