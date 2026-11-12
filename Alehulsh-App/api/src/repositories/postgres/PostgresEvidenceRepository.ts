import type { Queryable } from '../../db/pool.js';
import { AppError } from '../../errors.js';
import { assertPublication, type PublishedEvidence, isAllowedContentType, storagePathFor } from '../../evidence/EvidenceStore.js';
import type { EvidenceRecord, EvidenceRepository } from '../types.js';

/** Trusted object inspection, never a client-supplied checksum or ETag. */
export interface EvidenceIntegrityVerifier {
  publish?(storagePath: string, contentType: string): Promise<PublishedEvidence>;
  inspect(storagePath: string): Promise<{ sha256: string; sizeBytes: number }>;
}

const MAX_BYTES = 100 * 1024 * 1024;
interface EvidenceRow {
  id: string; alert_id: string; owner_subject: string; r2_key: string;
  state: string; content_type: string; size_bytes: string | null;
  duration_ms: string | null; created_at: Date; deliberate: boolean;
  actual_sha256: string | null; declared_sha256: string | null;
}
const SELECT = `SELECT e.*, m.firebase_uid AS owner_subject
  FROM evidence e JOIN identity_map m ON m.user_id = e.owner_id`;

function uuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
function map(row: EvidenceRow): EvidenceRecord {
  return {
    ...(row.actual_sha256 ? {sha256:row.actual_sha256} : {}),
    id: row.id, alertId: row.alert_id, alertKey: row.alert_id,
    ownerUid: row.owner_subject, storagePath: row.r2_key,
    contentType: row.content_type, sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    kind: row.deliberate === true ? 'deliberate' : 'automatic',
    createdAt: row.created_at, uploaded: row.state === 'stored',
  };
}

/**
 * Must receive an ApiDatabase bound to the verified request subject (or the
 * Queryable from withApiTransaction). Evidence RLS intentionally denies a
 * system/null identity. Finalization additionally requires a trusted object
 * verifier: the current EvidenceStore size/exists contract cannot prove the
 * SHA-256 required by the database and is never substituted for that proof.
 */
export class PostgresEvidenceRepository implements EvidenceRepository {
  constructor(private readonly db: Queryable, private readonly integrity?: EvidenceIntegrityVerifier) {}

  async create(record: EvidenceRecord): Promise<EvidenceRecord> {
    if (!uuid(record.id) || !uuid(record.alertId) || record.alertKey !== record.alertId ||
        !isAllowedContentType(record.contentType) || record.uploaded || !record.storagePath ||
        !['automatic', 'deliberate'].includes(record.kind) ||
        record.storagePath !== storagePathFor(record.ownerUid, record.alertId, record.id) ||
        (record.sizeBytes !== null && (!Number.isSafeInteger(record.sizeBytes) || record.sizeBytes <= 0 || record.sizeBytes > MAX_BYTES)) ||
        (record.durationMs !== null && (!Number.isSafeInteger(record.durationMs) || record.durationMs < 0))) {
      throw new AppError('invalid_request', 'invalid evidence metadata');
    }
    // The source row lock serializes creation with terminal transitions.
    const { rowCount } = await this.db.query(
      `WITH live AS MATERIALIZED (
         SELECT id, owner_id FROM alerts WHERE id = $2::uuid
          AND owner_id = auth.uid() AND status IN ('active','escalated')
          AND expires_at > now() FOR UPDATE
       )
       INSERT INTO evidence (id, alert_id, owner_id, r2_key, content_type,
                             size_bytes, duration_ms, deliberate, created_at)
       SELECT $1::uuid, a.id, a.owner_id, $4, $5, $6, $7, $8, $9
         FROM live a JOIN identity_map m ON m.user_id = a.owner_id
        WHERE m.firebase_uid = $3
       ON CONFLICT (id) DO NOTHING`,
      [record.id, record.alertId, record.ownerUid, record.storagePath, record.contentType,
        record.sizeBytes, record.durationMs, record.kind === 'deliberate', record.createdAt]).catch((error: unknown) => {
          if ((error as { code?: string })?.code === 'P0020') throw new AppError('rate_limited');
          throw error;
        });
    const stored = await this.findById(record.id);
    if (!stored) throw new AppError('not_found', 'evidence owner or live incident unavailable');
    if (stored.ownerUid !== record.ownerUid || stored.alertId !== record.alertId ||
        (stored.uploaded && stored.sha256 ? stored.storagePath.split('/published/')[0] : stored.storagePath) !== record.storagePath || stored.contentType !== record.contentType ||
        stored.kind !== record.kind || stored.durationMs !== record.durationMs) {
      throw new AppError('conflict', 'evidence metadata is immutable');
    }
    if (rowCount === 0 && stored.uploaded) return stored;
    return stored;
  }

