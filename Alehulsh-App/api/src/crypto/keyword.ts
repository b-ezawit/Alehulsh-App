/**
 * Safety-keyword hashing.  (P1-11 — the prerequisite for the CRIT-05 fix.)
 *
 * Today the keyword is stored as plaintext in a world-readable field, defaults
 * to 'Milo' for every user, and is compared in Dart on the device
 * (alert_service.dart:287-325). This module replaces all of that.
 *
 * The keyword is a password in every respect that matters — a single
 * low-entropy word, chosen by a person, recalled under stress. It is treated
 * as one.
 *
 * scrypt rather than the bcrypt the SRD names: it is in node:crypto, so there
 * is no native module to compile. That matters for an Alpine container and for
 * moving hosts at C-04. OWASP lists scrypt as acceptable at these parameters.
 */
import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: Buffer, salt: Buffer, keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** OWASP minimum for scrypt. Roughly 100ms per verify on modest hardware. */
const PARAMS = { N: 1 << 16, r: 8, p: 1 } as const;
const KEY_LEN = 32;
const SALT_LEN = 16;
const MAXMEM = 256 * 1024 * 1024;

/**
 * Must match what the Dart client did, or every existing keyword breaks at
 * migration: alert_service.dart trimmed and lowercased before comparing.
 *
 * NFKC is added because Ethiopic input methods can produce different byte
 * sequences for the same visible word, and a woman retyping her keyword under
 * duress must not fail on an invisible encoding difference.
 */
export function normalizeKeyword(raw: string): string {
  return raw.normalize('NFKC').trim().toLowerCase();
}

/**
 * Peppering. A pepper is a server-side secret that is not in the database.
 * With a one-word secret, salting alone does not stop an attacker who steals
 * the database from brute-forcing it offline — the search space is a
 * dictionary. HMAC with the pepper first, then scrypt, so a dump without the
 * application secret is not enough.
 */
function peppered(normalized: string, pepper: string): Buffer {
  return createHmac('sha256', pepper).update(normalized, 'utf8').digest();
}

/** Self-describing, so parameters can be raised later without a migration. */
export async function hashKeyword(raw: string, pepper: string): Promise<string> {
  const normalized = normalizeKeyword(raw);
  if (!normalized) throw new Error('keyword is empty after normalisation');
  const salt = randomBytes(SALT_LEN);
  const derived = await scryptAsync(peppered(normalized, pepper), salt, KEY_LEN, { ...PARAMS, maxmem: MAXMEM });
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p,
    salt.toString('base64url'), derived.toString('base64url')].join('$');
}

/**
 * Constant-time. Returns false rather than throwing on a malformed stored
 * value — a corrupt record must never become an authentication bypass.
 */
export async function verifyKeyword(raw: string, stored: string, pepper: string): Promise<boolean> {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
    // Refuse absurd parameters from a tampered record — memory exhaustion vector.
    if (N < 1024 || N > (1 << 20) || r < 1 || r > 32 || p < 1 || p > 16) return false;

    const salt = Buffer.from(parts[4]!, 'base64url');
    const expected = Buffer.from(parts[5]!, 'base64url');
    if (salt.length === 0 || expected.length === 0) return false;

    const normalized = normalizeKeyword(raw);
    if (!normalized) return false;

    const derived = await scryptAsync(peppered(normalized, pepper), salt, expected.length,
      { N, r, p, maxmem: MAXMEM });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/**
 * The shipped default (user_profile_model.dart:131,226). Anyone still carrying
 * it has no secret at all, because every other user's keyword is the same word.
 * They must be forced to choose a real one (P1-12/P1-13) rather than migrated
 * into a false sense of protection.
 */
export const SHIPPED_DEFAULT_KEYWORD = 'milo';

export function isShippedDefault(raw: string): boolean {
  return normalizeKeyword(raw) === SHIPPED_DEFAULT_KEYWORD;
}
