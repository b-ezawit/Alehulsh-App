import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { requireSubject, subjectOf } from '../auth/middleware.js';
import { verifyKeyword } from '../crypto/keyword.js';
import { AppError } from '../errors.js';
import type { Deps } from '../server.js';
import { taskKeys } from '../tasks.js';

/**
 * POST /v1/alerts/:id/resolve — the CRIT-05 fix.  (P1-09)
 *
 * Today this is alert_service.dart:287-325: the comparison runs in Dart, then
 * calls .delete(). It is advisory, it destroys all evidence, and if no keyword
 * was ever set then ANY non-empty string cancels the alert (line 301).
 *
 * THE GOVERNING CONSTRAINT (docs/coercion-and-escalation.md §5):
 * the response is identical whether the keyword was right or wrong. A person
 * is standing over her shoulder watching this screen. He must not be able to
 * tell whether her answer worked.
 *
 * Everything below follows from that — including the parts that look odd.
 */
const bodySchema = {
  type: 'object',
  required: ['keyword'],
  additionalProperties: false,
  properties: { keyword: { type: 'string', minLength: 1, maxLength: 256 } },
} as const;

/**
 * A well-formed hash of nothing, used when the user has no keyword configured.
 *
 * Without it, "no keyword set" would return in ~1ms while a real check costs
 * ~100ms of scrypt — a timing oracle that tells the coercer, reliably, that
 * there is no secret to guess. So we spend the same 100ms failing.
 */
const DUMMY_HASH = [
  'scrypt', 1 << 16, 8, 1,
  randomBytes(16).toString('base64url'),
  randomBytes(32).toString('base64url'),
].join('$');

/** Identical in every owner-facing outcome. Carries no state. */
const ACKNOWLEDGED = { acknowledged: true } as const;

export function registerResolveRoute(app: FastifyInstance, deps: Deps): void {
  app.post<{ Params: { id: string }; Body: { keyword: string } }>(
    '/v1/alerts/:id/resolve',
    { schema: { body: bodySchema }, preHandler: requireSubject(deps.tokenVerifier) },
    async (req, reply) => {
      const { uid } = subjectOf(req);
      const alert = await deps.alerts.findById(req.params.id);

      // Not the owner, or no such alert. These return byte-identical bodies
      // (errors.ts) so a caller cannot probe which alert ids exist. This is a
      // different threat from the coercion case below: here the attacker is
      // someone else's account, not someone at her shoulder.
      if (!alert || alert.ownerId !== uid) {
        throw new AppError('not_found', `alert ${req.params.id} not visible to ${uid}`);
      }

      // Already terminal. Idempotent, and indistinguishable from a fresh
      // attempt — replaying a resolve must not confirm that it worked.
      if (alert.status === 'resolved' || alert.status === 'expired') {
        return reply.send(ACKNOWLEDGED);
      }

      const now = new Date();

      // Throttle. Note what this does NOT do: it never returns 429 and never
      // locks her out. A 429 on the fourth attempt would tell him the first
      // three were wrong, and a lockout would hand him a way to disable her
      // resolution path permanently. Instead, attempts arriving too fast are
      // silently not processed — he is slowed down and learns nothing, while
      // she can still resolve the moment the interval passes.
      const throttled =
        alert.attemptCount >= deps.config.keywordAttemptCap &&
        alert.lastAttemptAt !== undefined &&
        now.getTime() - alert.lastAttemptAt.getTime() < deps.config.keywordAttemptCooldownMs;

      if (throttled) {
        deps.logger.warn('keyword attempt throttled', {
          alertId: alert.id, attemptCount: alert.attemptCount,
        });
        return reply.send(ACKNOWLEDGED);
      }

      const user = await deps.users.findByUid(uid);
      // A user with no keyword — migrated off the shipped default, or never
      // set one (P1-11). She cannot resolve, by design: the mechanism rests on
      // the keyword being unbypassable, so there is no bypass for her either.
      // Her alert escalates, her contacts are told, and she resolves late once
      // she is somewhere calm (alert-lifecycle.md transition 4).
      const stored = user?.safetyKeywordHash ?? DUMMY_HASH;

      const correct = await verifyKeyword(req.body.keyword, stored, deps.config.keywordPepper);

      if (correct) {
        await deps.alerts.updateStatus(alert.id, 'resolved', {
          resolvedAt: now,
          resolvedBy: alert.status === 'escalated' ? 'owner_late' : 'owner',
        });
        // Cancel before acknowledging, so a resolved alert cannot still fire a
        // safety check at someone who is already safe.
        await deps.queue.cancel(taskKeys.safetyCheck(alert));
        await deps.queue.cancel(taskKeys.expiry(alert));
        deps.logger.info('alert resolved', { alertId: alert.id });
      } else {
        await deps.alerts.recordFailedAttempt(alert.id, now);
        if (alert.status === 'active') {
          await deps.alerts.updateStatus(alert.id, 'escalated', {
            escalatedAt: now,
            escalationReason: 'wrong_keyword',
          });
          // Recording keeps running and responders stay engaged —
          // alert-lifecycle.md §5. The moments after a failed check are the
          // ones most worth capturing.
          await deps.queue.schedule({
            key: taskKeys.notifyContacts(alert, now),
            runAt: now,
            payload: { kind: 'notify-contacts', alertId: alert.id, reason: 'wrong_keyword' },
          });
        }
        deps.logger.warn('keyword attempt failed', {
          alertId: alert.id, attemptCount: alert.attemptCount + 1,
        });
      }

      // Same body, same status, both paths. Do not add a field here.
      return reply.send(ACKNOWLEDGED);
    },
  );
}
