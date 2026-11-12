import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, createApiDatabase, loadDbConfig, isLoopbackHost } from '../src/db/pool.js';
import { createWorkersApp } from '../src/workers/app.js';
import { runWorkerTasks } from '../src/workers/taskRuntime.js';
import { PostgresAlertRepository } from '../src/repositories/postgres/PostgresAlertRepository.js';
import { PostgresUserRepository } from '../src/repositories/postgres/PostgresUserRepository.js';
import { PostgresKeywordResetRepository } from '../src/repositories/postgres/PostgresKeywordResetRepository.js';
import { PostgresInboxRepository } from '../src/repositories/postgres/PostgresInboxRepository.js';
import { PostgresTaskQueue } from '../src/queue/PostgresTaskQueue.js';
import { AlertFanout } from '../src/services/AlertFanout.js';
import { ContactMatcher } from '../src/services/ContactMatcher.js';
import { PostgresContactRepository } from '../src/repositories/postgres/PostgresContactRepository.js';
import { createLogger } from '../src/logger.js';
import { hashKeyword } from '../src/crypto/keyword.js';

let pool: Pool | undefined;
const user = randomUUID(), subject = `worker-${randomUUID()}`, pepper = 'synthetic-workflow-pepper';
let incident = '';
before(async () => {
  if (process.env['ALEHULSH_LOCAL_DB_TESTS'] !== '1') return;
  const config = loadDbConfig(); if (!isLoopbackHost(config.host)) throw Error('local database only');
  pool = createPool(config);
  await pool.query('INSERT INTO users(id,keyword_hash,must_set_keyword)VALUES($1,$2,false)', [user, await hashKeyword('tangerine', pepper)]);
  await pool.query('INSERT INTO identity_map(firebase_uid,user_id)VALUES($1,$2)', [subject, user]);
});
after(async () => { if (!pool) return; await pool.query('DELETE FROM alert_history WHERE owner_id=$1', [user]); await pool.query('DELETE FROM users WHERE id=$1', [user]); await pool.end(); });
function app() {
  return createWorkersApp({
    sessionIsActive: async () => true, tokenVerifier: () => ({ verify: async () => ({ uid: subject, sessionId: randomUUID() }) }),
    withRepositories: async (_env, actor, run) => {
      const db = createApiDatabase(pool!, actor.uid), alerts = new PostgresAlertRepository(db, 7200000), users = new PostgresUserRepository(db), inbox = new PostgresInboxRepository(db);
      return run({
        alerts, inbox, writes: {
          alerts, users, inbox, keywordResets: new PostgresKeywordResetRepository(db), queue: new PostgresTaskQueue(db),
          fanout: new AlertFanout(inbox, null, null, new ContactMatcher(new PostgresContactRepository(db, pepper), users), createLogger('error'))
        }
      });
    }
  });
}
const send = (path: string, body: unknown) => app().request(path, { method: 'POST', headers: { authorization: 'Bearer synthetic', 'content-type': 'application/json' }, body: JSON.stringify(body) }, { KEYWORD_PEPPER: pepper });
const taskEnv = { KEYWORD_PEPPER: pepper, TASK_BATCH_SIZE: '8', TASK_CONCURRENCY: '2', TASK_LEASE_MS: '120000', TASK_DISPATCH_TIMEOUT_MS: '20000', TASK_QUERY_TIMEOUT_MS: '2000' };
const runTasks = () => runWorkerTasks(taskEnv, { withDatabase: async (_env, run) => run(createApiDatabase(pool!)) });
function local(name: string, body: () => Promise<void>) { test(name, async t => { if (!pool) { t.skip('explicit local database not enabled'); return; } await body(); }); }
local('Hono SOS commits required work and retries preserve the original incident', async () => {
  const requestId = randomUUID(); const first = await send('/v1/alerts', { requestId }), again = await send('/v1/alerts', { requestId });
  assert.equal(first.status, 201); assert.equal(again.status, 200);
  const body = await first.json() as { alert: { id: string; }; }; incident = body.alert.id;
  const tasks = await pool!.query('SELECT task_key,run_at FROM task_queue WHERE payload->>\'alertId\'=$1', [incident]);
  assert.equal(tasks.rowCount, 3);
});
local('a bounded scheduled pass processes inbox work without an external notification', async () => {
  const original = globalThis.fetch; globalThis.fetch = async () => { throw Error('no provider calls permitted'); };
  try { const result = await runTasks(); assert.ok(result.succeeded >= 1); } finally { globalThis.fetch = original; }
  const rows = await pool!.query("SELECT state FROM task_queue WHERE task_key=$1", [`notify-contacts:${incident}:initial`]);
  assert.equal(rows.rows[0].state, 'done');
});
local('worker crash leases recover and safety escalation persists its contact work', async () => {
  await pool!.query("UPDATE task_queue SET run_at=now()-interval '1 second' WHERE payload->>'alertId'=$1 AND kind='safety-check'", [incident]);
  const queue = new PostgresTaskQueue(createApiDatabase(pool!));
  const claim = await queue.claim('synthetic-crashed-worker', 100, 1000);
  const own = claim.find(t => t.payload['alertId'] === incident && t.kind === 'safety-check'); assert.ok(own);
  await pool!.query("UPDATE task_queue SET claimed_until=now()-interval '1 second' WHERE id=$1", [own.id]);
  await runTasks();
  const state = await pool!.query('SELECT status FROM alerts WHERE id=$1', [incident]); assert.equal(state.rows[0].status, 'escalated');
  const notification = await pool!.query('SELECT count(*)::int AS n FROM task_queue WHERE task_key=$1', [`notify-contacts:${incident}:escalation`]); assert.equal(notification.rows[0].n, 1);
  await runTasks();
});
local('Hono keyword verification and terminal transition remain atomic and uniform', async () => {
  const wrong = await send(`/v1/alerts/${incident}/resolve`, { keyword: 'incorrect' });
  const correct = await send(`/v1/alerts/${incident}/resolve`, { keyword: 'tangerine' });
  assert.equal(wrong.status, 200); assert.deepEqual(await wrong.json(), await correct.json());
  const state = await pool!.query('SELECT status,attempt_count FROM alerts WHERE id=$1', [incident]);
  assert.equal(state.rows[0].status, 'resolved'); assert.equal(state.rows[0].attempt_count, 1);
});
test('missing task configuration refuses before claiming or opening a database', async () => {
  await assert.rejects(runWorkerTasks({}, { withDatabase: async () => { throw Error('must not reach database'); } }), /pepper/);
  await assert.rejects(runWorkerTasks({ KEYWORD_PEPPER: 'synthetic' }, { withDatabase: async () => { throw Error('must not reach database'); } }), /TASK_BATCH_SIZE/);
});
