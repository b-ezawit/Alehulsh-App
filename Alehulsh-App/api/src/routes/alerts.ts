import type { FastifyInstance } from 'fastify';
import { requireSubject, subjectOf } from '../auth/middleware.js';
import { AppError } from '../errors.js';
import type { Deps } from '../server.js';
import { taskKeys } from '../tasks.js';

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
    { schema: { body: bodySchema }, onRequest: requireSubject(deps.tokenVerifier) },
    async (req, reply) => {
      const { uid } = subjectOf(req);
      const lat = req.body.latitude ?? null;
      const lon = req.body.longitude ?? null;

      // Half a fix is not a fix. Accepting one coordinate would put her on the
      // equator or the prime meridian.
      if ((lat === null) !== (lon === null)) {
        throw new AppError('invalid_request', 'latitude and longitude must both be present or both absent');
      }

      // Rate limiting (P1-15) — and the two things it must never do.
      //
      // 1. It must never touch a live emergency. If she already has an active
      //    or escalated alert this request folds into it rather than creating
      //    anything, so the limiter is skipped entirely. A woman re-triggering
      //    during an ongoing emergency is the one case where being wrong is
      //    unforgivable, and the cheapest way to be right is not to ask.
      // 2. It must not ration emergencies. The cap is an abuse ceiling for
      //    scripts, set far above anything a person does: twenty distinct
      //    alerts in an hour is not someone in trouble twenty times, it is
      //    automation. Below it nothing is throttled, delayed or degraded.
      //
      // NOT IMPLEMENTED, deliberately: the per-device half of this task. It
      // needs a persistent device identifier, which is a tracking vector this
      // app should not create (CLAUDE.md §6) — and every alert already requires
      // an authenticated account, so the per-user cap covers the same abuse
      // without the new identifier. Revisit only if accounts become cheap
      // enough to script.
      const live = await deps.alerts.findActiveByOwner(uid);
      if (!live) {
        const { allowed, count } = await deps.limiter.hit(
          `alert:create:${uid}`, deps.config.alertCreateCap, deps.config.alertCreateWindowMs,
        );
        if (!allowed) {
          // error, not warn: if this fires for a real person we have refused
          // someone an emergency alert and need to know immediately.
          deps.logger.error('alert creation refused — abuse ceiling reached', {
            subject: uid, count, cap: deps.config.alertCreateCap,
          });
          throw new AppError('rate_limited', `${count} alerts in window for ${uid}`);
        }
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
          key: taskKeys.safetyCheck(alert),
          runAt: new Date(alert.createdAt.getTime() + deps.config.safetyCheckDelayMs),
          payload: { kind: 'safety-check', alertId: alert.id },
        });
        // Backstop. Reaching this means escalation did not run —
        // alert-lifecycle.md §2 treats `expired` as a bug signal.
        await deps.queue.schedule({
          key: taskKeys.expiry(alert),
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
