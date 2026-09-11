import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { buildServer } from './server.js';
import { FirebaseTokenVerifier } from './auth/FirebaseTokenVerifier.js';
import { InMemoryTaskQueue } from './queue/TaskQueue.js';
import type {
  AcceptanceRepository, AlertRepository, InboxRepository,
  LocationRevealRepository, UserRepository,
} from './repositories/types.js';

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

  // The composition root is still unwired on purpose. FirestoreAlertRepository
  // and FirestoreUserRepository exist, but there are no Firestore
  // implementations of InboxRepository or AcceptanceRepository yet, so wiring
  // half of them would produce a service that starts, accepts traffic and then
  // fails mid-request. Failing at the first call, loudly and by name, is the
  // safer shape until the set is complete.
  const notImplemented = (name: string) => () => {
    throw new Error(`${name} not implemented — composition root is not wired yet`);
  };
  const stub = <T extends object>() =>
    new Proxy({} as T, { get: (_t, p) => notImplemented(String(p)) });

  const alerts = stub<AlertRepository>();
  const users = stub<UserRepository>();
  const inbox = stub<InboxRepository>();
  const acceptances = stub<AcceptanceRepository>();
  const reveals = stub<LocationRevealRepository>();

  const app = buildServer({
    config,
    logger,
    tokenVerifier: new FirebaseTokenVerifier(getAuth(firebase)),
    alerts,
    users,
    inbox,
    acceptances,
    reveals,
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
