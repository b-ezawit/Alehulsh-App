import type { FastifyInstance } from 'fastify';
import { requireSubject, subjectOf } from '../auth/middleware.js';
import { AppError } from '../errors.js';
import { hashKeyword, isShippedDefault, normalizeKeyword } from '../crypto/keyword.js';
import type { Deps } from '../server.js';

/**
 * Time-locked recovery for a forgotten safety keyword.  (P1-11.1)
 *
 * Full reasoning in docs/keyword-recovery.md. The short version:
 *
 * The keyword works because it cannot be bypassed, so anything she can use to
 * get past it is something she can be FORCED to use. That is why
 * coercion-and-escalation.md §6 said "no recovery" — right for a live alert,
 * but it left a woman who simply forgot permanently unable to stop her own
 * escalations, which teaches her the app punishes her. A safety tool nobody
 * uses protects nobody.
 *
 * Every mature system facing this reaches for TIME rather than identity —
 * Signal's 7-day registration lock, Apple and Google's multi-day account
 * recovery. The reason is that coercion is short. A man standing over her has
 * an evening; he does not have three days of standing there, and if he does,
 * the system has had three days to notice.
 *
 * Identity checks have no such property. Anything she can prove under duress,
 * she can be forced to prove — which is why security questions and SMS resets
 * are rejected outright.
 *
 * The mechanism:
 *   request  — nothing changes; the OLD keyword still works
 *   72 hours — pending and visible in the app, so a secret reset is impossible
 *   confirm  — only now does the new keyword take effect
 *
 * And two rules that do not move:
 *   nothing can be requested or confirmed while an alert is live;
 *   ANY alert raised during the window voids the reset — if she is in danger
 *   while one is pending, completing it is exactly wrong.
 */
export const RESET_DELAY_MS = 72 * 60 * 60 * 1000;

const confirmSchema = {
  type: 'object',
  required: ['keyword'],
  additionalProperties: false,
  properties: { keyword: { type: 'string', minLength: 1, maxLength: 256 } },
} as const;

const MIN_LENGTH = 3;

