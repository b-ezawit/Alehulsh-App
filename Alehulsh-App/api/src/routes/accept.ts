import type { FastifyInstance } from 'fastify';
import { requireSubject, subjectOf } from '../auth/middleware.js';
import { AppError } from '../errors.js';
import type { Deps } from '../server.js';
import type { Acceptance, AlertProjection } from '../repositories/types.js';

/**
 * POST /v1/alerts/:id/accept — a responder answers.  (P1-10)
 *
 * Replaces the client-side write removed by P0-07, where any authenticated
 * user could append to `responders` on any alert (CRIT-03). The same clause
 * let them overwrite `voiceNotes`, so the bug was not only impersonation but
 * remote evidence destruction.
 *
 * Two properties the old write could not have, both from the acceptance
 * criteria:
 *
 *   only yourself — the uid comes from the verified token. There is no uid in
 *     the request at all, so there is nothing to forge;
 *   only an alert you were told about — proven by holding an inbox
 *     projection, which only the fan-out writes.
 *
 * What it deliberately does not do:
 *
 *   it does not change the alert's status (alert-lifecycle.md §6 — a helper
 *     en route is not a safety confirmation, and treating it as one would let
 *     an attacker who registers as a helper silence his victim's alert);
 *   it does not cancel the safety check or escalation, for the same reason;
 *   it does not return exact coordinates. Accepting is the precondition for
 *     staged reveal (P2-08), not the reveal itself.
 */
export function registerAcceptRoute(app: FastifyInstance, deps: Deps): void {
  app.post<{ Params: { id: string } }>(
    '/v1/alerts/:id/accept',
    {
      // No body. (alertId, uid) is the natural key, so a replay is the same
      // request rather than something needing an idempotency token.
      schema: { body: { type: 'object', additionalProperties: false, properties: {} } },
      preHandler: requireSubject(deps.tokenVerifier),
    },
    async (req, reply) => {
      const { uid } = subjectOf(req);
      const alertId = req.params.id;

      // Authorization before existence. Asking the inbox first means an alert
      // the caller was never sent is indistinguishable from one that does not
      // exist — same `not_found` body either way (errors.ts), so the endpoint
      // cannot be used to enumerate live alerts or to discover that an
      // emergency is happening somewhere the caller was not selected for.
      const projection = await deps.inbox.get(uid, alertId);
      if (!projection) {
        throw new AppError('not_found', `alert ${alertId} was not sent to ${uid}`);
      }

      const alert = await deps.alerts.findById(alertId);
      if (!alert) {
        // A projection outliving its alert is a retraction that did not finish.
        // Loud: it means someone is holding a view of an emergency that the
        // system believes is over.
        deps.logger.error('orphaned inbox projection', { alertId, subject: uid });
        throw new AppError('not_found', `alert ${alertId} no longer exists`);
      }

      // Closed. One code for every terminal state on purpose: the responder
      // needs to know to stand down, and does not need to know whether she
      // resolved, was escalated, or the alert expired unanswered.
      if (alert.status === 'resolved' || alert.status === 'expired') {
        throw new AppError('alert_closed', `alert ${alertId} is ${alert.status}`);
      }

      const { acceptance, created } = await deps.acceptances.record({
        alertId,
        responderUid: uid,
        acceptedAt: new Date(),
        audience: projection.audience,
      });

      // Attributable and kept, per responder-projection.md §4: when precise
      // location is later released, this is the record of who was standing
      // where in the sequence, and it is written before any release happens.
      deps.logger.info(created ? 'alert accepted' : 'acceptance replayed', {
        alertId,
        subject: uid,
        audience: acceptance.audience,
      });

      return reply.status(created ? 201 : 200).send({
        acceptance: {
          alertId: acceptance.alertId,
          acceptedAt: acceptance.acceptedAt.toISOString(),
          audience: acceptance.audience,
        },
        // Echoed back unchanged. Accepting grants no additional detail — the
        // client should show what it already had, and `precision` says plainly
        // that this is still a cell, not a position.
        alert: viewOf(projection, alert.status),
      });
    },
  );
}

function viewOf(p: AlertProjection, status: string): Record<string, unknown> {
  return {
    id: p.alertId,
    status,
    latitude: p.fuzzedLat,
    longitude: p.fuzzedLng,
    precision: p.fuzzedPrecision,
    hasVoiceNote: p.hasVoiceNote,
    createdAt: p.createdAt.toISOString(),
  };
}

/**
 * Adapter so account deletion reaches acceptances too.  (P2-20 · C-16)
 *
 * Registered at composition. A store the deleter does not know about is data
 * she was told had been erased and has not been.
 */
export function acceptanceDeletableStore(repo: {
  deleteAllForResponder(uid: string): Promise<number>;
}): { readonly name: string; purge(uid: string): Promise<number> } {
  return {
    name: 'acceptances',
    purge: (uid) => repo.deleteAllForResponder(uid),
  };
}

export type { Acceptance };
