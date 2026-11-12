import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownAlertState } from '../src/services/ownAlertState.js';
import { FakeAlertRepository, OWNER } from './fakes.js';

test('owner state counts only acknowledgments tied to the immutable incident', async () => {
  const alerts=new FakeAlertRepository(), alert=alerts.seed({id:OWNER,ownerId:OWNER,status:'active'});
  const result=await ownAlertState(alerts,{listForAlert:async()=>[
    {alertId:OWNER,alertKey:alert.key,responderUid:'synthetic-b',acceptedAt:new Date(),audience:'contact'},
    {alertId:OWNER,alertKey:'old-key',responderUid:'synthetic-old',acceptedAt:new Date(),audience:'contact'},
  ]},OWNER);
  assert.equal(result!.acknowledgmentCount,1);
  assert.equal(JSON.stringify(result).includes('synthetic-b'),false);
  assert.equal((await ownAlertState(alerts,undefined,OWNER))!.acknowledgmentCount,null);
});
test('slot replacement during acknowledgment lookup cannot attach an old count to a new incident',async()=>{
  const alerts=new FakeAlertRepository();const old=alerts.seed({id:OWNER,ownerId:OWNER,status:'active'});
  const result=await ownAlertState(alerts,{listForAlert:async()=>{
    alerts.store.set(OWNER,{...old,key:'new-key'});
    return [{alertId:OWNER,alertKey:old.key,responderUid:'synthetic-b',acceptedAt:new Date(),audience:'contact'}];
  }},OWNER);
  assert.equal(result!.key,'new-key');assert.equal(result!.acknowledgmentCount,null);
});
test('failed acknowledgment lookup is not fabricated as zero or delivered',async()=>{
  const alerts=new FakeAlertRepository();alerts.seed({id:OWNER,ownerId:OWNER,status:'active'});
  await assert.rejects(ownAlertState(alerts,{listForAlert:async()=>{throw Error('synthetic database outage');}},OWNER));
});
