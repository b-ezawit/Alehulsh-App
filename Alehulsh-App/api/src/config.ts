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

  return {
    port: Number(process.env['PORT'] ?? 8080),
    logLevel: level as Config['logLevel'],
    firebaseProjectId: required('FIREBASE_PROJECT_ID'),
    env,
  };
}

export { AppError };
