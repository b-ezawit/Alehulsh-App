import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { buildServer } from './server.js';
import { FirebaseTokenVerifier } from './auth/FirebaseTokenVerifier.js';
import { InMemoryTaskQueue } from './queue/TaskQueue.js';
import type { AlertRepository, UserRepository } from './repositories/types.js';

/**
 * Composition root. The only file that knows which implementations are wired
 * in — so C-04 changes this file and the three implementation classes, nothing
 * else. See docs/api-layer.md.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const firebase = initializeApp({
    credential: applicationDefault(),
    projectId: config.firebaseProjectId,
  });

  const notImplemented = (name: string) => () => {
    throw new Error(`${name} not implemented — lands with P1-08/P1-09`);
  };
  const alerts = new Proxy({} as AlertRepository, { get: (_t, p) => notImplemented(String(p)) });
  const users = new Proxy({} as UserRepository, { get: (_t, p) => notImplemented(String(p)) });

  const app = buildServer({
    config,
    logger,
    tokenVerifier: new FirebaseTokenVerifier(getAuth(firebase)),
    alerts,
    users,
    queue: new InMemoryTaskQueue(),
  });

  await app.listen({ port: config.port, host: '0.0.0.0' });
  logger.info('api listening', { port: config.port, env: config.env });
}

main().catch((err: unknown) => {
  // Startup failure must be loud and must stop the process.
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