  async findById(id: string): Promise<EvidenceRecord | null> {
    if (!uuid(id)) return null;
    const { rows } = await this.db.query<EvidenceRow>(`${SELECT} WHERE e.id = $1::uuid`, [id]);
    return rows[0] ? map(rows[0]) : null;
  }

  async listForAlert(alertId: string): Promise<EvidenceRecord[]> {
    if (!uuid(alertId)) return [];
    const { rows } = await this.db.query<EvidenceRow>(
      `${SELECT} WHERE e.alert_id = $1::uuid ORDER BY e.created_at, e.id`, [alertId]);
    return rows.map(map);
  }

  async listForOwner(ownerUid: string): Promise<EvidenceRecord[]> {
    if (!ownerUid || ownerUid.includes('\u0000')) return [];
    const { rows } = await this.db.query<EvidenceRow>(
      `${SELECT} WHERE m.firebase_uid = $1 ORDER BY e.created_at, e.id`, [ownerUid]);
    return rows.map(map);
  }

  private async owned(id: string): Promise<EvidenceRecord> {
    if(!uuid(id))throw new AppError('not_found');
    const {rows}=await this.db.query<EvidenceRow>(`${SELECT} WHERE e.id=$1::uuid AND e.owner_id=auth.uid()`,[id]);
    if(!rows[0])throw new AppError('not_found');return map(rows[0]);
  }
  async markPublished(id: string, source: string, publication: PublishedEvidence): Promise<EvidenceRecord> {
    assertPublication(source,publication);
    const current=await this.owned(id);
    if(current.uploaded && current.sha256 && current.storagePath.includes('/published/')){
      if(current.sha256!==publication.sha256||current.sizeBytes!==publication.sizeBytes)throw new AppError('conflict');
      return current;
    }
    const {rowCount}=await this.db.query(`UPDATE evidence SET state='stored',r2_key=$2,
      size_bytes=$3,actual_sha256=$4,completed_at=COALESCE(completed_at,now())
      WHERE id=$1::uuid AND owner_id=auth.uid() AND r2_key=$5
        AND state IN ('pending_upload','stored')
        AND (actual_sha256 IS NULL OR actual_sha256=$4)
        AND (declared_sha256 IS NULL OR declared_sha256=$4)`,
      [id,publication.storagePath,publication.sizeBytes,publication.sha256,source]);
    if(rowCount!==1){
      const winner=await this.findById(id);
      if(winner?.uploaded && winner.sha256===publication.sha256 && winner.sizeBytes===publication.sizeBytes)return winner;
      throw new AppError('conflict');
    }
    const updated=await this.findById(id);if(!updated)throw new AppError('not_found');return updated;
  }
  async markUploaded(id: string, sizeBytes: number | null): Promise<EvidenceRecord> {
    const record=await this.owned(id);
    if(!this.integrity?.publish)throw Error('trusted immutable publisher is required before finalization');
    if(record.uploaded && record.sha256 && record.storagePath.includes('/published/'))return record;
    const result=await this.integrity.publish(record.storagePath,record.contentType);
    if(sizeBytes!==null&&sizeBytes!==result.sizeBytes)throw new AppError('invalid_request');
    return this.markPublished(id,record.storagePath,result);
  }

  async deleteAllForOwner(ownerUid: string): Promise<number> {
    if (!ownerUid || ownerUid.includes('\u0000')) return 0;
    const { rowCount } = await this.db.query(
      `DELETE FROM evidence WHERE owner_id = auth.uid()
        AND owner_id = (SELECT user_id FROM identity_map WHERE firebase_uid = $1)`, [ownerUid]);
    return rowCount ?? 0;
  }
}
