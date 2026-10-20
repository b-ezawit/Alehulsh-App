/**
 * Orderly shutdown.  (sprint 3, P5)
 *
 * There was none: no SIGTERM handler and no app.close(), so every deploy and
 * every container restart killed whatever was in flight. For this API that
 * means a POST /v1/alerts that had written nothing yet, and a client that
 * cannot tell a dropped connection from a refusal - so it retries, which is
 * correct, but only if the alert was not half-written.
 *
 * Order matters and is the whole point:
 *
 *   1. stop accepting new connections and let in-flight requests finish
 *   2. THEN close the pools they were using
 *
 * Reversed, the drain would fail: every in-flight request would lose its
 * connection mid-statement.
 */
import type { Logger } from './logger.js';

/** Something to release after the server has drained. Must not throw. */
export type Teardown = () => Promise<void>;

/**
 * The minimum this needs of a server.
 *
 * Structural rather than Pick<FastifyInstance, 'close'>: Fastify's close is
 * overloaded and declared to resolve to undefined, which neither a fake nor a
 * plain async function satisfies. Depending on the shape instead keeps this
 * module testable and independent of the HTTP framework.
 */
export interface Drainable {
  close(): Promise<unknown>;
}

export interface ShutdownOptions {
  app: Drainable;
  logger: Logger;
  /** Pools and similar, closed after the drain, in the order given. */
  teardowns?: readonly Teardown[];
  /**
   * How long to wait for the whole sequence.
   *
   * Bounded deliberately: a shutdown that waits forever on one stuck request
   * is worse than a hard exit, because the orchestrator eventually SIGKILLs
   * anyway and we lose the chance to close anything cleanly.
   */
  timeoutMs?: number;
  /** Injected for testing. Never called from a test run. */
  exit?: (code: number) => void;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Run the shutdown sequence once.
 *
 * Returns rather than exiting, so it can be tested. Every failure is logged
 * and swallowed: teardown runs when something has often already gone wrong,
 * and one failing close must not prevent the others.
 */
export async function shutdown(options: ShutdownOptions): Promise<void> {
  const { app, logger, teardowns = [], timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  const sequence = (async () => {
    try {
      // Drains in-flight requests before returning.
      await app.close();
      logger.info('http server drained');
    } catch (err: unknown) {
      logger.error('http server did not drain cleanly', {
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    for (const teardown of teardowns) {
      try {
        await teardown();
      } catch (err: unknown) {
        // Logged, never rethrown: the next resource still has to be released.
        logger.error('teardown failed', {
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
  })();

  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      logger.error('shutdown timed out; exiting anyway', { timeoutMs });
      resolve();
    }, timeoutMs);
    // Do not hold the event loop open for the timeout itself.
    timer.unref?.();
  });

  try {
    await Promise.race([sequence, bound]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Attach the sequence to the signals an orchestrator actually sends.
 *
 * A SECOND signal exits immediately. Someone pressing Ctrl-C twice, or a
 * platform escalating, means "stop now" - and waiting through the full
 * timeout at that point only looks like a hang.
 */
export function registerShutdownHandlers(options: ShutdownOptions): () => void {
  const { logger, exit = (code: number) => process.exit(code) } = options;
  let started = false;

  const handler = (signal: NodeJS.Signals) => {
    if (started) {
      logger.warn('second signal received; exiting immediately', { signal });
      exit(1);
      return;
    }
    started = true;
    logger.info('shutting down', { signal });
    void shutdown(options).then(() => exit(0));
  };

  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
  for (const signal of signals) process.on(signal, handler);

  // Returned so a test, or an embedding process, can detach without leaving
  // a listener behind on every construction.
  return () => {
    for (const signal of signals) process.off(signal, handler);
  };
}
