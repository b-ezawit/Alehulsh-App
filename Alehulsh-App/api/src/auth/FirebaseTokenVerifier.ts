import type { Auth } from 'firebase-admin/auth';
import { AppError } from '../errors.js';
import type { Subject, TokenVerifier } from './TokenVerifier.js';

/** Interim implementation. Replaced at C-04 — see docs/api-layer.md. */
export class FirebaseTokenVerifier implements TokenVerifier {
  constructor(private readonly auth: Auth) {}

  async verify(token: string): Promise<Subject> {
    try {
      // checkRevoked: a signed-out or disabled account must stop working
      // immediately, not when the token happens to expire.
      const decoded = await this.auth.verifyIdToken(token, true);
      if (!decoded.uid) throw new AppError('unauthenticated', 'token carried no uid');
      return { uid: decoded.uid };
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw new AppError('unauthenticated', 'token verification failed', { cause });
    }
  }
}
