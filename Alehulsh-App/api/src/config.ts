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
  /** Failed attempts before throttling. coercion-and-escalation.md §7. */
  keywordAttemptCap: number;
  /** Minimum gap between attempts once the cap is reached. Never a lockout. */
  keywordAttemptCooldownMs: number;
  /** Shared secret the task runner presents. Not a user credential. */
  taskRunnerSecret: string;
  /** How many active responders one person may vouch for. P4-07. */
  maxVouchesPerResponder: number;
  /**
   * How close a responder must be before exact coordinates are released.
   * P1-01 §4 / responder-projection.md §4.
   */
  revealRadiusM: number;
  /**
   * Reveal attempts allowed per responder per alert per window. The reported
   * position is unverified, so without a cap a responder could enumerate
   * positions until one landed inside the radius. The cap does not make that
   * impossible — it makes it slow, finite and visible in the audit log.
   */
  revealAttemptCap: number;
  revealAttemptWindowMs: number;
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
    keywordAttemptCap: positiveMs('KEYWORD_ATTEMPT_CAP', 3),
    keywordAttemptCooldownMs: positiveMs('KEYWORD_ATTEMPT_COOLDOWN_MS', 30 * 1000),
    taskRunnerSecret: required('TASK_RUNNER_SECRET'),
    maxVouchesPerResponder: positiveMs('MAX_VOUCHES_PER_RESPONDER', 5),
    revealRadiusM: positiveMs('REVEAL_RADIUS_M', 50),
    revealAttemptCap: positiveMs('REVEAL_ATTEMPT_CAP', 10),
    revealAttemptWindowMs: positiveMs('REVEAL_ATTEMPT_WINDOW_MS', 10 * 60 * 1000),
    env,
  };
}

export { AppError };
