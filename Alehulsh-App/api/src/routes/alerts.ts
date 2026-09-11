import type { FastifyInstance } from 'fastify';
import { requireSubject, subjectOf } from '../auth/middleware.js';
import { AppError } from '../errors.js';
import type { Deps } from '../server.js';

/**
 * POST /v1/alerts — raise an SOS.  (P1-08)
 *
 * The client no longer writes the alert. This is what lets the server stamp its
 * own clock, enforce idempotency, and schedule the escalation that
 * docs/coercion-and-escalation.md depends on.
 */
const bodySchema = {
  type: 'object',
  required: ['requestId'],
  additionalProperties: false,
  properties: {
    // Client-generated, stable across retries. Idempotency key.
    requestId: { type: 'string', minLength: 8, maxLength: 128 },
    // Nullable on purpose. P1-17 removed the fabricated Addis fallback —
    // "we do not know where she is" is a real state and must survive the wire.
    latitude: { type: ['number', 'null'], minimum: -90, maximum: 90 },
    longitude: { type: ['number', 'null'], minimum: -180, maximum: 180 },
  },
} as const;

interface Body {
  requestId: string;
  latitude?: number | null;
  longitude?: number | null;
}

export function registerAlertRoutes(app: FastifyInstance, deps: Deps): void {
  app.post<{ Body: Body }>(
    '/v1/alerts',
    { schema: { body: bodySchema }, preHandler: requireSubject(deps.tokenVerifier) },
    async (req, reply) => {
      const { uid } = subjectOf(req);
      const lat = req.body.latitude ?? null;
      const lon = req.body.longitude ?? null;

      // Half a fix is not a fix. Accepting one coordinate would put her on the
      // equator or the prime meridian.
      if ((lat === null) !== (lon === null)) {
        throw new AppError('invalid_request', 'latitude and longitude must both be present or both absent');
      }

      const { alert, created } = await deps.alerts.create({
        requestId: req.body.requestId,
        ownerId: uid,
        latitude: lat,
        longitude: lon,
      });

      if (created) {
        // Scheduled, not polled, so it can be cancelled the moment she resolves.
        await deps.queue.schedule({
          key: `safety-check:${alert.id}:${alert.createdAt.getTime()}`,
          runAt: new Date(alert.createdAt.getTime() + deps.config.safetyCheckDelayMs),
          payload: { kind: 'safety-check', alertId: alert.id },
        });
        // Backstop. Reaching this means escalation did not run —
        // alert-lifecycle.md §2 treats `expired` as a bug signal.
        await deps.queue.schedule({
          key: `expiry:${alert.id}:${alert.createdAt.getTime()}`,
          runAt: alert.expiresAt,
          payload: { kind: 'expiry', alertId: alert.id },
        });
      }

      deps.logger.info(created ? 'alert created' : 'alert re-trigger folded into existing', {
        alertId: alert.id,
        subject: uid,
        hasLocation: lat !== null,
      });

      // 201 for a new alert, 200 when an existing one was returned, so the
      // client can tell a retry from a fresh dispatch.
      return reply.status(created ? 201 : 200).send({
        alert: {
          id: alert.id,
          status: alert.status,
          createdAt: alert.createdAt.toISOString(),
          expiresAt: alert.expiresAt.toISOString(),
          hasLocation: alert.latitude !== null,
        },
      });
    },
  );
}
