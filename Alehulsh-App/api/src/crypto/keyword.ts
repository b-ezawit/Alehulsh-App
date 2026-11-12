import { keywordAdmission } from './KeywordAdmission.js';
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
import { normalizeKeyword } from './keywordNormalization.js';
export { normalizeKeyword, isShippedDefault, SHIPPED_DEFAULT_KEYWORD } from './keywordNormalization.js';

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
async function hashKeywordUnbounded(raw: string, pepper: string): Promise<string> {
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
async function verifyKeywordUnbounded(raw: string, stored: string, pepper: string): Promise<boolean> {
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

export function hashKeyword(raw: string, pepper: string): Promise<string> {
  return keywordAdmission.run(() => hashKeywordUnbounded(raw, pepper));
}

export function verifyKeyword(raw: string, stored: string, pepper: string): Promise<boolean> {
  return keywordAdmission.run(() => verifyKeywordUnbounded(raw, stored, pepper));
}
