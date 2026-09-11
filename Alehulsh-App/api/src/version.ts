/**
 * Version comparison for the force-upgrade gate.  (P1-26)
 *
 * THE SAFETY RULE THIS FILE EXISTS TO ENFORCE: when we cannot tell, we do not
 * block. Every ambiguous input — missing, malformed, unexpected shape —
 * resolves to "allowed". A woman opening this app during an emergency must
 * never be stopped by a version string we failed to parse.
 */
export interface Version { major: number; minor: number; patch: number }

/** Null for anything we cannot read with certainty. Callers must treat null as allowed. */
export function parseVersion(raw: string | undefined | null): Version | null {
  if (typeof raw !== 'string') return null;
  // Tolerates a build suffix (1.2.3+45) and a leading v, which are both things
  // a client will plausibly send.
  const m = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[+-].*)?$/.exec(raw.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** Negative if a < b, 0 if equal, positive if a > b. */
export function compareVersions(a: Version, b: Version): number {
  return (a.major - b.major) || (a.minor - b.minor) || (a.patch - b.patch);
}

/**
 * Whether this client must be blocked from continuing.
 *
 * Note every path that returns false. Unknown client version, unknown or
 * unparseable minimum, no policy for the platform — all allowed. The only way
 * to get a block is two versions we parsed successfully where the client is
 * genuinely behind.
 */
export function mustUpgrade(clientRaw: string | undefined | null, minimumRaw: string | undefined | null): boolean {
  const client = parseVersion(clientRaw);
  const minimum = parseVersion(minimumRaw);
  if (!client || !minimum) return false;
  return compareVersions(client, minimum) < 0;
}
