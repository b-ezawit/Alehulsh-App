import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspectDatabase,preflight} from '../scripts/preflight-development.mjs';
function fixture(fail) {
 const calls=[];let ended=false;
 const client={connection:{stream:{encrypted:true,authorized:true}},async connect(){calls.push('CONNECT');if(fail==='connect')throw Error('synthetic');},
  async end(){ended=true;},async query(sql){calls.push(sql);if(fail==='query'&&sql.includes('pg_class'))throw Error('synthetic');
   if(sql.includes("AS version"))return{rows:[{ledger:false}]};
   if(sql.includes('FROM pg_roles WHERE rolname IN'))return{rows:[{name:'alehulsh_api'}]};
   if(sql.includes('AS restricted_role'))return{rows:[{restricted_role:true,local_identity:true}]};
   return{rows:[]};}};
 return{client,calls,get ended(){return ended;}};
}
test('development inventory permits only metadata reads and transaction-local probes',async()=>{
 const f=fixture();const result=await inspectDatabase(f.client);assert.equal(result.connected,true);assert.deepEqual(result.clientTls,{encrypted:true,certificateAuthorized:true});assert.equal(result.roleContext.local_identity,true);
 for(const sql of f.calls.filter(s=>s!=='CONNECT'))assert.match(sql,/^(BEGIN TRANSACTION READ ONLY|SET LOCAL|SELECT|SAVEPOINT|ROLLBACK)/);
 assert.equal(f.calls.some(s=>/\b(CREATE|INSERT|UPDATE|DELETE|TRUNCATE|COMMIT)\b/.test(s)),false);
 assert.equal(f.calls.at(-1),'ROLLBACK');assert.equal(f.ended,true);
});
test('failed metadata read rolls back and closes without a write or commit',async()=>{
 const f=fixture('query');await assert.rejects(inspectDatabase(f.client));assert.equal(f.calls.at(-1),'ROLLBACK');assert.equal(f.ended,true);
});
test('failed connection is closed without issuing SQL',async()=>{
 const f=fixture('connect');await assert.rejects(inspectDatabase(f.client));assert.deepEqual(f.calls,['CONNECT']);assert.equal(f.ended,true);
});
test('missing configuration refuses before contacting a provider',async()=>{
 await assert.rejects(preflight({}),/missing SUPABASE_PROJECT_REF/);
});
test('mismatched direct host refuses before credentials can be sent',async()=>{
 await assert.rejects(preflight({SUPABASE_PROJECT_REF:'synthetic',SUPABASE_DB_HOST:'other.invalid',SUPABASE_DB_PORT:'5432',SUPABASE_DB_NAME:'db',SUPABASE_DB_USER:'user',SUPABASE_DB_PASSWORD:'synthetic'}),/does not match/);
});
