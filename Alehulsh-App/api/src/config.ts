/**
 * Validated at startup. A missing variable must fail the process, not surface
 * as a 500 during an emergency.
 *
 * CLAUDE.md §12: no secret is ever hardcoded. Everything here comes from the
 * environment, and nothing here is logged.
 */
import { AppError } from './errors.js';

export interface Config {
  port: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Interim, Firebase-era. Removed at C-04. */
  firebaseProjectId: string;
  env: 'development' | 'production';
  /** How long an alert stays live before the expiry backstop. alert-lifecycle.md §3. */
  activeWindowMs: number;
  /** Delay before the safety check fires. SRD layer 2 says two minutes. */
  safetyCheckDelayMs: number;
  /**
   * Server-side secret mixed into keyword hashing, held outside the database
   * so a dump alone cannot be brute-forced against a one-word secret.
   * Rotating it invalidates every stored hash — treat it as permanent.
   */
  keywordPepper: string;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v.trim();
}

export function loadConfig(): Config {
  const level = process.env['LOG_LEVEL'] ?? 'info';
  if (!['debug', 'info', 'warn', 'error'].includes(level)) {
    throw new Error(`LOG_LEVEL must be debug|info|warn|error, got: ${level}`);
  }
  const env = process.env['NODE_ENV'] === 'production' ? 'production' : 'development';

  if (env === 'production' && level === 'debug') {
    // Debug logging in production is how sensitive values escape.
    throw new Error('LOG_LEVEL=debug is not permitted when NODE_ENV=production');
  }

  const positiveMs = (name: string, fallback: number): number => {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number of ms`);
    return n;
  };

  return {
    port: Number(process.env['PORT'] ?? 8080),
    activeWindowMs: positiveMs('ACTIVE_WINDOW_MS', 2 * 60 * 60 * 1000),
    safetyCheckDelayMs: positiveMs('SAFETY_CHECK_DELAY_MS', 2 * 60 * 1000),
    logLevel: level as Config['logLevel'],
    firebaseProjectId: required('FIREBASE_PROJECT_ID'),
    keywordPepper: required('KEYWORD_PEPPER'),
    env,
  };
}

export { AppError };
