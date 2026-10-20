import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { buildServer } from './server.js';
import { FirebaseTokenVerifier } from './auth/FirebaseTokenVerifier.js';
import type { Pool } from 'pg';
import { buildTaskQueue, isDurable } from './queue/buildTaskQueue.js';
import { createPool, loadDbConfig, closePool } from './db/pool.js';
import { InMemorySlidingWindowLimiter } from './rate/RateLimiter.js';
import { registerShutdownHandlers } from './lifecycle.js';
import { FirestoreAlertRepository } from './repositories/firestore/FirestoreAlertRepository.js';
import { FirestoreUserRepository } from './repositories/firestore/FirestoreUserRepository.js';
import { FirestoreInboxRepository } from './repositories/firestore/FirestoreInboxRepository.js';
import { FirestoreAcceptanceRepository } from './repositories/firestore/FirestoreAcceptanceRepository.js';
import { FirestoreLocationRevealRepository } from './repositories/firestore/FirestoreLocationRevealRepository.js';
import { FirestoreEvidenceRepository } from './repositories/firestore/FirestoreEvidenceRepository.js';
import { FirestoreContactRepository } from './repositories/firestore/FirestoreContactRepository.js';
import { FirestoreKeywordResetRepository } from './repositories/firestore/FirestoreKeywordResetRepository.js';
import { FirebaseStorageEvidenceStore } from './evidence/FirebaseStorageEvidenceStore.js';
import { FirestoreClientPolicyRepository } from './repositories/firestore/FirestoreClientPolicyRepository.js';
import { FirestoreVersionTelemetryRepository } from './repositories/firestore/FirestoreVersionTelemetryRepository.js';

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
    // Must be set here. An explicit options object overrides FIREBASE_CONFIG
    // entirely, so the bucket cannot be supplied by environment alone - which
    // is why the previous omission was unrecoverable without a code change.
    storageBucket: config.storageBucket,
  });
  const db = getFirestore(firebase);

  // M-07. The queue is PostgreSQL-backed even while the data is still in
  // Firestore: task_queue has no foreign key to alerts (0008), so a task can
  // reference a Firestore alert id perfectly well. That is what lets the
  // durable queue land before the repository migration.
  //
  // Production refuses to start without the connection rather than falling
  // back to a Map that never fires anything - see buildTaskQueue.
  let dbPool: Pool | undefined;
  try {
    dbPool = createPool(loadDbConfig());
  } catch (err: unknown) {
    if (config.env === 'production') throw err;
    logger.warn('no PostgreSQL configured; scheduled tasks will NOT fire', {
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  const queue = buildTaskQueue(config.env, { pool: dbPool });
  if (!isDurable(queue)) {
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
    evidence: new FirestoreEvidenceRepository(db),
    contacts: new FirestoreContactRepository(db, config.keywordPepper),
    keywordResets: new FirestoreKeywordResetRepository(db),
    evidenceStore: new FirebaseStorageEvidenceStore(getStorage(firebase).bucket()),
    clientPolicy: new FirestoreClientPolicyRepository(db),
    versionTelemetry: new FirestoreVersionTelemetryRepository(db),
    queue,
    // Per-instance and lost on restart, which is fine: nothing safety-critical
    // rides on it. See rate/RateLimiter.ts.
    limiter: new InMemorySlidingWindowLimiter(),
  });

  // Drain in-flight requests on deploy and restart rather than dropping them.
  //
  // `teardowns` is empty: this composition root is still entirely Firestore,
  // and deliberately so (CLAUDE.md s28 - no new Firebase architecture). When a
  // PostgreSQL pool is wired in, its closePool goes here, AFTER the drain, so
  // in-flight requests keep their connections.
  // Ordered: the server drains first, THEN the pool closes, so in-flight
  // requests keep their connections. See lifecycle.ts.
  registerShutdownHandlers({
    app, logger,
    teardowns: dbPool ? [() => closePool(dbPool)] : [],
  });

  await app.listen({ port: config.port, host: '0.0.0.0' });
  logger.info('api listening', { port: config.port, env: config.env });
}

main().catch((err: unknown) => {
  // Startup failure must be loud and must stop the process.
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
