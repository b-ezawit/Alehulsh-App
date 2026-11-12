import type { Queryable } from '../../db/pool.js';
import { AppError } from '../../errors.js';
export interface OwnedContact { id: string; name: string; phone: string; email: string; relationship: string; isPrimary: boolean; }
export type ContactWrite = Omit<OwnedContact, 'id'>;
export class PostgresContactManagementRepository {
  constructor(private readonly db: Queryable) { }
  async list(uid: string): Promise<OwnedContact[]> {
    const { rows } = await this.db.query(`SELECT c.id,c.label,c.phone_e164,c.email,c.relationship,c.is_primary
   FROM emergency_contacts c JOIN identity_map m ON m.user_id=c.owner_id
   WHERE m.firebase_uid=$1 AND c.owner_id=auth.uid() ORDER BY c.is_primary DESC,c.created_at,c.id`, [uid]);
    return rows.map(row => ({ id: row.id, name: row.label, phone: row.phone_e164, email: row.email ?? '', relationship: row.relationship, isPrimary: row.is_primary }));
  }
  async put(uid: string, id: string, contact: ContactWrite): Promise<boolean> {
    try {
      const { rows } = await this.db.query<{ created: boolean; }>('SELECT public.put_owned_contact($1,$2::uuid,$3,$4,$5,$6,$7) AS created',
        [uid, id, contact.name, contact.phone, contact.email, contact.relationship, contact.isPrimary]); return rows[0]?.created === true;
    }
    catch (error) { const code = (error as { code?: string; }).code; if (code === '23505') throw new AppError('conflict'); if (code === 'AL003' || code === 'AL001') throw new AppError('not_found'); throw error; }
  }
  async remove(uid: string, id: string): Promise<void> {
    await this.db.query(`DELETE FROM emergency_contacts WHERE id=$2::uuid AND owner_id=auth.uid()
   AND owner_id=(SELECT user_id FROM identity_map WHERE firebase_uid=$1)`, [uid, id]);
  }
}
