/**
 * Redacting logger.
 *
 * CLAUDE.md §7: sensitive data must not appear in logs. The audit found 68
 * debugPrint and 28 Kotlin Log calls, one of which printed the safety keyword
 * in cleartext (alert_service.dart:305). Nothing reaches a log line from here
 * without passing through redact().
 *
 * Redaction is by key name and recursive, because the thing that defeats a
 * naive redactor is nesting.
 */

/** Keys whose VALUES are never logged. Matched case-insensitively on substring. */
export const SENSITIVE_KEYS = [
  // identity
  'phone', 'email', 'fullname', 'username', 'nickname', 'displayname',
  // location
  'latitude', 'longitude', 'lat', 'lng', 'location', 'geohash', 'geopoint', 'geo',
  'address', 'coords', 'coordinate',
  // the safety secret
  'catname', 'keyword', 'secret', 'answer',
  // health
  'medical', 'bloodtype',
  // relationships
  'contact', 'responder',
  // credentials
  'token', 'authorization', 'password', 'apikey', 'credential', 'cookie',
  // evidence
  'audiourl', 'voicenote', 'recording',
] as const;

const MAX_DEPTH = 6;
const REDACTED = '[redacted]';

function isSensitive(key: string): boolean {
  const k = key.toLowerCase();
  return SENSITIVE_KEYS.some((s) => k.includes(s));
}

/**
 * Returns a copy safe to log. Keys are preserved so the shape stays useful;
 * only values are removed.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[max-depth]';
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  if (value instanceof Error) {
    // Never log a stack to a client-facing sink; keep the type for triage.
    return { error: value.name, message: value.message };
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitive(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }

  return value;
}

type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

export function createLogger(minLevel: Level = 'info'): Logger {
  const threshold = ORDER[minLevel];

  const emit = (level: Level, msg: string, ctx?: Record<string, unknown>) => {
    if (ORDER[level] < threshold) return;
    const line = {
      level,
      msg,
      time: new Date().toISOString(),
      ...(ctx ? { ctx: redact(ctx) as Record<string, unknown> } : {}),
    };
    // One JSON object per line — greppable, and parseable by any log backend
    // we end up with in-country.
    process.stdout.write(`${JSON.stringify(line)}\n`);
  };

  return {
    debug: (m, c) => emit('debug', m, c),
    info: (m, c) => emit('info', m, c),
    warn: (m, c) => emit('warn', m, c),
    error: (m, c) => emit('error', m, c),
  };
}
