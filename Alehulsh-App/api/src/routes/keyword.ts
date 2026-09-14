import type { FastifyInstance } from 'fastify';
import { requireSubject, subjectOf } from '../auth/middleware.js';
import { AppError } from '../errors.js';
import {
  hashKeyword, isShippedDefault, normalizeKeyword, verifyKeyword,
} from '../crypto/keyword.js';
import type { Deps } from '../server.js';

/**
 * PUT /v1/me/keyword — set or change the safety keyword.  (P1-11)
 *
 * This did not exist, and nothing else could substitute for it. P1-11 hashes
 * keywords server-side with a pepper held outside the database; a client
 * cannot produce that hash without shipping the pepper inside the APK, which
 * would defeat the entire point of peppering (CLAUDE.md §12). So without this
 * endpoint, a user forced onto `mustSetKeyword` by the migration had no way to
 * set one — and resolve.ts correctly refuses to resolve for a user with no
 * keyword, which would have left her permanently unable to cancel an alert.
 *
 * THE GOVERNING RULE (docs/coercion-and-escalation.md §6): there must be no
 * bypass for an active alert. If the keyword could be changed while an alert
 * is live, the change *is* the bypass — "set it to X, now cancel" takes thirty
 * seconds and voids the whole mechanism. So this is refused outright whenever
 * she has an active or escalated alert, and that refusal is the most important
 * line in the file.
 *
 * Changing an existing keyword requires the current one. An abuser holding her
 * unlocked phone but not knowing the keyword cannot quietly take control of
 * the mechanism; one who already knows it gains nothing by changing it.
 *
 * KNOWN GAP: a genuinely forgotten keyword cannot be reset. §6 accepts the
 * consequence for a live alert — it escalates, her contacts are told, and that
 * is correct — but it means she stays on a keyword she cannot remember. The
 * fix is account recovery, which does not exist and must not be built as
 * something usable under duress.
 */
const bodySchema = {
  type: 'object',
  required: ['keyword'],
  additionalProperties: false,
  properties: {
    keyword: { type: 'string', minLength: 1, maxLength: 256 },
    currentKeyword: { type: 'string', minLength: 1, maxLength: 256 },
  },
} as const;

interface Body { keyword: string; currentKeyword?: string }

/** Short enough to guess aloud is not a secret. */
const MIN_LENGTH = 3;
const CHANGE_CAP = 5;
const CHANGE_WINDOW_MS = 60 * 60 * 1000;

export function registerKeywordRoute(app: FastifyInstance, deps: Deps): void {
  app.put<{ Body: Body }>(
    '/v1/me/keyword',
    { schema: { body: bodySchema }, onRequest: requireSubject(deps.tokenVerifier) },
    async (req, reply) => {
      const { uid } = subjectOf(req);

      // THE RULE. Before anything else, including validation of the new value:
      // no keyword change while an alert is live.
      const live = await deps.alerts.findActiveByOwner(uid);
      if (live) {
        deps.logger.warn('keyword change refused — alert is live', {
          subject: uid, alertId: live.id, status: live.status,
        });
        throw new AppError(
          'conflict',
          `keyword change refused while alert ${live.id} is ${live.status}`,
        );
      }

      const { allowed, count } = await deps.limiter.hit(
        `keyword:set:${uid}`, CHANGE_CAP, CHANGE_WINDOW_MS,
      );
      if (!allowed) {
        throw new AppError('rate_limited', `${count} keyword changes for ${uid}`);
      }

      const next = normalizeKeyword(req.body.keyword);
      if (next.length < MIN_LENGTH) {
        throw new AppError('invalid_request', 'keyword too short after normalisation');
      }
      if (isShippedDefault(req.body.keyword)) {
        // 'Milo' shipped as the default for every user (CRIT-05). Accepting it
        // back would recreate a keyword an attacker can simply guess.
        throw new AppError('invalid_request', 'keyword is the shipped default');
      }

      const user = await deps.users.findByUid(uid);
      const hasExisting = Boolean(user?.safetyKeywordHash) && user?.mustSetKeyword !== true;

      if (hasExisting) {
        if (!req.body.currentKeyword) {
          throw new AppError('invalid_request', 'current keyword required to change it');
        }
        const ok = await verifyKeyword(
          req.body.currentKeyword, user!.safetyKeywordHash!, deps.config.keywordPepper,
        );
        if (!ok) {
          deps.logger.warn('keyword change refused — current keyword wrong', { subject: uid });
          // Deliberately NOT the identical-response treatment resolve.ts uses.
          // That exists because a coercer is watching her cancel an alert. Here
          // there is no alert, nothing escalates, and telling a legitimate user
          // her old keyword was wrong is simply correct.
          throw new AppError('forbidden', 'current keyword did not verify');
        }
        if (await verifyKeyword(req.body.keyword, user!.safetyKeywordHash!, deps.config.keywordPepper)) {
          throw new AppError('invalid_request', 'new keyword is the same as the current one');
        }
      }

      const hash = await hashKeyword(req.body.keyword, deps.config.keywordPepper);
      await deps.users.setSafetyKeywordHash(uid, hash);

      // Never the keyword, never the hash, never the length. The logger redacts
      // by key name, and this gives it nothing to redact.
      deps.logger.info(hasExisting ? 'safety keyword changed' : 'safety keyword set', {
        subject: uid,
      });

      return reply.send({ keywordSet: true });
    },
  );
}
