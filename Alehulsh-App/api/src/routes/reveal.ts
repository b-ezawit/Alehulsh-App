import type { FastifyInstance } from 'fastify';
import { requireSubject, subjectOf } from '../auth/middleware.js';
import { AppError } from '../errors.js';
import { distanceMetres } from '../geo.js';
import type { Deps } from '../server.js';
import type { LocationRevealAttempt } from '../repositories/types.js';

/**
 * POST /v1/alerts/:id/reveal — staged location reveal.  (P2-08)
 *
 * Today emergency_screen.dart sends exact coordinates and a Maps link to every
 * responder in range. This replaces that with the model in P1-01 §4: a
 * responder gets the snapped ~150m cell at fan-out, and the true position only
 * once she has accepted AND is physically close.
 *
 * THE GOVERNING CONSTRAINT: the response must carry no distance, no bearing,
 * and no "closer / warmer" signal of any kind.
 *
 * The reported position is unverified — we cannot know where the caller
 * actually is. If the denial told him how far off he was, three queries would
 * trilaterate her exactly, and the 150m cell would become a pointer to her
 * doorstep. So a denial is a single opaque state. This costs real usability:
 * a genuine responder standing 60m away is told only "not yet". That is the
 * right trade, and it is the reason the endpoint exists at all rather than the
 * client simply being handed coordinates.
 *
 * responder-projection.md §4 is honest that this is a speed bump rather than a
 * boundary. The load-bearing protections are the other three, and all three are
 * enforced here: only selected responders reach this code, every release is
 * logged and attributable, and access dies with the alert.
 */
const bodySchema = {
  type: 'object',
  required: ['latitude', 'longitude'],
  additionalProperties: false,
  properties: {
    latitude: { type: 'number', minimum: -90, maximum: 90 },
    longitude: { type: 'number', minimum: -180, maximum: 180 },
  },
} as const;

interface Body { latitude: number; longitude: number }

/** Every denial, whatever the cause, looks like this. Do not add a field. */
const DENIED = { granted: false } as const;

export function registerRevealRoute(app: FastifyInstance, deps: Deps): void {
  app.post<{ Params: { id: string }; Body: Body }>(
    '/v1/alerts/:id/reveal',
    { schema: { body: bodySchema }, preHandler: requireSubject(deps.tokenVerifier) },
    async (req, reply) => {
      const { uid } = subjectOf(req);
      const alertId = req.params.id;
      const now = new Date();

      // Selection first, as in accept: an alert you were not sent is
      // indistinguishable from one that does not exist.
      const projection = await deps.inbox.get(uid, alertId);
      if (!projection) {
        throw new AppError('not_found', `alert ${alertId} was not sent to ${uid}`);
      }

      const audit = async (
        granted: boolean,
        distanceM: number | null,
        deniedReason?: LocationRevealAttempt['deniedReason'],
      ) => {
        await deps.reveals.append({
          alertId, responderUid: uid, at: now,
          claimedLat: req.body.latitude, claimedLng: req.body.longitude,
          distanceM, granted, ...(deniedReason ? { deniedReason } : {}),
        });
      };

      // Throttle before doing anything else. The cap is what turns "guess
      // positions until one lands inside 50m" from a few seconds of scripting
      // into something slow enough to notice. Counted per alert per responder,
      // and a throttled attempt is still recorded — the attempts are the
      // signal.
      const since = new Date(now.getTime() - deps.config.revealAttemptWindowMs);
      const recent = await deps.reveals.countSince(alertId, uid, since);
      if (recent >= deps.config.revealAttemptCap) {
        await audit(false, null, 'throttled');
        deps.logger.warn('reveal throttled', { alertId, subject: uid, recent });
        // Same body as any other denial. A 429 here would confirm to a prober
        // that he is being counted, and tell him when to resume.
        return reply.send(DENIED);
      }

      const alert = await deps.alerts.findById(alertId);
      if (!alert) {
        deps.logger.error('orphaned inbox projection', { alertId, subject: uid });
        throw new AppError('not_found', `alert ${alertId} no longer exists`);
      }

      // Access dies with the alert — responder-projection.md §4. Not a denial:
      // the responder needs to stop, and alert_closed says so without saying
      // which terminal state it was.
      if (alert.status === 'resolved' || alert.status === 'expired') {
        throw new AppError('alert_closed', `alert ${alertId} is ${alert.status}`);
      }

      const accepted = await deps.acceptances.findFor(alertId, uid);
      if (!accepted) {
        await audit(false, null, 'not_accepted');
        return reply.send(DENIED);
      }

      if (alert.latitude === null || alert.longitude === null) {
        // We never knew where she was. There is nothing to reveal, and
        // fabricating a position would be P1-17 all over again.
        await audit(false, null, 'alert_has_no_location');
        return reply.send(DENIED);
      }

      const distanceM = distanceMetres(
        req.body.latitude, req.body.longitude, alert.latitude, alert.longitude,
      );

      if (distanceM > deps.config.revealRadiusM) {
        await audit(false, distanceM, 'too_far');
        return reply.send(DENIED);
      }

      // Written before the coordinates are returned, not after. If the append
      // throws, the request fails and nothing is released — an unlogged reveal
      // must not be possible.
      await audit(true, distanceM);
      deps.logger.info('precise location released', {
        alertId, subject: uid, distanceM: Math.round(distanceM),
      });

      return reply.send({
        granted: true,
        location: {
          latitude: alert.latitude,
          longitude: alert.longitude,
          precision: 'exact',
        },
      });
    },
  );
}

/** C-16, as with acceptances. A store deletion does not know about is a lie. */
export function revealDeletableStore(repo: {
  deleteAllForResponder(uid: string): Promise<number>;
}): { readonly name: string; purge(uid: string): Promise<number> } {
  return { name: 'location_reveals', purge: (uid) => repo.deleteAllForResponder(uid) };
}
