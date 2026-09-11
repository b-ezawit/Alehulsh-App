import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../errors.js';

/**
 * Authenticates the task runner, not a person.
 *
 * These endpoints escalate alerts and notify contacts. If a user could call
 * them she could escalate her own alert without a failed check — and, worse, a
 * coercer who noticed the endpoint could drive it.
 *
 * A shared secret rather than Cloud Tasks OIDC: the same check works when the
 * queue becomes a Postgres worker at C-04 (M-07). See docs/api-layer.md.
 */
export function requireTaskRunner(secret: string) {
  const expected = Buffer.from(secret, 'utf8');

  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const header = req.headers['x-task-secret'];
    const provided = typeof header === 'string' ? header : '';
    const given = Buffer.from(provided, 'utf8');

    // Compare lengths separately; timingSafeEqual throws on a mismatch.
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new AppError('unauthenticated', 'task runner secret mismatch');
    }
  };
}
