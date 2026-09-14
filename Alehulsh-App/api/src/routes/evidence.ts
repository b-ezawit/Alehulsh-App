import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { requireSubject, subjectOf } from '../auth/middleware.js';
import { AppError } from '../errors.js';
import { isAllowedContentType } from '../evidence/EvidenceStore.js';
import type { Deps } from '../server.js';

/**
 * Evidence upload and playback.  (P2-10.3, P2-10.4)
 *
 * Today audio_recording_service.dart base64-encodes the recording into the
 * alert document. Firestore's 1MiB document limit caps that at roughly ninety
 * seconds, after which the write fails — and the failure is swallowed, so a
 * woman who recorded five minutes of an assault has no recording and no idea.
 *
 * Here the bytes go to object storage and the database holds a path. Three
 * things the old design could not do:
 *
 *   the recording can be any length;
 *   a failed upload is a visible state (`uploaded: false`) rather than silence;
 *   nothing is ever publicly readable — playback is a short-lived signed URL
 *     issued per request, to a caller we authorized for that specific object.
 *
 * DELIBERATELY NOT IMPLEMENTED: responder playback. The projection design
 * (docs/responder-projection.md §2) says a responder may hear the voice note
 * once she has accepted, and the plumbing for that is all present here. It is
 * left off because letting a stranger listen to a recording made during an
 * assault is a product and privacy decision, not an implementation detail, and
 * it needs an explicit yes. Until then: owner only.
 */
const MAX_EVIDENCE_PER_ALERT = 20;
const PLAYBACK_TTL_MS = 5 * 60 * 1000;

const createSchema = {
  type: 'object',
  required: ['contentType'],
  additionalProperties: false,
  properties: {
    contentType: { type: 'string', maxLength: 100 },
    durationMs: { type: ['number', 'null'], minimum: 0, maximum: 60 * 60 * 1000 },
  },
} as const;

interface CreateBody { contentType: string; durationMs?: number | null }

