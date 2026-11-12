import { keywordAdmission } from './KeywordAdmission.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import {
  isShippedDefault, normalizeKeyword, SHIPPED_DEFAULT_KEYWORD,
} from './keywordNormalization.js';

/**
 * The safety-keyword KDF, for runtimes without `node:crypto`.  (M-06)
 *
 * THE ALGORITHM DOES NOT CHANGE. This is scrypt at the same parameters
 * (N=65536, r=8, p=1, 32-byte key), peppered with the same HMAC-SHA256, in the
 * same `scrypt$N$r$p$salt$hash` encoding. A hash written by `keyword.ts`
 * verifies here and vice versa, proven in both directions by
 * test/keywordPortable.test.ts.
 *
 * The current Workers composition uses native node:crypto scrypt with its
 * pinned nodejs_compat runtime. Earlier documentation saying Workers lacked
 * scrypt was outdated. The real workerd regression verifies both directions;
 * this portable implementation remains an interoperability check, not an
 * automatic fallback or a reason to change the established KDF parameters.
 *
 * Every primitive here is a maintained implementation, not a hand-rolled one
 * (CLAUDE.md §12 and MIGRATION-COMPAT.md §1):
 *
 *   scrypt           @noble/hashes      pure TS, zero dependencies
 *   HMAC-SHA256      WebCrypto          crypto.subtle.sign, verified
 *                                       byte-identical to createHmac
 *   random salt      crypto.getRandomValues
 *   compare          the runtime's own constant-time primitive - Workers
 *                    exposes crypto.subtle.timingSafeEqual, Node exposes
 *                    node:crypto timingSafeEqual
 *
 * Runtime CPU, memory and concurrent-load behavior still require a measured
 * deployment budget. Local workerd success does not establish a production
 * plan limit or guarantee that keyword operations fit the emergency latency
 * requirement under load.
 */

/** Must stay identical to keyword.ts, or hashes stop being interchangeable. */
const PARAMS = { N: 1 << 16, r: 8, p: 1 } as const;
const KEY_LEN = 32;
const SALT_LEN = 16;

/** Re-exported so a Workers build needs only this module. */
export { normalizeKeyword, isShippedDefault, SHIPPED_DEFAULT_KEYWORD };

/**
 * A constant-time comparison from the runtime, never written here.
 *
 * Workers ships `crypto.subtle.timingSafeEqual` as a documented non-standard
 * extension; Node has the one in `node:crypto`. If a runtime offers neither
 * this THROWS rather than falling back to `===`: a timing-leaky comparison of
 * a password digest is exactly the kind of quiet downgrade that is worse than
 * a failure, because nothing would look broken.
 */
async function constantTimeEqual(a: Uint8Array, b: Uint8Array): Promise<boolean> {
  if (a.length !== b.length) return false;

  const subtle = globalThis.crypto?.subtle as
    (SubtleCrypto & { timingSafeEqual?: (x: ArrayBufferView, y: ArrayBufferView) => boolean })
    | undefined;

  if (typeof subtle?.timingSafeEqual === 'function') {
    return subtle.timingSafeEqual(a, b);
  }

  // Node. Imported dynamically so a Workers bundle never reaches for
  // node:crypto at module load.
  try {
    const { timingSafeEqual } = await import('node:crypto');
    return timingSafeEqual(a, b);
  } catch {
    throw new Error(
      'no constant-time comparison available in this runtime; refusing to '
      + 'compare keyword digests with a timing-leaky equality',
    );
  }
}

/** HMAC-SHA256 via WebCrypto. Byte-identical to node:crypto createHmac. */
async function peppered(normalized: string, pepper: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(normalized));
  return new Uint8Array(sig);
}

/** base64url without padding — the same encoding Buffer's base64url produces. */
function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (s.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** Self-describing, byte-for-byte the format keyword.ts writes. */
async function hashKeywordPortableUnbounded(raw: string, pepper: string): Promise<string> {
  const normalized = normalizeKeyword(raw);
  if (!normalized) throw new Error('keyword is empty after normalisation');

  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const derived = await scryptAsync(
    await peppered(normalized, pepper), salt,
    { N: PARAMS.N, r: PARAMS.r, p: PARAMS.p, dkLen: KEY_LEN },
  );

  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p,
    toBase64Url(salt), toBase64Url(derived)].join('$');
}

/**
 * Constant-time. Returns false rather than throwing on a malformed stored
 * value — a corrupt record must never become an authentication bypass.
 *
 * The parameter bounds are the same as keyword.ts: a tampered record must not
 * be able to request an absurd N and exhaust the isolate's memory, which on
 * Workers is a harder limit (128 MiB) than on Node.
 */
async function verifyKeywordPortableUnbounded(
  raw: string, stored: string, pepper: string,
): Promise<boolean> {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
    if (N < 1024 || N > (1 << 20) || r < 1 || r > 32 || p < 1 || p > 16) return false;

    const salt = fromBase64Url(parts[4] ?? '');
    const expected = fromBase64Url(parts[5] ?? '');
    if (salt.length === 0 || expected.length === 0) return false;

    const normalized = normalizeKeyword(raw);
    if (!normalized) return false;

    const derived = await scryptAsync(
      await peppered(normalized, pepper), salt,
      { N, r, p, dkLen: expected.length },
    );
    return constantTimeEqual(derived, expected);
  } catch {
    return false;
  }
}

export function hashKeywordPortable(raw: string, pepper: string): Promise<string> {
  return keywordAdmission.run(() => hashKeywordPortableUnbounded(raw, pepper));
}

export function verifyKeywordPortable(raw: string, stored: string, pepper: string): Promise<boolean> {
  return keywordAdmission.run(() => verifyKeywordPortableUnbounded(raw, stored, pepper));
}
