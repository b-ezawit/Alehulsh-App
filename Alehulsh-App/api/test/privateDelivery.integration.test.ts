import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createPool,loadDbConfig,isLoopbackHost,createApiDatabase} from '../src/db/pool.js';
import {PostgresIdentifierSource} from '../src/auth/PostgresIdentifierSource.js';
import {SupabaseSessionBridge} from '../src/auth/SupabaseSessionBridge.js';
import {PrivateDelivery,dispatchPrivateDeliveries,type PrivatePushProvider} from '../src/notifications/PrivateDelivery.js';
import {PostgresAlertRepository} from '../src/repositories/postgres/PostgresAlertRepository.js';
import {PostgresInboxRepository} from '../src/repositories/postgres/PostgresInboxRepository.js';
import {PostgresUserRepository} from '../src/repositories/postgres/PostgresUserRepository.js';
import {PostgresContactRepository} from '../src/repositories/postgres/PostgresContactRepository.js';
import {PostgresContactManagementRepository} from '../src/repositories/postgres/PostgresContactManagementRepository.js';
import {ContactMatcher} from '../src/services/ContactMatcher.js';
import {AlertFanout} from '../src/services/AlertFanout.js';
import {createLogger} from '../src/logger.js';
import {createWorkersApp} from '../src/workers/app.js';
import {hashKeyword} from '../src/crypto/keyword.js';
import {PostgresAcceptanceRepository} from '../src/repositories/postgres/PostgresAcceptanceRepository.js';
import {PostgresKeywordResetRepository} from '../src/repositories/postgres/PostgresKeywordResetRepository.js';
import {PostgresTaskQueue} from '../src/queue/PostgresTaskQueue.js';
import {runWorkerTasks} from '../src/workers/taskRuntime.js';
let pool:Pool|undefined,runtime:Pool|undefined;
const role='private_delivery_'+randomUUID().replaceAll('-',''),subjects:string[]=[],users:string[]=[];
const policy={maxAgeSeconds:0,inactivitySeconds:0},pepper='synthetic-private-delivery-only',consent='synthetic-review-v1';
before(async()=>{
 if(process.env['ALEHULSH_LOCAL_DB_TESTS']!=='1')return;const cfg=loadDbConfig();assert.ok(isLoopbackHost(cfg.host));pool=createPool(cfg);
 await pool.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD 'synthetic-local-only'`);
 await pool.query(`GRANT alehulsh_api TO ${role}`);runtime=new Pool({...cfg,user:role,password:'synthetic-local-only',ssl:false,max:3});
});
after(async()=>{
 if(!pool)return;
 await pool.query('DELETE FROM outbox WHERE recipient_id=ANY($1::uuid[]) OR alert_id IN(SELECT id FROM alerts WHERE owner_id=ANY($1::uuid[]))',[users]);
 await pool.query('DELETE FROM alert_history WHERE owner_id=ANY($1::uuid[])',[users]);
 await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users]);
 await pool.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])',[subjects]);
 await runtime?.end();await pool.query(`DROP ROLE ${role}`);await pool.end();
});
function local(name:string,fn:()=>Promise<void>){test(name,async t=>{if(!pool){t.skip('explicit isolated localhost database required');return;}await fn();});}
async function actor(phone:string|null=null){
 const uid=randomUUID(),sessionId=randomUUID();subjects.push(uid);
 await pool!.query('INSERT INTO auth.users(id,email,email_confirmed_at,phone,phone_confirmed_at)VALUES($1,$2,now(),$3::text,CASE WHEN $3::text IS NULL THEN NULL ELSE now() END)',[uid,`synthetic-${uid}@test.invalid`,phone]);
 await pool!.query('INSERT INTO auth.sessions(id,user_id)VALUES($1,$2)',[sessionId,uid]);
 const subject={uid,sessionId},bridge=new SupabaseSessionBridge(createApiDatabase(runtime!),policy);
 const external=await bridge.provision(subject,{name:'Synthetic',homeAddress:'',keywordHash:await hashKeyword('tangerine',pepper)});
 await bridge.synchronizeIdentifiers(subject,(await bridge.inspect(subject))!,pepper);
 const id=(await pool!.query('SELECT user_id FROM supabase_accounts WHERE auth_subject=$1',[uid])).rows[0].user_id;users.push(id);
 const db=createApiDatabase(runtime!,external);return {subject,external,id,db,delivery:new PrivateDelivery(db,new PostgresIdentifierSource(db,pepper))};
}
async function incident(){
 const phone='+2519'+String(10000000+subjects.length),a=await actor(),b=await actor(phone),c=await actor(),device=randomUUID(),token='synthetic-device-token-'+randomUUID();
 const generation=await b.delivery.register(device,b.subject.sessionId,token,consent);
 await new PostgresContactManagementRepository(a.db).put(a.external,randomUUID(),{name:'Synthetic B',phone,email:'',relationship:'',isPrimary:true});
 const alerts=new PostgresAlertRepository(a.db,7200000),alert=(await alerts.create({ownerId:a.external,requestId:randomUUID(),latitude:9.01,longitude:38.76})).alert;
 // Contact resolution and provider ownership are real restricted-role SQL;
 // fixture Auth users/sessions stand in for provider registration only.
 const system=createApiDatabase(runtime!),inbox=new PostgresInboxRepository(system,new PostgresIdentifierSource(system,pepper));
 const fanout=new AlertFanout(inbox,null,null,new ContactMatcher(new PostgresContactRepository(system,pepper),new PostgresUserRepository(system,new PostgresIdentifierSource(system,pepper))),createLogger('error'));
 const result=await fanout.dispatch(alert);assert.deepEqual(result.contacts,[b.external]);
 return {a,b,c,device,token,generation,alert,fanout,system};
}
const options=()=>({worker:randomUUID(),consentVersion:consent,limit:20,timeoutMs:1000,leaseMs:30000,pepper,sessionPolicy:policy});
const accepted:PrivatePushProvider={send:async()=>({messageId:'synthetic-provider-accepted'})};
local('atomic inbox and private intent; opaque delivery, unauthorized third user and separate lifecycle facts',async()=>{
 const f=await incident();await f.fanout.dispatch(f.alert);
 const rows=await pool!.query("SELECT * FROM outbox WHERE alert_id=$1 AND channel='private-push'",[f.alert.id]);assert.equal(rows.rowCount,1);
 assert.deepEqual(rows.rows[0].payload,{kind:'incident'});let data:unknown;
 const result=await dispatchPrivateDeliveries(f.system,{send:async(token,payload)=>{assert.equal(token,f.token);data=payload;return {messageId:'synthetic-receipt'};}},options());
 assert.equal(result.accepted,1);assert.deepEqual(data,{deliveryId:rows.rows[0].delivery_id});
 await assert.rejects(f.c.delivery.open(rows.rows[0].delivery_id,'opened'),(e:unknown)=>(e as {code?:string}).code==='not_found');
 const before=(await f.a.delivery.summary(f.alert.id))!;assert.equal(before.provider_accepted,1);assert.equal(before.device_received,0);assert.equal(before.opened,0);
 assert.deepEqual(await f.b.delivery.open(rows.rows[0].delivery_id,'received'),{incidentId:f.alert.id,active:true});
 await f.b.delivery.open(rows.rows[0].delivery_id,'opened');await f.b.delivery.open(rows.rows[0].delivery_id,'opened');
 const after=(await f.a.delivery.summary(f.alert.id))!;assert.equal(after.device_received,1);assert.equal(after.opened,1);
});
local('transaction-local identity denies other users device tokens and delivery rows, including sender receipt forgery',async()=>{
 const f=await incident();
 assert.equal((await f.c.db.query('SELECT token FROM push_devices WHERE id=$1',[f.device])).rowCount,0);
 assert.equal((await f.c.db.query('SELECT delivery_id FROM outbox WHERE alert_id=$1',[f.alert.id])).rowCount,0);
 assert.equal((await f.b.db.query('SELECT token FROM push_devices WHERE id=$1',[f.device])).rows[0]?.token,f.token);
 assert.equal((await f.a.db.query('SELECT delivery_id FROM outbox WHERE alert_id=$1',[f.alert.id])).rowCount,1);
 assert.equal((await f.a.db.query('UPDATE outbox SET device_received_at=now() WHERE alert_id=$1',[f.alert.id])).rowCount,0);
 await dispatchPrivateDeliveries(f.system,accepted,options());
});
local('PostgreSQL matching, exact inbox access and dispatch recheck live provider confirmation rather than historical hashes',async()=>{
 const f=await incident(),identifiers=new PostgresIdentifierSource(f.b.db,pepper),protectedInbox=new PostgresInboxRepository(f.b.db,identifiers);
 assert.equal((await protectedInbox.listForRecipient(f.b.external,25)).length,1);
 assert.equal((await f.a.db.query('SELECT * FROM current_supabase_contact_identifiers($1)',[f.b.external])).rowCount,0);
 await pool!.query('UPDATE auth.users SET phone_confirmed_at=NULL WHERE id=$1',[f.b.subject.uid]);
 assert.equal((await new PostgresUserRepository(f.system,new PostgresIdentifierSource(f.system,pepper)).findUidByIdentifierHash(
   (await pool!.query('SELECT phone_hash FROM users WHERE id=$1',[f.b.id])).rows[0].phone_hash)),null);
 assert.deepEqual(await protectedInbox.listForRecipient(f.b.external,25),[]);
 assert.equal((await dispatchPrivateDeliveries(f.system,accepted,options())).accepted,0);
});
local('recipient device opt-out stops queued private delivery without canceling the sender emergency',async()=>{
 const f=await incident();await f.b.delivery.disable(f.device,f.generation);await f.b.delivery.disable(f.device,f.generation);
 assert.equal((await dispatchPrivateDeliveries(f.system,accepted,options())).accepted,0);
 assert.equal((await new PostgresAlertRepository(f.a.db,7200000).findById(f.alert.id))?.status,'active');
 assert.equal((await pool!.query('SELECT token,enabled FROM push_devices WHERE id=$1',[f.device])).rows[0].enabled,false);
});
local('terminal and expired incidents cannot dispatch stale location; reconciliation remains incident specific',async()=>{
 const f=await incident(),rows=await pool!.query("SELECT delivery_id FROM outbox WHERE alert_id=$1",[f.alert.id]);
 await new PostgresAlertRepository(f.a.db,7200000).updateStatus(f.alert.id,'resolved',{});
 let sends=0;await dispatchPrivateDeliveries(f.system,{send:async(_t,data)=>{sends++;assert.deepEqual(Object.keys(data),['deliveryId']);return {messageId:'synthetic-close'};}},options());
 assert.equal(sends,1);assert.deepEqual(await f.b.delivery.open(rows.rows[0].delivery_id,'opened'),{incidentId:f.alert.id,active:false});
 const fresh=(await new PostgresAlertRepository(f.a.db,7200000).create({ownerId:f.a.external,requestId:randomUUID(),latitude:null,longitude:null})).alert;
 assert.notEqual(fresh.id,f.alert.id);assert.equal((await f.b.delivery.open(rows.rows[0].delivery_id,'opened')).incidentId,f.alert.id);
 await f.fanout.dispatch(fresh);await pool!.query("UPDATE alerts SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 second' WHERE id=$1",[fresh.id]);
 assert.equal((await dispatchPrivateDeliveries(f.system,accepted,options())).accepted,0);
});
local('network failures retry with sanitized errors and exhausted process-death leases become dead letters',async()=>{
 const f=await incident(),failed=await dispatchPrivateDeliveries(f.system,{send:async()=>{throw Error(f.token);}},options());assert.equal(failed.retry,1);
 let row=(await pool!.query('SELECT * FROM outbox WHERE alert_id=$1',[f.alert.id])).rows[0];assert.equal(row.state,'pending');assert.equal(row.last_error.includes(f.token),false);
 await pool!.query("UPDATE outbox SET next_retry_at=now() WHERE id=$1",[row.id]);
 assert.equal((await dispatchPrivateDeliveries(f.system,accepted,options())).accepted,1);
 await pool!.query("UPDATE outbox SET state='claimed',claimed_by='dead-process',claimed_until=now()-interval '1 second',attempts=max_attempts WHERE id=$1",[row.id]);
 await dispatchPrivateDeliveries(f.system,accepted,options());row=(await pool!.query('SELECT * FROM outbox WHERE id=$1',[row.id])).rows[0];assert.equal(row.state,'abandoned');
});
local('token rotation fences stale invalid-token results and disable cannot cross accounts or device generations',async()=>{
 const f=await incident(),replacement='synthetic-replacement-token-'+randomUUID();let generation='';
 await dispatchPrivateDeliveries(f.system,{send:async()=>{generation=await f.b.delivery.register(f.device,f.b.subject.sessionId,replacement,consent,2);return {invalidToken:true};}},options());
 assert.notEqual(generation,f.generation);await f.b.delivery.disable(f.device,f.generation);await f.c.delivery.disable(f.device,generation);
 const row=(await pool!.query('SELECT token,enabled FROM push_devices WHERE id=$1',[f.device])).rows[0];assert.deepEqual(row,{token:replacement,enabled:true});
 await assert.rejects(f.c.delivery.register(f.device,f.c.subject.sessionId,replacement,consent));
 assert.equal((await dispatchPrivateDeliveries(f.system,accepted,options())).accepted,1);
 await new SupabaseSessionBridge(createApiDatabase(runtime!),policy).revoke(f.b.subject);
 await f.fanout.dispatch(f.alert);assert.equal((await dispatchPrivateDeliveries(f.system,accepted,options())).accepted,0);
});
local('Workers registration requires explicit configured consent, rejects spoofed identity and protects delivery receipts',async()=>{
 const b=await actor(),c=await actor(),id=randomUUID();const registry=new Map([['b',b],['c',c]]);
 const app=createWorkersApp({tokenVerifier:()=>({verify:async token=>registry.get(token)!.subject}),withAuthDatabase:async(_env,run)=>run(createApiDatabase(runtime!)),
   withRepositories:async(_env,subject,run)=>{const db=createApiDatabase(runtime!,subject.uid);return run({alerts:new PostgresAlertRepository(db,7200000),inbox:new PostgresInboxRepository(db,new PostgresIdentifierSource(db,pepper)),deliveries:new PrivateDelivery(db,new PostgresIdentifierSource(db,pepper))});}});
 const env={KEYWORD_PEPPER:pepper,SUPABASE_SESSION_MAX_AGE_SECONDS:'0',SUPABASE_SESSION_INACTIVITY_SECONDS:'0',PUSH_CONSENT_VERSION:consent,PUSH_CONSENT_TEXT:'Synthetic reviewed text only'};
 const send=(body:unknown,bindings=env)=>app.request(`/v1/me/devices/${id}`,{method:'PUT',headers:{authorization:'Bearer b','content-type':'application/json'},body:JSON.stringify(body)},bindings);
 assert.equal((await send({token:'synthetic-test-token-123456',consentVersion:consent,revision:1},{...env,PUSH_CONSENT_TEXT:''})).status,503);
 assert.equal((await send({token:'synthetic-test-token-123456',consentVersion:'old',revision:1})).status,409);
 assert.equal((await send({token:'synthetic-test-token-123456',consentVersion:consent,revision:1,uid:c.external})).status,400);
 assert.equal((await send({token:'synthetic-test-token-123456',consentVersion:consent})).status,400);
 assert.equal((await send({token:'synthetic-test-token-123456',consentVersion:consent,revision:1})).status,200);
});
local('synthetic provider fixtures -> contact verification -> API keyword -> SOS -> durable private delivery -> acknowledgment -> terminal -> independent SOS',async()=>{
 const phone='+2519'+String(10000000+subjects.length),a=await actor(),b=await actor(phone),c=await actor();
 const identities=new Map([['synthetic-a',a],['synthetic-b',b],['synthetic-c',c]]);
 const env={KEYWORD_PEPPER:pepper,SUPABASE_SESSION_MAX_AGE_SECONDS:'0',SUPABASE_SESSION_INACTIVITY_SECONDS:'0',PUSH_CONSENT_VERSION:consent,PUSH_CONSENT_TEXT:'Synthetic consent for local testing only'};
 const app=createWorkersApp({tokenVerifier:()=>({verify:async token=>identities.get(token)!.subject}),
  withAuthDatabase:async(_env,run)=>run(createApiDatabase(runtime!)),withRepositories:async(_env,subject,run)=>{
    const db=createApiDatabase(runtime!,subject.uid),alerts=new PostgresAlertRepository(db,7200000),users=new PostgresUserRepository(db,new PostgresIdentifierSource(db,pepper)),inbox=new PostgresInboxRepository(db,new PostgresIdentifierSource(db,pepper)),
      acceptances=new PostgresAcceptanceRepository(db),contacts=new PostgresContactRepository(db,pepper);
    return run({alerts,inbox,acceptances,contactManagement:new PostgresContactManagementRepository(db),deliveries:new PrivateDelivery(db,new PostgresIdentifierSource(db,pepper)),writes:{alerts,users,inbox,acceptances,contacts,
      queue:new PostgresTaskQueue(db),keywordResets:new PostgresKeywordResetRepository(db),
      fanout:new AlertFanout(inbox,null,null,new ContactMatcher(contacts,users),createLogger('error'))}});
  }});
 const send=(who:string,path:string,method='GET',body?:unknown)=>app.request(path,{method,headers:{authorization:`Bearer synthetic-${who}`,'content-type':'application/json'},
  ...(body===undefined?{}:{body:JSON.stringify(body)})},env);
 assert.equal((await send('a','/v1/me/account')).status,200);
 assert.equal((await send('a','/v1/me/keyword','PUT',{keyword:'marigold',currentKeyword:'tangerine'})).status,200);
 assert.equal((await send('a',`/v1/me/contacts/${randomUUID()}`,'PUT',{name:'Synthetic B',phone,isPrimary:true})).status,201);
 assert.equal((await send('b',`/v1/me/devices/${randomUUID()}`,'PUT',{token:'synthetic-scenario-token-'+randomUUID(),consentVersion:consent,revision:1})).status,200);
 const body={requestId:randomUUID()},first=await send('a','/v1/alerts','POST',body);assert.equal(first.status,201);
 const incident=(await first.json() as any).alert;
 const replay=await send('a','/v1/alerts','POST',body);assert.equal(replay.status,200);assert.equal((await replay.json() as any).alert.key,incident.key);
 const queued: string[]=[];
 const taskEnv={...env,TASK_BATCH_SIZE:'8',TASK_CONCURRENCY:'2',TASK_LEASE_MS:'180000',TASK_DISPATCH_TIMEOUT_MS:'20000',TASK_QUERY_TIMEOUT_MS:'2000'};
 let intent:{delivery_id:string}|undefined;
 // Other integration cases deliberately leave recoverable queue work. A
 // bounded worker batch need not select this incident on its first pass.
 for(let pass=0;pass<20&&!intent;pass++){
   await runWorkerTasks(taskEnv,{withDatabase:async(_env,run)=>run(createApiDatabase(runtime!))});
   intent=(await pool!.query("SELECT delivery_id FROM outbox WHERE alert_id=$1 AND payload->>'kind'='incident'",[incident.id])).rows[0];
 }
 assert.ok(intent);
 const fake:PrivatePushProvider={send:async(_token,data)=>{queued.push(data.deliveryId);return {messageId:'synthetic-scenario-accepted'};}};
 const attempts=await dispatchPrivateDeliveries(createApiDatabase(runtime!),fake,options());assert.equal(attempts.accepted,1);assert.deepEqual(queued,[intent.delivery_id]);
 assert.equal((await send('c',`/v1/me/deliveries/${intent.delivery_id}/receipt`,'POST',{stage:'opened'})).status,404);
 assert.equal((await send('b',`/v1/me/deliveries/${intent.delivery_id}/receipt`,'POST',{stage:'received'})).status,200);
 assert.equal((await send('b',`/v1/me/deliveries/${intent.delivery_id}/receipt`,'POST',{stage:'opened'})).status,200);
 assert.equal((await send('b',`/v1/alerts/${incident.id}/accept`,'POST',{incidentKey:incident.key})).status,201);
 assert.equal((await (await send('a','/v1/me/alert')).json() as any).alert.acknowledgmentCount,1);
 assert.equal((await send('a',`/v1/alerts/${incident.id}/resolve`,'POST',{keyword:'marigold',incidentKey:incident.key})).status,200);
 assert.equal((await (await send('b','/v1/me/inbox')).json() as any).items.length,0);
 const closed=await send('b',`/v1/me/deliveries/${intent.delivery_id}/receipt`,'POST',{stage:'opened'});assert.equal((await closed.json() as any).active,false);
 await dispatchPrivateDeliveries(createApiDatabase(runtime!),fake,options());
 const next=await send('a','/v1/alerts','POST',{requestId:randomUUID()});assert.equal(next.status,201);
 const second=(await next.json() as any).alert;assert.notEqual(second.key,incident.key);
 await send('a',`/v1/alerts/${incident.id}/resolve`,'POST',{keyword:'marigold',incidentKey:incident.key});
 assert.equal((await (await send('a','/v1/me/alert')).json() as any).alert.key,second.key);
});

local('ordered registration and opt-out tombstones reject delayed network intents without duplicating unchanged generations',async()=>{
 const b=await actor(),id=randomUUID(),token='synthetic-ordered-token-'+randomUUID();
 const first=await b.delivery.register(id,b.subject.sessionId,token,consent,1);
 assert.equal(await b.delivery.register(id,b.subject.sessionId,token,consent,2),first);
 await assert.rejects(b.delivery.register(id,b.subject.sessionId,'synthetic-delayed-token-'+randomUUID(),consent,1));
 await b.delivery.disable(id,null,3,b.subject.sessionId);
 await assert.rejects(b.delivery.register(id,b.subject.sessionId,token,consent,2));
 const current=await b.delivery.register(id,b.subject.sessionId,token,consent,4);
 await b.delivery.disable(id,first,2,b.subject.sessionId);
 assert.deepEqual((await pool!.query('SELECT token,enabled,generation,intent_revision::int FROM push_devices WHERE id=$1',[id])).rows[0],{token,enabled:true,generation:current,intent_revision:4});
 const lost=randomUUID();await b.delivery.disable(lost,null,2,b.subject.sessionId);
 await assert.rejects(b.delivery.register(lost,b.subject.sessionId,'synthetic-lost-token-'+randomUUID(),consent,1));
 assert.equal((await pool!.query('SELECT enabled FROM push_devices WHERE id=$1',[lost])).rows[0].enabled,false);
});
local('confirmed logout releases the installation token; provider session cleanup retains delivery history and denies stale registration',async()=>{
 const f=await incident();await dispatchPrivateDeliveries(f.system,accepted,options());
 const row=(await pool!.query("SELECT id,delivery_id,provider_message_id FROM outbox WHERE alert_id=$1 AND payload->>'kind'='incident'",[f.alert.id])).rows[0];
 await new SupabaseSessionBridge(createApiDatabase(runtime!),policy).revoke(f.b.subject);
 await assert.rejects(f.b.delivery.register(f.device,f.b.subject.sessionId,f.token,consent,2));
 await f.c.delivery.register(randomUUID(),f.c.subject.sessionId,f.token,consent,1);
 await pool!.query('DELETE FROM auth.sessions WHERE id=$1',[f.b.subject.sessionId]);
 const device=(await pool!.query('SELECT enabled,token,provider_session_id FROM push_devices WHERE id=$1',[f.device])).rows[0];
 assert.deepEqual(device,{enabled:false,token:null,provider_session_id:null});
 const retained=(await pool!.query('SELECT delivery_id,provider_message_id FROM outbox WHERE id=$1',[row.id])).rows[0];
 assert.deepEqual(retained,{delivery_id:row.delivery_id,provider_message_id:row.provider_message_id});
 await assert.rejects(f.c.delivery.open(row.delivery_id,'opened'));
});
local('concurrent device revisions converge to the newest intent regardless of connection order',async()=>{
 const b=await actor(),id=randomUUID(),first='synthetic-concurrent-first-'+randomUUID(),last='synthetic-concurrent-last-'+randomUUID();
 await Promise.allSettled([b.delivery.register(id,b.subject.sessionId,first,consent,1),b.delivery.register(id,b.subject.sessionId,last,consent,2)]);
 assert.deepEqual((await pool!.query('SELECT token,intent_revision::int FROM push_devices WHERE id=$1',[id])).rows[0],{token:last,intent_revision:2});
 await Promise.allSettled([b.delivery.register(id,b.subject.sessionId,first,consent,3),b.delivery.disable(id,null,4,b.subject.sessionId)]);
 assert.deepEqual((await pool!.query('SELECT token,enabled,intent_revision::int FROM push_devices WHERE id=$1',[id])).rows[0],{token:null,enabled:false,intent_revision:4});
});
