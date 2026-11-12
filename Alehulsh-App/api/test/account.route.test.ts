import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.js';
import { makeDeps,authAs,OWNER,STRANGER } from './fakes.js';
const profile={fullName:'Synthetic',homeAddress:'',phoneNumber:null,safetyKeywordSet:true,mustSetKeyword:false,
  phoneVerified:false,emailVerified:true,locationSharingEnabled:false,autoAudioRecording:false,fakeCallEnabled:false,communityAlertsEnabled:false};
test('owned profile/contact routes are protected, scoped and unavailable without their adapter',async()=>{
  const absent=buildServer(makeDeps());
  assert.equal((await absent.inject({method:'GET',url:'/v1/me/profile'})).statusCode,401);
  assert.equal((await absent.inject({method:'GET',url:'/v1/me/profile',headers:authAs(OWNER)})).statusCode,503);
  const calls:string[]=[];
  const app=buildServer(makeDeps({profiles:{get:async uid=>{calls.push(uid);return profile;},update:async(uid)=>{calls.push(uid);return profile;}},
    contactManagement:{list:async uid=>{calls.push(uid);return[];},put:async uid=>{calls.push(uid);return true;},remove:async uid=>{calls.push(uid);}}}));
  assert.equal((await app.inject({method:'GET',url:'/v1/me/profile',headers:authAs(STRANGER)})).statusCode,200);
  assert.deepEqual(calls,[STRANGER]);
  assert.equal((await app.inject({method:'GET',url:'/v1/me/profile?uid=spoofed',headers:authAs(OWNER)})).statusCode,400);
  for(const forbidden of ['catName','keywordHash','safetyKeywordHash','uid','phoneVerified','bloodType','medicalNotes']) {
    assert.equal((await app.inject({method:'PATCH',url:'/v1/me/profile',headers:authAs(OWNER),payload:{[forbidden]:'spoof'}})).statusCode,400);
  }
});
