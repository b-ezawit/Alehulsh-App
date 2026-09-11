import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { buildServer } from './server.js';
import { FirebaseTokenVerifier } from './auth/FirebaseTokenVerifier.js';
import { buildTaskQueue } from './queue/buildTaskQueue.js';
import { InMemorySlidingWindowLimiter } from './rate/RateLimiter.js';
import { FirestoreAlertRepository } from './repositories/firestore/FirestoreAlertRepository.js';
import { FirestoreUserRepository } from './repositories/firestore/FirestoreUserRepository.js';
import { FirestoreInboxRepository } from './repositories/firestore/FirestoreInboxRepository.js';
import { FirestoreAcceptanceRepository } from './repositories/firestore/FirestoreAcceptanceRepository.js';
import { FirestoreLocationRevealRepository } from './repositories/firestore/FirestoreLocationRevealRepository.js';

/**
 * Composition root. The only file that knows which implementations are wired
 * in — so C-04 changes this file and the implementation classes, nothing else.
 * See docs/api-layer.md.
 */

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const firebase = initializeApp({
    credential: applicationDefault(),
    projectId: config.firebaseProjectId,
  });
  const db = getFirestore(firebase);

  const queue = buildTaskQueue(config.env);
  if (config.env !== 'production') {
    logger.warn('using the in-memory task queue — scheduled tasks will NOT fire', {
      detail: 'development only; see M-07',
    });
  }

  const app = buildServer({
    config,
    logger,
    tokenVerifier: new FirebaseTokenVerifier(getAuth(firebase)),
    alerts: new FirestoreAlertRepository(db, config.activeWindowMs),
    users: new FirestoreUserRepository(db),
    inbox: new FirestoreInboxRepository(db),
    acceptances: new FirestoreAcceptanceRepository(db),
    reveals: new FirestoreLocationRevealRepository(db),
    queue,
    // Per-instance and lost on restart, which is fine: nothing safety-critical
    // rides on it. See rate/RateLimiter.ts.
    limiter: new InMemorySlidingWindowLimiter(),
  });

  await app.listen({ port: config.port, host: '0.0.0.0' });
  logger.info('api listening', { port: config.port, env: config.env });
}

main().catch((err: unknown) => {
  // Startup failure must be loud and must stop the process.
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
