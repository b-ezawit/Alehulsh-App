import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../errors.js';
import type { Subject, TokenVerifier } from './TokenVerifier.js';

declare module 'fastify' {
  interface FastifyRequest {
    subject?: Subject;
  }
}

/**
 * Resolves the caller once, at the edge.
 *
 * Registered as `onRequest`, not `preHandler`, so it runs before body parsing
 * and schema validation. An unauthenticated caller therefore never reaches the
 * validator — they get 401 rather than a 400 describing what was wrong with a
 * request we were never going to process. It only reads a header, so there is
 * nothing it needs from the parsed body.
 *
 * CLAUDE.md §9: authentication is not authorization. This establishes *who is
 * calling* and nothing more. Whether they may touch a given resource is decided
 * per-route against stored relationships — see docs/authorization-model.md §5.
 * No handler may read a role from the request body.
 */
export function requireSubject(verifier: TokenVerifier) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new AppError('unauthenticated', 'missing bearer token');
    }
    const token = header.slice('Bearer '.length).trim();
    if (!token) throw new AppError('unauthenticated', 'empty bearer token');

    req.subject = await verifier.verify(token);
  };
}

/** Narrowing helper so handlers never see an optional subject. */
export function subjectOf(req: FastifyRequest): Subject {
  if (!req.subject) throw new AppError('unauthenticated', 'subject missing after auth');
  return req.subject;
}
