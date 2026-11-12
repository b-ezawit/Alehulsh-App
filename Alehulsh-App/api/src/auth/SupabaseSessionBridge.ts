import type { Queryable } from '../db/pool.js';
import type { SupabaseSubject } from '../workers/SupabaseTokenVerifier.js';
import { AppError } from '../errors.js';
import {hashPhone,hashEmail,normalizePhone} from '../crypto/identifier.js';
export interface SessionPolicy { maxAgeSeconds: number; inactivitySeconds: number; }
export interface SessionIdentity {
  applicationSubject: string | null;
  verifiedPhone: string | null;
  verifiedEmail: string | null;
}
export function readSessionPolicy(env: { SUPABASE_SESSION_MAX_AGE_SECONDS?: string; SUPABASE_SESSION_INACTIVITY_SECONDS?: string; }): SessionPolicy {
  const read = (name: 'SUPABASE_SESSION_MAX_AGE_SECONDS' | 'SUPABASE_SESSION_INACTIVITY_SECONDS') => {
    const value = env[name];
    if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 2147483647) throw Error(`missing or invalid ${name}`);
    return Number(value);
  };
  return { maxAgeSeconds: read('SUPABASE_SESSION_MAX_AGE_SECONDS'), inactivitySeconds: read('SUPABASE_SESSION_INACTIVITY_SECONDS') };
}
/** Uses the restricted API connection and a narrowly privileged read function.
 * Provider identities never come from client-editable metadata or profile flags. */
export class SupabaseSessionBridge {
  constructor(private readonly db: Queryable, private readonly policy: SessionPolicy) { }
  async revoke(subject: SupabaseSubject): Promise<void> {
    try {
      await this.db.query('SELECT public.revoke_supabase_session($1::uuid,$2::uuid,$3::integer,$4::integer)',
        [subject.uid,subject.sessionId,this.policy.maxAgeSeconds,this.policy.inactivitySeconds]);
    } catch (e) { if ((e as {code?:string}).code==='28000') throw new AppError('unauthenticated'); throw e; }
  }
  async synchronizeIdentifiers(subject:SupabaseSubject,identity:SessionIdentity,pepper:string):Promise<void> {
    if(!pepper.trim())throw Error('authoritative identifier pepper required');
    await this.db.query('SELECT public.sync_supabase_identifiers($1::uuid,$2::uuid,$3::integer,$4::integer,$5,$6,$7,$8,$9)',
      [subject.uid,subject.sessionId,this.policy.maxAgeSeconds,this.policy.inactivitySeconds,
        identity.verifiedPhone,identity.verifiedEmail,identity.verifiedPhone?normalizePhone(identity.verifiedPhone):null,
        identity.verifiedPhone?hashPhone(identity.verifiedPhone,pepper):null,
        identity.verifiedEmail?hashEmail(identity.verifiedEmail,pepper):null]);
  }
  async inspect(subject: SupabaseSubject): Promise<SessionIdentity | null> {
    const { rows } = await this.db.query<{ application_subject: string | null; verified_phone: string | null; verified_email: string | null; }>(
      'SELECT * FROM public.inspect_supabase_session($1::uuid,$2::uuid,$3::integer,$4::integer)',
      [subject.uid, subject.sessionId, this.policy.maxAgeSeconds, this.policy.inactivitySeconds]);
    const row = rows[0];
    return row ? { applicationSubject: row.application_subject, verifiedPhone: row.verified_phone, verifiedEmail: row.verified_email } : null;
  }
  async provision(subject: SupabaseSubject, profile: { name: string; homeAddress: string; keywordHash: string; }): Promise<string> {
    try {
      const { rows } = await this.db.query<{ subject: string; }>(
        'SELECT public.provision_supabase_account($1::uuid,$2::uuid,$3::integer,$4::integer,$5,$6,$7) AS subject',
        [subject.uid, subject.sessionId, this.policy.maxAgeSeconds, this.policy.inactivitySeconds, profile.name, profile.homeAddress, profile.keywordHash]);
      if (!rows[0]?.subject) throw Error('provisioning did not return a binding');
      return rows[0].subject;
    } catch (error) {
      const code = (error as { code?: string; }).code;
      if (code === '28000') throw new AppError('unauthenticated');
      if (code === '23505') throw new AppError('conflict');
      throw error;
    }
  }
}
