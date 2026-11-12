import { evidenceCreateSchema, issueEvidence, completeEvidence, listOwnerEvidence, type EvidenceCreateBody } from '../services/ownerEvidence.js';
import { isTerminalStatus } from '../repositories/types.js';
import type { FastifyInstance } from 'fastify';
import { requireSubject, subjectOf } from '../auth/middleware.js';
import { AppError } from '../errors.js';
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
 * RESPONDER PLAYBACK is below, and it is limited to recordings she chose to
 * make and send. docs/data-decisions.md §3: an automatic capture started by
 * the SOS trigger can contain anything that happened to be audible — her
 * address, other people's conversations, a child — and she made no decision to
 * share any of it. Tapping "accept" does not earn that. Deliberate notes only.
 */
const PLAYBACK_TTL_MS = 5 * 60 * 1000;
export function registerEvidenceRoutes(app: FastifyInstance, deps: Deps): void {
  app.post<{ Params: { id: string; }; Body: EvidenceCreateBody; }>('/v1/alerts/:id/evidence', {
    schema: { body: evidenceCreateSchema }, onRequest: requireSubject(deps.tokenVerifier),
  }, async (req, reply) => reply.status(201).send(await issueEvidence(deps, subjectOf(req).uid, req.params.id, req.body)));
  app.post<{ Params: { evidenceId: string; }; }>('/v1/evidence/:evidenceId/complete', {
    schema: { body: { type: 'object', additionalProperties: false, properties: {} } }, onRequest: requireSubject(deps.tokenVerifier),
  }, async (req, reply) => reply.send(await completeEvidence(deps, subjectOf(req).uid, req.params.evidenceId)));
  app.get<{ Params: { id: string; }; }>('/v1/alerts/:id/evidence', {
    onRequest: requireSubject(deps.tokenVerifier),
  }, async (req, reply) => reply.send(await listOwnerEvidence(deps, subjectOf(req).uid, req.params.id)));
}

/**
 * GET /v1/alerts/:id/evidence/responder — what a responder may hear.
 *
 * Four conditions, all required, none of them the client's word for it:
 *
 *   she was SELECTED for this alert (holds an inbox projection);
 *   she has ACCEPTED it (P1-10) — tapping accept is the act that earns this;
 *   the alert is STILL LIVE — access ends when the alert does, it does not
 *     linger because a responder stayed interested;
 *   the recording is DELIBERATE — see data-decisions.md §3.
 *
 * Every playback URL issued here is logged and attributable, on the same
 * reasoning as a location reveal: the load-bearing protection is not that the
 * link expires, it is that we can say afterwards exactly who was given access
 * to what, and when.
 */
export function registerResponderEvidenceRoute(app: FastifyInstance, deps: Deps): void {
  app.get<{ Params: { id: string; }; }>(
    '/v1/alerts/:id/evidence/responder',
    { onRequest: requireSubject(deps.tokenVerifier) },
    async (req, reply) => {
      const { uid } = subjectOf(req);
      const alertId = req.params.id;

      // Selection first, so an alert she was never sent is indistinguishable
      // from one that does not exist.
      const projection = await deps.inbox.get(uid, alertId);
      if (!projection) {
        throw new AppError('not_found', `alert ${alertId} was not sent to ${uid}`);
      }

      const alert = await deps.alerts.findById(alertId);
      if (!alert) {
        deps.logger.error('orphaned inbox projection', { alertId, subject: uid });
        throw new AppError('not_found', `alert ${alertId} no longer exists`);
      }
      if (isTerminalStatus(alert.status) || alert.expiresAt <= new Date()) {
        throw new AppError('alert_closed', `alert ${alertId} is ${alert.status}`);
      }

      const accepted = await deps.acceptances.findFor(alertId, uid);
      if (!accepted) {
        // Not an error state — she simply has not accepted yet. Returning an
        // empty list rather than a 403 keeps the client simple and tells a
        // prober nothing about whether recordings exist.
        return reply.send({ evidence: [] });
      }

      const all = await deps.evidence.listForAlert(alertId);
      const audible = all.filter(
        (e) => e.uploaded && e.kind === 'deliberate' && e.alertKey === alert.key,
      );

      const items = await Promise.all(audible.map(async (e) => {
        const playback = await deps.evidenceStore.createPlaybackUrl(e.storagePath, PLAYBACK_TTL_MS);
        // Written per item, before the URL goes out.
        deps.logger.info('responder granted voice note playback', {
          alertId, subject: uid, evidenceId: e.id,
        });
        return {
          id: e.id,
          contentType: e.contentType,
          durationMs: e.durationMs,
          createdAt: e.createdAt.toISOString(),
          url: playback.url,
          urlExpiresAt: playback.expiresAt.toISOString(),
        };
      }));

      const [latest, selected, stillAccepted] = await Promise.all([
        deps.alerts.findById(alertId), deps.inbox.get(uid, alertId), deps.acceptances.findFor(alertId, uid),
      ]);
      if (!latest || latest.key !== alert.key || isTerminalStatus(latest.status) || latest.expiresAt <= new Date() ||
        !selected || !stillAccepted || (selected.alertKey !== undefined && selected.alertKey !== alert.key) ||
        (stillAccepted.alertKey !== undefined && stillAccepted.alertKey !== alert.key)) throw new AppError('alert_closed');
      return reply.send({ evidence: items });
    },
  );
}

/** C-16 — the database rows. The objects themselves go via the store. */
export function evidenceDeletableStores(
  repo: { deleteAllForOwner(uid: string): Promise<number>; },
  store: { removeAllForOwner(uid: string): Promise<number>; },
): Array<{ readonly name: string; purge(uid: string): Promise<number>; }> {
  return [
    // Objects first. If the process dies between the two, an orphaned row
    // pointing at nothing is recoverable; an orphaned recording is not.
    { name: 'evidence_objects', purge: (uid) => store.removeAllForOwner(uid) },
    { name: 'evidence_records', purge: (uid) => repo.deleteAllForOwner(uid) },
  ];
}
