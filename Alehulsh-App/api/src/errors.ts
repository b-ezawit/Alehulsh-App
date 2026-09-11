/**
 * Client-safe error contract.
 *
 * The audit found emergency_screen.dart showing users
 * "Database permission error: Please update Firestore Security Rules."
 * (SEC-14). Internal detail must never cross this boundary.
 *
 * Rule: the client receives a stable code and a message we wrote. Everything
 * else — driver errors, stack traces, provider responses — stays server-side.
 */

export type ErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'invalid_request'
  | 'rate_limited'
  | 'conflict'
  | 'internal';

const STATUS: Record<ErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  invalid_request: 400,
  rate_limited: 429,
  conflict: 409,
  internal: 500,
};

/**
 * Deliberately vague where vagueness is a security property. `forbidden` and
 * `not_found` must be indistinguishable to a caller probing for which alert
 * ids exist.
 */
const PUBLIC_MESSAGE: Record<ErrorCode, string> = {
  unauthenticated: 'Sign in required.',
  forbidden: 'Not available.',
  not_found: 'Not available.',
  invalid_request: 'The request could not be processed.',
  rate_limited: 'Too many attempts. Try again shortly.',
  conflict: 'That action conflicts with the current state.',
  internal: 'Something went wrong on our side.',
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** Server-side only. Never serialised to a client. */
  readonly detail: string | undefined;

  constructor(code: ErrorCode, detail?: string, options?: { cause?: unknown }) {
    super(PUBLIC_MESSAGE[code], options);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code];
    this.detail = detail;
  }
}

export interface ClientErrorBody {
  error: { code: ErrorCode; message: string };
}

/**
 * Maps anything thrown into a response. An unrecognised error becomes a plain
 * 500 — we never surface a message we did not write.
 */
export function toClientError(err: unknown): {
  status: number;
  body: ClientErrorBody;
  /** For the log only. */
  internal: Record<string, unknown>;
} {
  if (err instanceof AppError) {
    return {
      status: err.status,
      body: { error: { code: err.code, message: err.message } },
      internal: { code: err.code, detail: err.detail, cause: err.cause },
    };
  }
  return {
    status: 500,
    body: { error: { code: 'internal', message: PUBLIC_MESSAGE.internal } },
    internal: { unhandled: err instanceof Error ? err.message : String(err) },
  };
}
