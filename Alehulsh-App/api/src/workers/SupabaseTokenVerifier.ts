import {
  createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey,
} from 'jose';
import { AppError } from '../errors.js';
import type { Subject, TokenVerifier } from '../auth/TokenVerifier.js';

export interface SupabaseSubject extends Subject {
  /** Signed Supabase Auth session identifier; not a caller-selected user ID. */
  sessionId: string;
}

export interface SupabaseAuthConfig {
  issuer: string;
  audience: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Signature verification only; a live-session check is also mandatory. */
export class SupabaseTokenVerifier implements TokenVerifier {
  private readonly keys: JWTVerifyGetKey;

  constructor(private readonly config: SupabaseAuthConfig, keys?: JWTVerifyGetKey) {
    const issuer = new URL(config.issuer);
    if (issuer.protocol !== 'https:' || issuer.username || issuer.password
      || issuer.search || issuer.hash || issuer.pathname !== '/auth/v1'
      || !config.audience.trim()) {
      throw new Error('Supabase Auth requires an HTTPS auth/v1 issuer and audience');
    }
    this.keys = keys ?? createRemoteJWKSet(new URL(`${config.issuer}/.well-known/jwks.json`), {
      timeoutDuration: 3000, cooldownDuration: 30_000, cacheMaxAge: 5 * 60_000,
    });
  }

  async verify(token: string): Promise<SupabaseSubject> {
    try {
      if (token.length > 8192) throw new Error('token too large');
      const { payload } = await jwtVerify(token, this.keys, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        algorithms: ['ES256', 'RS256'],
        requiredClaims: ['iss', 'aud', 'exp', 'iat', 'sub', 'session_id', 'role'],
      });
      if (typeof payload.sub !== 'string' || !UUID.test(payload.sub)
        || typeof payload['session_id'] !== 'string' || !UUID.test(payload['session_id'])
        || payload['role'] !== 'authenticated' || payload['is_anonymous'] === true
        || typeof payload.iat !== 'number' || payload.iat > Date.now() / 1000 + 5) {
        throw new Error('not an authenticated Supabase user session');
      }
      return { uid: payload.sub, sessionId: payload['session_id'] };
    } catch {
      // Never propagate token contents, provider response or JOSE diagnostics.
      throw new AppError('unauthenticated', 'Supabase access token refused');
    }
  }
}
