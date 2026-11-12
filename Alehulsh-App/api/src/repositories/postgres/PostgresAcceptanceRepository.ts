import type { Queryable } from '../../db/pool.js';
import { AppError } from '../../errors.js';
import { IdentityNotMappedError, type Acceptance, type AcceptanceRepository } from '../types.js';

function validAlertId(id: string): boolean {
  if (!id || id.length > 64) return false;
  const bare = id.startsWith('{') && id.endsWith('}') ? id.slice(1, -1) : id;
  return /^[0-9a-fA-F]{32}$/.test(bare.replace(/-/g, ''));
}
function validSubject(subject: string): boolean {
  return subject.length > 0 && !subject.includes('\u0000');
}
interface AcceptanceRow {
  alert_id: string;
  firebase_uid: string;
  accepted_at: Date;
  audience: 'responder' | 'contact';
}
function mapAcceptance(row: AcceptanceRow): Acceptance {
  return {
    alertId: row.alert_id, responderUid: row.firebase_uid,
    acceptedAt: row.accepted_at, audience: row.audience,
  };
}

/** External subjects at the boundary; PostgreSQL UUIDs stay in SQL. */
export class PostgresAcceptanceRepository implements AcceptanceRepository {
  constructor(private readonly db: Queryable) {}
  async withdraw(alertId:string,uid:string,key:string):Promise<void>{
    if(!validAlertId(alertId)||key!==alertId||!validSubject(uid))return;
    await this.db.query(`UPDATE acceptances SET withdrawn_at=coalesce(withdrawn_at,clock_timestamp())
      WHERE alert_id=$1::uuid AND responder_id=auth.uid()
        AND responder_id=(SELECT user_id FROM identity_map WHERE firebase_uid=$2)`,[alertId,uid]);
  }

  async record(acceptance: Acceptance): Promise<{ acceptance: Acceptance; created: boolean }> {
    if (!validAlertId(acceptance.alertId)) throw new AppError('not_found', 'alert not found');
    if (!validSubject(acceptance.responderUid)) throw new IdentityNotMappedError();
    if (!Number.isFinite(acceptance.acceptedAt.getTime())
      || !['responder', 'contact'].includes(acceptance.audience)) {
      throw new AppError('invalid_request', 'invalid acceptance metadata');
    }
    // Lock the live alert before insertion. Terminal transitions take the
    // same row lock, so an acceptance cannot be newly inserted after closure.
    // Routes remain responsible for selecting this responder from her inbox.
    const { rows } = await this.db.query<{ alert_id: string; accepted_at: Date; audience: 'responder' | 'contact' }>(
      `WITH live AS MATERIALIZED (
         SELECT a.id FROM alerts a WHERE a.id = $1::uuid
           AND a.status IN ('active','escalated') AND a.expires_at > now() FOR UPDATE OF a
       )
       INSERT INTO acceptances (alert_id, responder_id, accepted_at, audience)
       SELECT live.id, m.user_id, $3::timestamptz, $4::audience_kind
         FROM live JOIN identity_map m ON m.firebase_uid = $2
       ON CONFLICT (alert_id, responder_id) DO UPDATE SET withdrawn_at=NULL WHERE acceptances.withdrawn_at IS NOT NULL
       RETURNING alert_id::text, accepted_at, audience::text`,
      [acceptance.alertId, acceptance.responderUid, acceptance.acceptedAt, acceptance.audience],
    );
    if (rows[0]) {
      return { acceptance: mapAcceptance({ ...rows[0], firebase_uid: acceptance.responderUid }), created: true };
    }
    // A conflicting INSERT waits for the other transaction to commit. The
    // following statement gets a fresh snapshot and returns its original
    // timestamp/audience, rather than overwriting either on a replay.
    const existing = await this.findFor(acceptance.alertId, acceptance.responderUid);
    if (existing) return { acceptance: existing, created: false };
    const identity = await this.db.query('SELECT user_id FROM identity_map WHERE firebase_uid = $1', [acceptance.responderUid]);
    if (identity.rows.length === 0) throw new IdentityNotMappedError();
    const target = await this.db.query('SELECT status FROM alerts WHERE id = $1::uuid', [acceptance.alertId]);
    if (target.rows.length === 0) throw new AppError('not_found', 'alert not found');
    throw new AppError('alert_closed', 'alert no longer accepts responders');
  }

  async findFor(alertId: string, responderUid: string): Promise<Acceptance | null> {
    if (!validAlertId(alertId) || !validSubject(responderUid)) return null;
    const { rows } = await this.db.query<AcceptanceRow>(
      `SELECT a.alert_id::text, a.accepted_at, a.audience::text, m.firebase_uid
         FROM acceptances a JOIN identity_map m ON m.user_id = a.responder_id
        WHERE a.alert_id = $1::uuid AND m.firebase_uid = $2 AND a.withdrawn_at IS NULL`, [alertId, responderUid],
    );
    return rows[0] ? mapAcceptance(rows[0]) : null;
  }

  async listForAlert(alertId: string): Promise<Acceptance[]> {
    if (!validAlertId(alertId)) return [];
    const { rows } = await this.db.query<AcceptanceRow>(
      `SELECT a.alert_id::text, a.accepted_at, a.audience::text, m.firebase_uid
         FROM acceptances a JOIN identity_map m ON m.user_id = a.responder_id
        WHERE a.alert_id = $1::uuid AND a.withdrawn_at IS NULL ORDER BY a.accepted_at, a.responder_id`, [alertId],
    );
    return rows.map(mapAcceptance);
  }

  async deleteAllForResponder(responderUid: string): Promise<number> {
    if (!validSubject(responderUid)) return 0;
    const { rowCount } = await this.db.query(
      `DELETE FROM acceptances WHERE responder_id =
        (SELECT user_id FROM identity_map WHERE firebase_uid = $1)`, [responderUid],
    );
    return rowCount ?? 0;
  }
}
