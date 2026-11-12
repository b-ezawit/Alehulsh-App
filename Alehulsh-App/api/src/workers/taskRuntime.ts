import {requireRestrictedRuntimeLogin} from '../db/runtimeLogin.js';
import {dispatchPrivateDeliveries,type PrivatePushProvider} from '../notifications/PrivateDelivery.js';
import {readSessionPolicy} from '../auth/SupabaseSessionBridge.js';
import {FcmPrivatePushProvider} from '../notifications/FcmPrivatePushProvider.js';
import {PostgresIdentifierSource} from '../auth/PostgresIdentifierSource.js';
import { Pool, type QueryResultRow } from 'pg';
import { createApiDatabase, closePool, type Queryable } from '../db/pool.js';
import { PostgresAlertRepository } from '../repositories/postgres/PostgresAlertRepository.js';
import { PostgresInboxRepository } from '../repositories/postgres/PostgresInboxRepository.js';
import { PostgresUserRepository } from '../repositories/postgres/PostgresUserRepository.js';
import { PostgresContactRepository } from '../repositories/postgres/PostgresContactRepository.js';
import { PostgresTaskQueue } from '../queue/PostgresTaskQueue.js';
import { runTaskBatch } from '../queue/runTaskBatch.js';
import { AbandonedTaskMonitor } from '../queue/AbandonedTaskMonitor.js';
import { OverduePendingProbe } from '../queue/OverduePendingProbe.js';
import { processAlertTask, type AlertTaskKind } from '../services/processAlertTask.js';
import { AlertFanout } from '../services/AlertFanout.js';
import { ContactMatcher } from '../services/ContactMatcher.js';
import { workerLogger, type WorkerBindings } from './app.js';

export interface TaskBindings extends WorkerBindings {
  PUSH_DELIVERY_ENABLED?:string;
  FCM_PROJECT_ID?:string;
  FCM_CLIENT_EMAIL?:string;
  FCM_PRIVATE_KEY?:string;
  TASK_BATCH_SIZE?: string;
  TASK_CONCURRENCY?: string;
  TASK_LEASE_MS?: string;
  TASK_DISPATCH_TIMEOUT_MS?: string;
  TASK_QUERY_TIMEOUT_MS?: string;
}
export interface TaskRuntimeDependencies {
  privatePushProvider?:PrivatePushProvider;
  withDatabase?: <T>(env: TaskBindings, run: (db: Queryable) => Promise<T>) => Promise<T>;
}
async function systemDatabase<T>(env: TaskBindings, run: (db: Queryable) => Promise<T>): Promise<T> {
  if (!env.HYPERDRIVE?.connectionString) throw Error('missing Hyperdrive binding');
  const timeout = Number(env.TASK_QUERY_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw Error('task query timeout required');
  const pool = new Pool({
    connectionString: env.HYPERDRIVE.connectionString, max: Number(env.TASK_CONCURRENCY),
    connectionTimeoutMillis: timeout, query_timeout: timeout, statement_timeout: timeout, idleTimeoutMillis: 1000
  });
  try { const db=createApiDatabase(pool);await requireRestrictedRuntimeLogin(db);return await run(db); } finally { await closePool(pool); }
}
/** No polling loop, provider calls, or transaction held across a whole batch. */
export async function runWorkerTasks(env: TaskBindings, deps: TaskRuntimeDependencies = {}) {
  if (!env.KEYWORD_PEPPER?.trim()) throw Error('authoritative keyword pepper required');
  for (const key of ['TASK_BATCH_SIZE', 'TASK_CONCURRENCY', 'TASK_LEASE_MS', 'TASK_DISPATCH_TIMEOUT_MS', 'TASK_QUERY_TIMEOUT_MS'] as const) {
    if (!/^\d+$/.test(env[key] ?? '') || Number(env[key]) < 1 || !Number.isSafeInteger(Number(env[key]))) throw Error(`invalid or missing ${key}`);
  }
  const options = {
    worker: crypto.randomUUID(), batchSize: Number(env.TASK_BATCH_SIZE),
    concurrency: Number(env.TASK_CONCURRENCY), leaseMs: Number(env.TASK_LEASE_MS),
    dispatchTimeoutMs: Number(env.TASK_DISPATCH_TIMEOUT_MS)
  };
  return (deps.withDatabase ?? systemDatabase)(env, async db => {
    const result = await runTaskBatch(db, async task => {
      const kind = task.kind as AlertTaskKind;
      if (!['safety-check', 'expiry', 'notify-contacts', 'retract-inbox'].includes(kind)) throw Error('unknown task kind');
      const { alertId, alertKey } = task.payload;
      if (typeof alertId !== 'string' || typeof alertKey !== 'string' || !alertId || !alertKey) throw Error('incident identity required');
      const deadline = Date.now() + options.dispatchTimeoutMs;
      // Stop issuing new statements after the dispatch budget. Driver/server
      // deadlines bound the currently executing statement; no background race
      // is abandoned with Promise.race while it can still change data.
      const bounded: Queryable = {
        async query<R extends QueryResultRow>(sql: string, params?: readonly unknown[]) {
          if (Date.now() > deadline) throw Error('task dispatch deadline elapsed');
          const rows = await db.query<R>(sql, params);
          if (Date.now() > deadline) throw Error('task dispatch deadline elapsed');
          return rows;
        }
      };
      const identifiers=new PostgresIdentifierSource(bounded,env.KEYWORD_PEPPER!);
      const inbox = new PostgresInboxRepository(bounded,identifiers), users = new PostgresUserRepository(bounded,identifiers);
      const fanout = new AlertFanout(inbox, null, null, new ContactMatcher(
        new PostgresContactRepository(bounded, env.KEYWORD_PEPPER!), users), workerLogger);
      await processAlertTask({
        alerts: new PostgresAlertRepository(bounded, 7200000), inbox, fanout,
        queue: new PostgresTaskQueue(bounded), config: { safetyCheckDelayMs: 120000 }, logger: workerLogger
      }, kind, { alertId, alertKey });
    }, workerLogger, options);
    // These record/measure local queue state; neither sends notifications.
    await new AbandonedTaskMonitor(db, workerLogger, { batchSize: options.batchSize }).scan();
    await new OverduePendingProbe(db, workerLogger).scan({ claimed: result.claimed, capacity: options.batchSize });
    const provider=deps.privatePushProvider??(env.PUSH_DELIVERY_ENABLED==='true'?new FcmPrivatePushProvider({
      projectId:env.FCM_PROJECT_ID??'',clientEmail:env.FCM_CLIENT_EMAIL??'',privateKey:env.FCM_PRIVATE_KEY??''}):undefined);
    if(provider){
      if(!env.PUSH_CONSENT_VERSION?.trim()||!env.PUSH_CONSENT_TEXT?.trim())throw Error('approved push consent required');
      await dispatchPrivateDeliveries(db,provider,{worker:options.worker,consentVersion:env.PUSH_CONSENT_VERSION,
        limit:options.batchSize,timeoutMs:options.dispatchTimeoutMs,leaseMs:options.leaseMs,
        sessionPolicy:readSessionPolicy(env),pepper:env.KEYWORD_PEPPER!});
    }
    return result;
  });
}
