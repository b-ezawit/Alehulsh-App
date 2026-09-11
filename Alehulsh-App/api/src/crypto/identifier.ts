/**
 * Keyed hashing for contact identifiers.  (P2-09)
 *
 * Today every alert document carries emergencyContactPhones, ...Emails,
 * ...Names and ...Uids in the clear, and the client compares strings locally
 * (emergency_ping_service.dart:160-179). Combined with the open read rule that
 * published every user's whole support network (CRIT-02).
 *
 * Matching moves server-side on hashes so raw contact details stop travelling
 * at all.
 *
 * HMAC, not a bare digest. There are on the order of 10^8 Ethiopian mobile
 * numbers — a plain SHA-256 of one is reversible by enumeration in seconds, so
 * "we hashed it" would be a false assurance. The key makes the space
 * unsearchable without it.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Ethiopian mobile numbers arrive in at least four shapes:
 *   +251 91 123 4567 · 251911234567 · 0911234567 · 911234567
 * All four are the same person, so all four must hash identically or matching
 * silently fails and her contact is never told.
 */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d]/g, '');
  if (!digits) return null;

  let national: string;
  if (digits.startsWith('251')) national = digits.slice(3);
  else if (digits.startsWith('0')) national = digits.slice(1);
  else national = digits;

  // Ethiopian mobile: 9 digits, leading 9 (Ethio Telecom) or 7 (Safaricom ET).
  if (national.length !== 9 || !/^[79]/.test(national)) return null;
  return `+251${national}`;
}

export function normalizeEmail(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  // Deliberately shallow. This is a normaliser, not a validator — rejecting an
  // unusual but real address would silently drop a contact.
  if (!trimmed || !trimmed.includes('@') || trimmed.length > 320) return null;
  return trimmed;
}

/** Domain-separated so a phone and an email can never collide. */
export function hashIdentifier(kind: 'phone' | 'email', normalized: string, pepper: string): string {
  return createHmac('sha256', pepper).update(`${kind}:${normalized}`, 'utf8').digest('base64url');
}

export function hashPhone(raw: string, pepper: string): string | null {
  const n = normalizePhone(raw);
  return n ? hashIdentifier('phone', n, pepper) : null;
}

export function hashEmail(raw: string, pepper: string): string | null {
  const n = normalizeEmail(raw);
  return n ? hashIdentifier('email', n, pepper) : null;
}

/** Constant-time, so matching cannot be probed by timing. */
export function identifiersMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
