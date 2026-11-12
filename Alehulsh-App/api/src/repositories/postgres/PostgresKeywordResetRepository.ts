import type { Queryable } from '../../db/pool.js';
import { AppError } from '../../errors.js';
import { IdentityNotMappedError, type KeywordReset, type KeywordResetRepository } from '../types.js';

interface Row {
  requested_at: Date; eligible_at: Date; status: KeywordReset['status'];
  cancelled_at: Date | null; cancelled_reason: KeywordReset['cancelledReason'] | null;
}
const map = (uid: string, row: Row): KeywordReset => ({
  uid,
  requestedAt: row.requested_at, eligibleAt: row.eligible_at, status: row.status,
  ...(row.cancelled_at ? { cancelledAt: row.cancelled_at } : {}),
  ...(row.cancelled_reason ? { cancelledReason: row.cancelled_reason } : {}),
});
export class PostgresKeywordResetRepository implements KeywordResetRepository {
  constructor(private readonly db: Queryable) { }
  private async operation<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch (err) {
      const code = (err as { code?: string; }).code;
      if (code === 'AL001') throw new IdentityNotMappedError();
      if (code === 'AL002') throw new AppError('conflict');
      if (code === 'AL003') throw new AppError('not_found');
      throw err;
    }
  }
  async findPending(uid: string): Promise<KeywordReset | null> {
    const { rows } = await this.db.query<Row>(`SELECT r.* FROM keyword_resets r
      JOIN identity_map m ON m.user_id=r.user_id WHERE m.firebase_uid=$1 AND status='pending'`, [uid]);
    return rows[0] ? map(uid, rows[0]) : null;
  }
  async create(reset: KeywordReset): Promise<KeywordReset> {
    return this.operation(async () => {
      const { rows } = await this.db.query<Row>('SELECT * FROM request_keyword_reset($1,$2)', [reset.uid, reset.requestedAt]);
      if (!rows[0]) throw new AppError('not_found');
      return map(reset.uid, rows[0]);
    });
  }
  async confirm(uid: string, at: Date, hash: string, now: Date): Promise<void> {
    await this.operation(() => this.db.query('SELECT confirm_keyword_reset($1,$2,$3,$4)', [uid, at, hash, now]));
  }
  async update(uid: string, fields: Partial<KeywordReset>): Promise<void> {
    if (!fields.status) return;
    if (!['cancelled', 'voided_by_alert'].includes(fields.status)) throw new AppError('conflict');
    await this.operation(() => this.db.query('SELECT cancel_keyword_reset($1,$2,$3)',
      [uid, fields.status, fields.cancelledAt ?? new Date()]));
  }
  async deleteForUid(uid: string): Promise<number> {
    const { rowCount } = await this.db.query(`DELETE FROM keyword_resets WHERE user_id=
      (SELECT user_id FROM identity_map WHERE firebase_uid=$1)`, [uid]);
    return rowCount ?? 0;
  }
}
