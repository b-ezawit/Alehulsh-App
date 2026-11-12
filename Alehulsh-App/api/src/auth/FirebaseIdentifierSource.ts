import { hashEmail, hashPhone, identifiersMatch } from '../crypto/identifier.js';
import type { VerifiedIdentifierSource } from './VerifiedIdentifierSource.js';
interface ProviderUser { disabled: boolean; email?: string; emailVerified: boolean; phoneNumber?: string; }
interface Provider { getUser(uid: string): Promise<ProviderUser>; }
/** Interim adapter; no messages or verification challenges are sent. */
export class FirebaseIdentifierSource implements VerifiedIdentifierSource {
  constructor(private readonly auth: Provider, private readonly pepper: string) {
    if (!pepper) throw Error('authoritative identifier pepper required');
  }
  async proves(uid: string, hash: string): Promise<boolean> {
    let user: ProviderUser;
    try { user = await this.auth.getUser(uid); }
    catch (error) {
      if ((error as { code?: string; }).code === 'auth/user-not-found') return false;
      throw Error('identifier ownership source unavailable');
    }
    if (user.disabled) return false;
    const candidates = [user.phoneNumber ? hashPhone(user.phoneNumber, this.pepper) : null,
    user.emailVerified && user.email ? hashEmail(user.email, this.pepper) : null];
    return candidates.some(candidate => candidate !== null && identifiersMatch(candidate, hash));
  }
}
