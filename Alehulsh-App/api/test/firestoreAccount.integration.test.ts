import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {initializeApp,deleteApp,type App} from 'firebase-admin/app';
import {getFirestore,type Firestore} from 'firebase-admin/firestore';
import {FirestoreAccountRepository} from '../src/repositories/firestore/FirestoreAccountRepository.js';
import {FirestoreUserRepository} from '../src/repositories/firestore/FirestoreUserRepository.js';
import {buildServer} from '../src/server.js';
import {makeDeps,authAs,OWNER,STRANGER} from './fakes.js';
let db:Firestore|undefined,app:App|undefined,repo:FirestoreAccountRepository;
before(async()=>{
 const host=process.env['FIRESTORE_EMULATOR_HOST'];if(!host)return;assert.match(host,/^127\.0\.0\.1:\d+$/);
 app=initializeApp({projectId:`demo-account-${randomUUID().slice(0,8)}`},randomUUID());db=getFirestore(app);
 repo=new FirestoreAccountRepository(db,{getUser:async()=>({disabled:false,emailVerified:true,phoneNumber:'+251911234567'})});
 await db.collection('users').doc(OWNER).set({uid:OWNER,fullName:'Synthetic Owner',catName:'sensitive-legacy-word',safetyKeywordHash:'sensitive-hash',
  medicalNotes:'sensitive-retired',bloodType:'A+',phoneNumber:'+251911234567',phoneHash:'synthetic-proof',phoneVerified:true,
  isLocationSharingEnabled:true,locationSharingConsentVersion:1,emergencyContacts:[]});
 await db.collection('users').doc(STRANGER).set({uid:STRANGER,fullName:'Synthetic Other'});
});
after(async()=>{if(db){for(const doc of await db.collection('users').listDocuments())await doc.delete();await db.terminate();}if(app)await deleteApp(app);});
function local(name:string,run:()=>Promise<void>){test(name,async t=>{if(!db){t.skip('loopback emulator required');return;}await run();});}
local('transitional API returns no keyword, health or verification-hash material',async()=>{
 const app=buildServer(makeDeps({profiles:repo,contactManagement:repo}));
 const result=await app.inject({method:'GET',url:'/v1/me/profile',headers:authAs(OWNER)});assert.equal(result.statusCode,200);
 for(const marker of ['sensitive-legacy-word','sensitive-hash','sensitive-retired','phoneHash'])assert.equal(result.body.includes(marker),false);
 assert.equal(result.json().profile.phoneVerified,true);
 const other=await app.inject({method:'GET',url:'/v1/me/profile',headers:authAs(STRANGER)});assert.equal(other.json().profile.fullName,'Synthetic Other');
});
local('profile updates preserve protected fields, opt out explicitly and revoke edited phone proof',async()=>{
 await repo.update(OWNER,{fullName:'Updated',locationSharingEnabled:false,phoneNumber:'+251922234567'});
 const raw=(await db!.collection('users').doc(OWNER).get()).data()!;
 assert.equal(raw['safetyKeywordHash'],'sensitive-hash');assert.equal(raw['catName'],'sensitive-legacy-word');
 assert.equal(raw['locationSharingConsentVersion'],0);assert.equal(raw['phoneHash'],undefined);
 assert.equal((await repo.get(OWNER))!.phoneVerified,false);
 await assert.rejects(repo.update(OWNER,{safetyKeywordHash:'spoof'}as any));
});
local('concurrent contact changes retain both contacts and exactly one primary',async()=>{
 const ids=[randomUUID(),randomUUID()];
 await Promise.all(ids.map((id,i)=>repo.put(OWNER,id,{name:'Synthetic Contact',phone:`+25193333333${i}`,email:'',relationship:'Friend',isPrimary:true})));
 const rows=await repo.list(OWNER);assert.equal(rows.length,2);assert.equal(rows.filter(c=>c.isPrimary).length,1);
 assert.deepEqual(await repo.list(STRANGER),[]);
 await repo.remove(STRANGER,ids[0]!);assert.equal((await repo.list(OWNER)).length,2);
});
local('legacy phone formatting cannot bypass duplicate contact checks',async()=>{
 await db!.collection('users').doc(STRANGER).update({emergencyContacts:[{id:randomUUID(),name:'Synthetic',phone:'0911234567',email:'',relationship:'',isPrimary:true}]});
 await assert.rejects(repo.put(STRANGER,randomUUID(),{name:'Duplicate',phone:'+251911234567',email:'',relationship:'',isPrimary:false}));
});
local('legacy plaintext keyword cannot be treated as unset and replaced through the trusted API',async()=>{
 await db!.collection('users').doc(STRANGER).set({uid:STRANGER,catName:'synthetic-legacy-secret',mustSetKeyword:false});
 const users=new FirestoreUserRepository(db!);
 const app=buildServer(makeDeps({users}));
 const response=await app.inject({method:'PUT',url:'/v1/me/keyword',headers:authAs(STRANGER),payload:{keyword:'synthetic-replacement'}});
 assert.equal(response.statusCode,409);assert.equal(response.body.includes('synthetic-legacy-secret'),false);
 const row=(await db!.collection('users').doc(STRANGER).get()).data()!;
 assert.equal(row['catName'],'synthetic-legacy-secret');assert.equal(row['safetyKeywordHash'],undefined);
 await assert.rejects(users.compareAndSetSafetyKeyword(STRANGER,null,'synthetic-hash'));
});
