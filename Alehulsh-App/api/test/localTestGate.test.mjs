import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertLocalFixtures, unexpectedSkips,isolatedTestEnvironment } from '../scripts/run-local-tests.mjs';
const local={ALEHULSH_LOCAL_DB_TESTS:'1',PGHOST:'127.0.0.1',FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080'};
test('integration gate refuses hosted or missing fixture configuration',()=>{
  assert.doesNotThrow(()=>assertLocalFixtures(local));
  for(const env of [{},{...local,PGHOST:'synthetic.remote.invalid'},{...local,FIRESTORE_EMULATOR_HOST:'remote.invalid:8080'}]) assert.throws(()=>assertLocalFixtures(env));
});
test('mandatory PostgreSQL, Firestore and workerd suites cannot silently skip',()=>{
  for(const name of ['databaseIdentity.integration.test.js','firestoreAlertWork.integration.test.js','workersRuntime.integration.test.js']) assert.equal(unexpectedSkips(name,1),true);
  assert.equal(unexpectedSkips('r2EvidenceStore.integration.test.js',16),false);
  assert.equal(unexpectedSkips('r2EvidenceStore.integration.test.js',17),true);
});
test('local test children cannot inherit real messaging activation, provider credentials or cloud integration flags',()=>{
 const isolated=isolatedTestEnvironment({...local,FCM_PRIVATE_KEY:'synthetic',PUSH_DELIVERY_ENABLED:'true',PUSH_CONSENT_VERSION:'synthetic',KEYWORD_PEPPER:'synthetic',SUPABASE_DB_PASSWORD:'synthetic',ALEHULSH_SUPABASE_INTEGRATION:'1'});
 for(const key of ['FCM_PRIVATE_KEY','PUSH_DELIVERY_ENABLED','PUSH_CONSENT_VERSION','KEYWORD_PEPPER','SUPABASE_DB_PASSWORD','ALEHULSH_SUPABASE_INTEGRATION'])assert.equal(Object.hasOwn(isolated,key),false);
 assert.equal(isolated.PGHOST,'127.0.0.1');assert.equal(isolated.ALEHULSH_WORKER_RUNTIME_TESTS,'1');
});
