import type { FastifyInstance } from 'fastify';
import { requireTaskRunner } from '../auth/taskAuth.js';
import type { Deps } from '../server.js';
import { taskKeys } from '../tasks.js';

/**
 * Internal task endpoints.  (P3-06)
 *
 * The safety check is the mechanism docs/coercion-and-escalation.md rests on,
 * and it does not exist in the shipped app at all: a wrong keyword shows red
 * text and nothing happens, and an unanswered check does nothing either.
 *
 * Scheduled rather than polled. A cron sweeping for due alerts cannot express
 * "fire in two minutes unless she resolves first" without either a coarse
 * window or a table scan, and the window is the part that matters — two
 * minutes late is two minutes of her not being helped.
 *
 * Every handler is idempotent. At-least-once delivery is the normal case for
 * any queue, so a redelivered task must not escalate twice or notify her
 * contacts twice.
 */
const bodySchema = {
  type: 'object',
  required: ['alertId'],
  additionalProperties: false,
  properties: { alertId: { type: 'string', minLength: 1, maxLength: 128 } },
} as const;

export function registerTaskRoutes(app: FastifyInstance, deps: Deps): void {
  const preHandler = requireTaskRunner(deps.config.taskRunnerSecret);

  /**
   * The safety check window has elapsed with no answer.
   * coercion-and-escalation.md §4: silence is not consent.
   */
  app.post<{ Body: { alertId: string } }>(
    '/internal/tasks/safety-check',
    { schema: { body: bodySchema }, preHandler },
    async (req, reply) => {
      const alert = await deps.alerts.findById(req.body.alertId);

      // Gone, or already terminal. A redelivery after she resolved must not
      // drag her back into an escalated state.
      if (!alert || alert.status !== 'active') {
        deps.logger.info('safety check skipped', {
          alertId: req.body.alertId, status: alert?.status ?? 'missing',
        });
        return reply.send({ handled: false });
      }

      const now = new Date();
      await deps.alerts.updateStatus(alert.id, 'escalated', {
        escalatedAt: now,
        escalationReason: 'no_answer',
      });

      // Keyed on the alert, not the moment, so a redelivered task collapses
      // onto the same notification instead of telling her contacts twice.
      await deps.queue.schedule({
        key: taskKeys.notifyContacts(alert, alert.createdAt),
        runAt: now,
        payload: { kind: 'notify-contacts', alertId: alert.id, reason: 'no_answer' },
      });

      deps.logger.warn('alert escalated: no answer to the safety check', { alertId: alert.id });
      return reply.send({ handled: true });
    },
  );

  /**
   * The active window elapsed without resolution or escalation.
   *
   * alert-lifecycle.md §2: if escalation worked this is unreachable, so
   * reaching it means our own machinery failed. It is logged at error level on
   * purpose — this is the line that should page someone once P2-17 gives us
   * somewhere to page to.
   */
  app.post<{ Body: { alertId: string } }>(
    '/internal/tasks/expiry',
    { schema: { body: bodySchema }, preHandler },
    async (req, reply) => {
      const alert = await deps.alerts.findById(req.body.alertId);

      if (!alert || alert.status === 'resolved' || alert.status === 'expired') {
        return reply.send({ handled: false });
      }

      await deps.alerts.updateStatus(alert.id, 'expired', {});

      if (alert.status === 'active') {
        // Never escalated. The safety check did not run.
        deps.logger.error('alert expired while still active — escalation did not run', {
          alertId: alert.id, createdAt: alert.createdAt.toISOString(),
        });
      } else {
        // Escalated but never resolved. Expected, and still worth recording.
        deps.logger.warn('escalated alert expired unresolved', { alertId: alert.id });
      }

      // Deliberately no notification. The window has passed and a late message
      // saying she may be in danger is worse than none.
      return reply.send({ handled: true });
    },
  );
}
