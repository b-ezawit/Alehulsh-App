/** Real Hono + PostgreSQL workflow. Authentication and verified identifier
 * ownership are synthetic fixtures; this does not verify Auth signup or push. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createWorkersApp } from '../src/workers/app.js';
import { runWorkerTasks } from '../src/workers/taskRuntime.js';
import { createPool, loadDbConfig, isLoopbackHost, createApiDatabase } from '../src/db/pool.js';
import { PostgresAlertRepository } from '../src/repositories/postgres/PostgresAlertRepository.js';
import { PostgresUserRepository } from '../src/repositories/postgres/PostgresUserRepository.js';
import { PostgresInboxRepository } from '../src/repositories/postgres/PostgresInboxRepository.js';
import { PostgresAcceptanceRepository } from '../src/repositories/postgres/PostgresAcceptanceRepository.js';
import { PostgresContactRepository } from '../src/repositories/postgres/PostgresContactRepository.js';
import { PostgresContactManagementRepository } from '../src/repositories/postgres/PostgresContactManagementRepository.js';
import { PostgresKeywordResetRepository } from '../src/repositories/postgres/PostgresKeywordResetRepository.js';
import { PostgresTaskQueue } from '../src/queue/PostgresTaskQueue.js';
import { AlertFanout } from '../src/services/AlertFanout.js';
import { ContactMatcher } from '../src/services/ContactMatcher.js';
import { createLogger } from '../src/logger.js';
import { hashPhone } from '../src/crypto/identifier.js';
import {SupabaseSessionBridge} from '../src/auth/SupabaseSessionBridge.js';

test('synthetic A/B incident survives lost acknowledgment, authorized acceptance, resolution, stale work and a new SOS', async t => {
  if (process.env['ALEHULSH_LOCAL_DB_TESTS'] !== '1') { t.skip('explicit local fixture required'); return; }
  const cfg=loadDbConfig(); assert.ok(isLoopbackHost(cfg.host)); const pool=createPool(cfg);
  const a=randomUUID(),b=randomUUID(),c=randomUUID(),as=`scenario-a-${randomUUID()}`,bs=`scenario-b-${randomUUID()}`,cs=`scenario-c-${randomUUID()}`;
  const ids=[a,b,c],pepper='synthetic-scenario-only',phone='+251911234567';
  const providerB=randomUUID(),providerSession=randomUUID();
  const env={KEYWORD_PEPPER:pepper};
  try {
    await pool.query("INSERT INTO users(id,display_name,must_set_keyword) VALUES($1,'Synthetic A',true),($2,'Synthetic B',true),($3,'Synthetic C',true)",ids);
    await pool.query('INSERT INTO identity_map(firebase_uid,user_id) VALUES($1,$2),($3,$4),($5,$6)',[as,a,bs,b,cs,c]);
    // Synthetic provider confirmation and an explicit test-only account
    // binding. This is never an account-linking procedure for existing users.
    await pool.query('INSERT INTO auth.users(id,phone,phone_confirmed_at)VALUES($1,$2,now())',[providerB,phone]);
    await pool.query('INSERT INTO auth.sessions(id,user_id)VALUES($1,$2)',[providerSession,providerB]);
    await pool.query('INSERT INTO supabase_accounts(auth_subject,user_id)VALUES($1,$2)',[providerB,b]);
    const bridge=new SupabaseSessionBridge(createApiDatabase(pool),{maxAgeSeconds:0,inactivitySeconds:0});
    const actor={uid:providerB,sessionId:providerSession};await bridge.synchronizeIdentifiers(actor,(await bridge.inspect(actor))!,pepper);
    const app=createWorkersApp({
      sessionIsActive:async()=>true,
      tokenVerifier:()=>({verify:async token=>({uid:token==='synthetic-a'?as:token==='synthetic-b'?bs:cs,sessionId:randomUUID()})}),
      withRepositories:async(_env,subject,run)=>{
        const db=createApiDatabase(pool,subject.uid),alerts=new PostgresAlertRepository(db,7200000),users=new PostgresUserRepository(db),
          inbox=new PostgresInboxRepository(db),acceptances=new PostgresAcceptanceRepository(db),contacts=new PostgresContactRepository(db,pepper);
        return run({alerts,inbox,acceptances,contactManagement:new PostgresContactManagementRepository(db),writes:{
          alerts,users,inbox,acceptances,contacts,queue:new PostgresTaskQueue(db),keywordResets:new PostgresKeywordResetRepository(db),
          fanout:new AlertFanout(inbox,null,null,new ContactMatcher(contacts,users),createLogger('error')),
        }});
      },
    });
    const send=(actor:string,path:string,method='GET',body?:unknown)=>app.request(path,{method,
      headers:{authorization:`Bearer synthetic-${actor}`,'content-type':'application/json'},
      ...(body===undefined?{}:{body:JSON.stringify(body)})},env);
    assert.equal((await send('a','/v1/me/keyword','PUT',{keyword:'tangerine'})).status,200);
    assert.equal((await send('a',`/v1/me/contacts/${randomUUID()}`,'PUT',{name:'Synthetic B',phone,isPrimary:true})).status,201);
    const requestId=randomUUID(),payload={requestId,latitude:9.01,longitude:38.76,accuracyMeters:10,locationAgeMs:1000};
    const first=await send('a','/v1/alerts','POST',payload); assert.equal(first.status,201);
    const original=(await first.json() as any).alert;
    assert.equal((await send('c',`/v1/alerts/${original.id}`,'PATCH',{incidentKey:original.key,message:'unauthorized'})).status,404);
    assert.equal((await send('a',`/v1/alerts/${original.id}`,'PATCH',{incidentKey:original.key,latitude:10})).status,400);
    assert.equal((await send('a',`/v1/alerts/${original.id}`,'PATCH',{incidentKey:original.key,message:'Synthetic private owner note',isUrgent:true})).status,200);
    const replay=await send('a','/v1/alerts','POST',payload); assert.equal(replay.status,200);
    assert.equal((await replay.json() as any).alert.key,original.key);
    const tasks=await pool.query('SELECT count(*)::int AS count FROM task_queue WHERE payload->>\'alertId\'=$1',[original.id]);
    assert.equal(tasks.rows[0].count,3);
    const run=()=>runWorkerTasks({...env,TASK_BATCH_SIZE:'8',TASK_CONCURRENCY:'2',TASK_LEASE_MS:'120000',TASK_DISPATCH_TIMEOUT_MS:'20000',TASK_QUERY_TIMEOUT_MS:'2000'},
      {withDatabase:async(_env,work)=>work(createApiDatabase(pool))});
    for(let pass=0;pass<5;pass++) {
      await run();
      if((await (await send('b','/v1/me/inbox')).json() as any).items.length) break;
    }
    const selected=(await (await send('b','/v1/me/inbox')).json() as any).items;
    assert.equal(selected.length,1); assert.equal(selected[0].key,original.key); assert.equal(selected[0].precision,'exact');
    assert.equal(selected[0].isUrgent,true);assert.equal(selected[0].message,undefined);
    assert.equal((await (await send('c','/v1/me/inbox')).json() as any).items.length,0);
    assert.equal((await send('c',`/v1/alerts/${original.id}/accept`,'POST',{incidentKey:original.key})).status,404);
    assert.equal((await send('b',`/v1/alerts/${original.id}/accept`,'POST',{incidentKey:original.key})).status,201);
    assert.equal((await send('b',`/v1/alerts/${original.id}/accept`,'POST',{incidentKey:original.key})).status,200);
    assert.equal((await (await send('b','/v1/me/inbox')).json() as any).items[0].hasAcknowledged,true);
    assert.equal((await send('c',`/v1/alerts/${original.id}/accept`,'DELETE',{incidentKey:original.key})).status,204);
    assert.equal((await send('b',`/v1/alerts/${original.id}/accept`,'DELETE',{incidentKey:original.key,uid:cs})).status,400);
    assert.equal((await send('b',`/v1/alerts/${original.id}/accept`,'DELETE',{incidentKey:original.key})).status,204);
    assert.equal((await (await send('b','/v1/me/inbox')).json() as any).items[0].hasAcknowledged,false);
    assert.equal((await send('b',`/v1/alerts/${original.id}/accept`,'POST',{incidentKey:original.key})).status,201);
    const owner=(await (await send('a','/v1/me/alert')).json() as any).alert;
    assert.equal(owner.message,'Synthetic private owner note');assert.equal(owner.isUrgent,true);
    assert.equal(owner.acknowledgmentCount,1);
    const wrong=await send('a',`/v1/alerts/${original.id}/resolve`,'POST',{keyword:'incorrect',incidentKey:original.key});
    const correct=await send('a',`/v1/alerts/${original.id}/resolve`,'POST',{keyword:'tangerine',incidentKey:original.key});
    assert.equal(wrong.status,200); assert.equal(correct.status,200); assert.deepEqual(await wrong.json(),await correct.json());
    assert.equal((await (await send('a','/v1/me/alert')).json() as any).alert,null);
    assert.equal((await (await send('b','/v1/me/inbox')).json() as any).items.length,0);
    assert.equal((await send('a',`/v1/alerts/${original.id}`,'PATCH',{incidentKey:original.key,message:'late edit'})).status,404);
    await run(); // Late escalation/fan-out work cannot revive the terminal alert.
    assert.equal((await (await send('b','/v1/me/inbox')).json() as any).items.length,0);
    const fresh=await send('a','/v1/alerts','POST',{requestId:randomUUID()}); assert.equal(fresh.status,201);
    const next=(await fresh.json() as any).alert; assert.notEqual(next.key,original.key);
    const stale=await send('a',`/v1/alerts/${original.id}/resolve`,'POST',{keyword:'tangerine',incidentKey:original.key}); assert.equal(stale.status,200);
    assert.equal((await (await send('a','/v1/me/alert')).json() as any).alert.key,next.key);
  } finally {
    await pool.query("DELETE FROM task_queue WHERE payload->>'alertId' IN (SELECT id::text FROM alerts WHERE owner_id=ANY($1::uuid[]))",[ids]);
    await pool.query('DELETE FROM alert_history WHERE owner_id=ANY($1::uuid[])',[ids]);
    await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[ids]);
    await pool.query('DELETE FROM auth.users WHERE id=$1',[providerB]);
    await pool.end();
  }
});
