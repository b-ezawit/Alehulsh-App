import { KeywordCapacityError } from '../crypto/KeywordAdmission.js';
import { randomBytes } from 'node:crypto';
import { AppError } from '../errors.js';
import { verifyKeyword } from '../crypto/keyword.js';
import { isTerminalStatus } from '../repositories/types.js';
import type { Deps } from '../server.js';
import { taskKeys } from '../tasks.js';
import { expediteAlertWork } from './alertWork.js';
let dummyHash: string | undefined;
// Workers permits randomness only during a request, not module evaluation.
function missingKeywordHash(): string {
  return dummyHash ??= ['scrypt', 1 << 16, 8, 1, randomBytes(16).toString('base64url'), randomBytes(32).toString('base64url')].join('$');
}
/** Shared by the Firebase HTTP adapter and the PostgreSQL Workers adapter. */
export async function resolveOwnedAlert(deps: Pick<Deps, 'alerts' | 'users' | 'queue' | 'fanout' | 'logger'> & { config: Pick<Deps['config'], 'keywordPepper' | 'keywordAttemptCap' | 'keywordAttemptCooldownMs' | 'safetyCheckDelayMs'>; }, uid: string, id: string, keyword: string, incidentKey?: string): Promise<void> {
  const alert = await deps.alerts.findById(id);

  // Not the owner, or no such alert. These return byte-identical bodies
  // (errors.ts) so a caller cannot probe which alert ids exist. This is a
  // different threat from the coercion case below: here the attacker is
  // someone else's account, not someone at her shoulder.
  if (!alert || alert.ownerId !== uid) {
    throw new AppError('not_found', `alert ${id} not visible to ${uid}`);
  }
  // A delayed request for a reused Firestore slot cannot affect its successor.
  // Keep the uniform acknowledgment used for all keyword outcomes.
  if (incidentKey !== undefined && incidentKey !== alert.key) return;

  // Already terminal. Idempotent, and indistinguishable from a fresh
  // attempt — replaying a resolve must not confirm that it worked.
  if (isTerminalStatus(alert.status)) {
    await expediteAlertWork(alert, deps.config.safetyCheckDelayMs, deps.queue, deps.logger);
    try { await deps.fanout.retract(alert.id, alert.key); }
    catch { deps.logger.error('inbox retraction deferred to durable recovery', { alertId: alert.id }); }
    return;
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
    return;
  }

  if (!await deps.alerts.admitKeywordVerification(alert.id, alert.key,
      deps.config.keywordAttemptCap, deps.config.keywordAttemptCooldownMs)) return;

  const user = await deps.users.findByUid(uid);
  // A user with no keyword — migrated off the shipped default, or never
  // set one (P1-11). She cannot resolve, by design: the mechanism rests on
  // the keyword being unbypassable, so there is no bypass for her either.
  // Her alert escalates, her contacts are told, and she resolves late once
  // she is somewhere calm (alert-lifecycle.md transition 4).
  const stored = user?.safetyKeywordHash ?? missingKeywordHash();

  let correct: boolean;
  try { correct = await verifyKeyword(keyword, stored, deps.config.keywordPepper); }
  catch (error) {
    // Capacity is an unprocessed request, never a wrong keyword or an oracle.
    if (error instanceof KeywordCapacityError) return;
    throw error;
  }

  if (correct) {
    const updated = await deps.alerts.updateStatus(alert.id, 'resolved', {
      resolvedAt: now,
      resolvedBy: alert.status === 'escalated' ? 'owner_late' : 'owner',
    }, alert.key);
    await expediteAlertWork(updated, deps.config.safetyCheckDelayMs, deps.queue, deps.logger);
    try { await deps.fanout.retract(alert.id, alert.key); }
    catch { deps.logger.error('inbox retraction deferred to durable recovery', { alertId: alert.id }); }
    // Cancel before acknowledging, so a resolved alert cannot still fire a
    // safety check at someone who is already safe.
    for (const key of [taskKeys.safetyCheck(alert), taskKeys.expiry(alert)]) {
      try { await deps.queue.cancel(key); }
      catch { deps.logger.error('task cancellation deferred; handler state guard remains active'); }
    }
    deps.logger.info('alert resolved', { alertId: alert.id });
  } else {
    const updated = await deps.alerts.failKeywordAttempt(alert.id, now, alert.key);
    await expediteAlertWork(updated, deps.config.safetyCheckDelayMs, deps.queue, deps.logger);
    deps.logger.warn('keyword attempt failed', {
      alertId: alert.id, attemptCount: alert.attemptCount + 1,
    });
  }

  // Same body, same status, both paths. Do not add a field here.
  return;
}
