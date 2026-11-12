import { AppError } from '../errors.js';
import { isAllowedContentType, type EvidenceStore } from '../evidence/EvidenceStore.js';
import { isTerminalStatus, type AlertRepository, type EvidenceRepository, type EvidenceKind } from '../repositories/types.js';
import { finalizeEvidence } from './finalizeEvidence.js';
export interface OwnerEvidenceDependencies {
  alerts: AlertRepository; evidence: EvidenceRepository; evidenceStore: EvidenceStore;
}
export const evidenceCreateSchema = {
  type: 'object', required: ['contentType'], additionalProperties: false,
  properties: {
    contentType: { type: 'string', maxLength: 100 },
    durationMs: { type: ['number', 'null'], minimum: 0, maximum: 3600000 },
    kind: { type: 'string', enum: ['deliberate', 'automatic'] },
    evidenceId:{type:'string',pattern:'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'},
    incidentKey:{type:'string',minLength:1,maxLength:128},
  },
} as const;
export interface EvidenceCreateBody { contentType: string; durationMs?: number | null; kind?: EvidenceKind;evidenceId?:string;incidentKey?:string; }
export async function issueEvidence(deps: OwnerEvidenceDependencies, uid: string, id: string, body: EvidenceCreateBody) {
  const alert = await deps.alerts.findById(id);
  if (!alert || alert.ownerId !== uid) throw new AppError('not_found');
  if(body.incidentKey!==undefined&&body.incidentKey!==alert.key)throw new AppError('not_found');
  const evidenceId = body.evidenceId??crypto.randomUUID();
  const existing=await deps.evidence.findById(evidenceId);
  if(existing){
    if(existing.ownerUid!==uid||existing.alertId!==id||existing.alertKey!==alert.key||existing.contentType!==body.contentType||
      existing.durationMs!==(body.durationMs??null)||existing.kind!==(body.kind==='deliberate'?'deliberate':'automatic'))throw new AppError('conflict');
    if(existing.uploaded)return {evidenceId,evidence:{id:evidenceId,uploaded:true,sizeBytes:existing.sizeBytes}};
  }
  if (isTerminalStatus(alert.status) || alert.expiresAt <= new Date()) throw new AppError('alert_closed');
  if (!isAllowedContentType(body.contentType)) throw new AppError('invalid_request');
  if (!existing&&(await deps.evidence.listForAlert(id)).filter(r => r.alertKey === alert.key).length >= 20) throw new AppError('rate_limited');
  const ticket = await deps.evidenceStore.createUploadTicket({ ownerUid: uid, alertId: id, evidenceId, contentType: body.contentType });
  const admitted=await deps.evidence.create({
    id: evidenceId, alertId: id, alertKey: alert.key, kind: body.kind === 'deliberate' ? 'deliberate' : 'automatic',
    ownerUid: uid, storagePath: ticket.storagePath, contentType: ticket.contentType, sizeBytes: null,
    durationMs: body.durationMs ?? null, createdAt: new Date(), uploaded: false
  });
  if(admitted.uploaded)return {evidenceId,evidence:{id:evidenceId,uploaded:true,sizeBytes:admitted.sizeBytes}};
  return { evidenceId, upload: { url: ticket.url, method: 'PUT', expiresAt: ticket.expiresAt.toISOString(), headers: { 'content-type': ticket.contentType } } };
}
export async function completeEvidence(deps: OwnerEvidenceDependencies, uid: string, id: string) {
  const record = await deps.evidence.findById(id);
  if (!record || record.ownerUid !== uid) throw new AppError('not_found');
  const updated = await finalizeEvidence(record, deps.evidenceStore, deps.evidence);
  return { evidence: { id: updated.id, uploaded: true, sizeBytes: updated.sizeBytes } };
}
export async function listOwnerEvidence(deps: OwnerEvidenceDependencies, uid: string, id: string) {
  const alert = await deps.alerts.findById(id);
  if (!alert || alert.ownerId !== uid) throw new AppError('not_found');
  const records = await deps.evidence.listForAlert(id);
  const evidence = await Promise.all(records.filter(r => r.alertKey === alert.key).map(async r => {
    const playback = r.uploaded ? await deps.evidenceStore.createPlaybackUrl(r.storagePath, 300000) : null;
    return {
      id: r.id, uploaded: r.uploaded, contentType: r.contentType, durationMs: r.durationMs, sizeBytes: r.sizeBytes,
      kind: r.kind, createdAt: r.createdAt.toISOString(),
      ...(playback ? { url: playback.url, urlExpiresAt: playback.expiresAt.toISOString() } : {}),
    };
  }));
  return { evidence };
}