export function registerKeywordResetRoutes(app: FastifyInstance, deps: Deps): void {
  /** Start the clock. Changes nothing yet. */
  app.post(
    '/v1/me/keyword/reset',
    {
      schema: { body: { type: 'object', additionalProperties: false, properties: {} } },
      onRequest: requireSubject(deps.tokenVerifier),
    },
    async (req, reply) => {
      const { uid } = subjectOf(req);
      await refuseIfAlertLive(deps, uid, 'request');

      const existing = await deps.keywordResets.findPending(uid);
      if (existing) {
        // Idempotent, and it does NOT restart the clock. Otherwise repeatedly
        // asking would be a way to keep the window open indefinitely.
        return reply.send(pendingBody(existing.eligibleAt));
      }

      const now = new Date();
      const reset = await deps.keywordResets.create({
        uid,
        requestedAt: now,
        eligibleAt: new Date(now.getTime() + RESET_DELAY_MS),
        status: 'pending',
      });

      // Deliberately loud. A reset she did not start is something she must be
      // able to find out about, and this is the record of it.
      deps.logger.warn('keyword reset requested', {
        subject: uid, eligibleAt: reset.eligibleAt.toISOString(),
      });

      return reply.status(202).send(pendingBody(reset.eligibleAt));
    },
  );

  /** So the app can show a pending reset. Visibility is half the defence. */
  app.get(
    '/v1/me/keyword/reset',
    { onRequest: requireSubject(deps.tokenVerifier) },
    async (req, reply) => {
      const { uid } = subjectOf(req);
      const pending = await deps.keywordResets.findPending(uid);
      if (!pending) return reply.send({ pending: false });
      return reply.send({ pending: true, ...pendingBody(pending.eligibleAt) });
    },
  );

  /**
   * Cancel. Requires nothing but her session — she has forgotten the keyword,
   * so demanding it here would make the escape hatch as locked as the door.
   */
  app.delete(
    '/v1/me/keyword/reset',
    { onRequest: requireSubject(deps.tokenVerifier) },
    async (req, reply) => {
      const { uid } = subjectOf(req);
      const pending = await deps.keywordResets.findPending(uid);
      if (pending) {
        await deps.keywordResets.update(uid, {
          status: 'cancelled', cancelledAt: new Date(), cancelledReason: 'user',
        });
        deps.logger.info('keyword reset cancelled by user', { subject: uid });
      }
      return reply.send({ pending: false });
    },
  );

  /** After the window. Only here does the keyword actually change. */
  app.post<{ Body: { keyword: string } }>(
    '/v1/me/keyword/reset/confirm',
    { schema: { body: confirmSchema }, onRequest: requireSubject(deps.tokenVerifier) },
    async (req, reply) => {
      const { uid } = subjectOf(req);
      await refuseIfAlertLive(deps, uid, 'confirm');

      const pending = await deps.keywordResets.findPending(uid);
      if (!pending) {
        throw new AppError('not_found', `no pending keyword reset for ${uid}`);
      }

      const now = new Date();
      if (now < pending.eligibleAt) {
        // The remaining time is returned, and that is safe to reveal: it is
        // already shown in the app, and knowing it helps her far more than it
        // helps him — he cannot shorten it.
        throw new AppError(
          'conflict',
          `reset not eligible until ${pending.eligibleAt.toISOString()}`,
        );
      }

      const next = normalizeKeyword(req.body.keyword);
      if (next.length < MIN_LENGTH) {
        throw new AppError('invalid_request', 'keyword too short after normalisation');
      }
      if (isShippedDefault(req.body.keyword)) {
        throw new AppError('invalid_request', 'keyword is the shipped default');
      }

      const hash = await hashKeyword(req.body.keyword, deps.config.keywordPepper);
      await deps.users.setSafetyKeywordHash(uid, hash);
      await deps.keywordResets.update(uid, { status: 'confirmed' });

      deps.logger.warn('safety keyword reset completed', { subject: uid });
      return reply.send({ keywordSet: true });
    },
  );
}

/**
 * The rule that does not move. During an alert, a reset is the bypass — and a
 * coercer who can trigger this flow mid-emergency has defeated the mechanism
 * entirely.
 */
async function refuseIfAlertLive(deps: Deps, uid: string, stage: string): Promise<void> {
  const live = await deps.alerts.findActiveByOwner(uid);
  if (live) {
    deps.logger.warn(`keyword reset ${stage} refused — alert is live`, {
      subject: uid, alertId: live.id, status: live.status,
    });
    throw new AppError('conflict', `alert ${live.id} is ${live.status}`);
  }
}

function pendingBody(eligibleAt: Date) {
  return {
    eligibleAt: eligibleAt.toISOString(),
    // The old keyword keeps working throughout. Nothing is weakened while she
    // waits; the reset is additive until the moment it is confirmed.
    currentKeywordStillWorks: true,
  };
}

/**
 * Called when an alert is raised. ANY alert during the window voids a pending
 * reset.
 *
 * This closes the obvious attack: start a reset, wait out the window, then
 * coerce her. If anything happens to her in between, the reset dies — and the
 * mechanism she needs most is never weakened at the moment she needs it.
 */
export async function voidResetOnAlert(deps: Deps, uid: string): Promise<void> {
  const pending = await deps.keywordResets.findPending(uid);
  if (!pending) return;
  await deps.keywordResets.update(uid, {
    status: 'voided_by_alert', cancelledAt: new Date(), cancelledReason: 'alert_raised',
  });
  deps.logger.warn('keyword reset voided — an alert was raised during the window', {
    subject: uid,
  });
}

/** C-16. */
export function keywordResetDeletableStore(repo: {
  deleteForUid(uid: string): Promise<number>;
}): { readonly name: string; purge(uid: string): Promise<number> } {
  return { name: 'keyword_resets', purge: (uid) => repo.deleteForUid(uid) };
}