export function registerEvidenceRoutes(app: FastifyInstance, deps: Deps): void {
  /** Ask for somewhere to put a recording. Owner only. */
  app.post<{ Params: { id: string }; Body: CreateBody }>(
    '/v1/alerts/:id/evidence',
    { schema: { body: createSchema }, onRequest: requireSubject(deps.tokenVerifier) },
    async (req, reply) => {
      const { uid } = subjectOf(req);
      const alert = await deps.alerts.findById(req.params.id);

      // Same shape as resolve: not hers and not existing are indistinguishable.
      if (!alert || alert.ownerId !== uid) {
        throw new AppError('not_found', `alert ${req.params.id} not visible to ${uid}`);
      }
      if (alert.status === 'resolved' || alert.status === 'expired') {
        throw new AppError('alert_closed', `alert ${alert.id} is ${alert.status}`);
      }
      if (!isAllowedContentType(req.body.contentType)) {
        // Allowlist, not a passthrough. The signature binds the ticket to this
        // type, so anything we accept here is what the bucket will accept.
        throw new AppError('invalid_request', `content type ${req.body.contentType} not allowed`);
      }

      const existing = await deps.evidence.listForAlert(alert.id);
      if (existing.length >= MAX_EVIDENCE_PER_ALERT) {
        throw new AppError('rate_limited', `alert ${alert.id} already has ${existing.length} items`);
      }

      const evidenceId = randomUUID();
      const ticket = await deps.evidenceStore.createUploadTicket({
        ownerUid: uid, alertId: alert.id, evidenceId, contentType: req.body.contentType,
      });

      // Recorded before the upload, not after. An interrupted upload then
      // leaves a row marked `uploaded: false` — a visible gap we can retry or
      // report, instead of a recording nobody knows was attempted.
      await deps.evidence.create({
        id: evidenceId,
        alertId: alert.id,
        // Which alert instance this belongs to. alert.id is her uid and is the
        // same for every alert she raises; without this a recording cannot be
        // attributed to one incident.
        alertKey: alert.key,
        ownerUid: uid,
        storagePath: ticket.storagePath,
        contentType: ticket.contentType,
        sizeBytes: null,
        durationMs: req.body.durationMs ?? null,
        createdAt: new Date(),
        uploaded: false,
      });

      deps.logger.info('evidence ticket issued', { alertId: alert.id, subject: uid, evidenceId });

      return reply.status(201).send({
        evidenceId,
        upload: {
          url: ticket.url,
          method: 'PUT',
          expiresAt: ticket.expiresAt.toISOString(),
          // The client must send this header or the signature will not match.
          headers: { 'content-type': ticket.contentType },
        },
      });
    },
  );

  /** Confirm the PUT landed. Until this runs the item counts as missing. */
  app.post<{ Params: { evidenceId: string } }>(
    '/v1/evidence/:evidenceId/complete',
    {
      schema: { body: { type: 'object', additionalProperties: false, properties: {} } },
      onRequest: requireSubject(deps.tokenVerifier),
    },
    async (req, reply) => {
      const { uid } = subjectOf(req);
      const record = await deps.evidence.findById(req.params.evidenceId);
      if (!record || record.ownerUid !== uid) {
        throw new AppError('not_found', `evidence ${req.params.evidenceId} not visible to ${uid}`);
      }

      // Verified against the bucket, never taken on the client's word. A
      // client that crashed mid-PUT would otherwise mark its own upload
      // complete and the gap would close silently.
      if (!(await deps.evidenceStore.exists(record.storagePath))) {
        throw new AppError('not_found', `object for ${record.id} is not present`);
      }

      const size = await deps.evidenceStore.sizeOf(record.storagePath);
      const updated = await deps.evidence.markUploaded(record.id, size);
      deps.logger.info('evidence upload confirmed', {
        alertId: record.alertId, subject: uid, evidenceId: record.id, sizeBytes: size,
      });

      return reply.send({
        evidence: { id: updated.id, uploaded: true, sizeBytes: updated.sizeBytes },
      });
    },
  );

  /** Her own evidence, with short-lived playback URLs. */
  app.get<{ Params: { id: string } }>(
    '/v1/alerts/:id/evidence',
    { onRequest: requireSubject(deps.tokenVerifier) },
    async (req, reply) => {
      const { uid } = subjectOf(req);
      const alert = await deps.alerts.findById(req.params.id);
      if (!alert || alert.ownerId !== uid) {
        throw new AppError('not_found', `alert ${req.params.id} not visible to ${uid}`);
      }

      const records = await deps.evidence.listForAlert(alert.id);
      const items = await Promise.all(records.map(async (r) => {
        // No URL for something that never finished uploading — a signed URL to
        // a missing object is a broken player and a confusing lie.
        const playback = r.uploaded
          ? await deps.evidenceStore.createPlaybackUrl(r.storagePath, PLAYBACK_TTL_MS)
          : null;
        return {
          id: r.id,
          uploaded: r.uploaded,
          contentType: r.contentType,
          durationMs: r.durationMs,
          sizeBytes: r.sizeBytes,
          createdAt: r.createdAt.toISOString(),
          // storagePath is deliberately not returned. It is an internal
          // address; the client needs the URL, never the location.
          ...(playback
            ? { url: playback.url, urlExpiresAt: playback.expiresAt.toISOString() }
            : {}),
        };
      }));

      return reply.send({ evidence: items });
    },
  );
}

/** C-16 — the database rows. The objects themselves go via the store. */
export function evidenceDeletableStores(
  repo: { deleteAllForOwner(uid: string): Promise<number> },
  store: { removeAllForOwner(uid: string): Promise<number> },
): Array<{ readonly name: string; purge(uid: string): Promise<number> }> {
  return [
    // Objects first. If the process dies between the two, an orphaned row
    // pointing at nothing is recoverable; an orphaned recording is not.
    { name: 'evidence_objects', purge: (uid) => store.removeAllForOwner(uid) },
    { name: 'evidence_records', purge: (uid) => repo.deleteAllForOwner(uid) },
  ];
}
