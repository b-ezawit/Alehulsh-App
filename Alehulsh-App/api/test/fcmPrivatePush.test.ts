import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {jwtVerify,importSPKI} from 'jose';
import {FcmPrivatePushProvider} from '../src/notifications/FcmPrivatePushProvider.js';
const keys=generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
const config={projectId:'synthetic-project',clientEmail:'synthetic@synthetic-project.iam.gserviceaccount.com',privateKey:keys.privateKey};
const token='synthetic-device-token-private',data={deliveryId:'11111111-1111-4111-8111-111111111111'};
test('official Google Auth SDK signs the scoped assertion; FCM receives only a private token and opaque hint',async()=>{
 let authCalls=0,sends=0;
 const provider=new FcmPrivatePushProvider(config,async input=>{
   const request=input as Request;assert.equal(request.redirect,'manual');
   if(request.url==='https://oauth2.googleapis.com/token'){
     authCalls++;const form=new URLSearchParams(await request.text());
     assert.equal(form.get('grant_type'),'urn:ietf:params:oauth:grant-type:jwt-bearer');
     const verified=await jwtVerify(form.get('assertion')!,await importSPKI(keys.publicKey,'RS256'),{issuer:config.clientEmail,audience:'https://oauth2.googleapis.com/token'});
     assert.equal(verified.payload['scope'],'https://www.googleapis.com/auth/firebase.messaging');
     return Response.json({access_token:'synthetic-google-access',token_type:'Bearer',expires_in:3600});
   }
   sends++;assert.equal(request.url,'https://fcm.googleapis.com/v1/projects/synthetic-project/messages:send');
   assert.equal(request.headers.get('authorization'),'Bearer synthetic-google-access');
   assert.deepEqual(await request.json(),{message:{token,data,android:{priority:'high'}}});
   return Response.json({name:'projects/synthetic-project/messages/synthetic-id'});
 });
 assert.deepEqual(await provider.send(token,data,AbortSignal.timeout(1000)),{messageId:'projects/synthetic-project/messages/synthetic-id'});
 await provider.send(token,data,AbortSignal.timeout(1000));assert.equal(authCalls,1);assert.equal(sends,2);
});
test('only a confirmed UNREGISTERED response disables a token; project errors remain retryable and sanitized',async()=>{
 for(const invalid of [true,false]){
   const provider=new FcmPrivatePushProvider(config,async input=>(input as Request).url.includes('oauth2')?
    Response.json({access_token:'synthetic',expires_in:3600}):Response.json({error:{message:token,details:[{errorCode:invalid?'UNREGISTERED':'PERMISSION_DENIED'}]}},{status:invalid?404:403}));
   if(invalid)assert.deepEqual(await provider.send(token,data,AbortSignal.timeout(1000)),{invalidToken:true});
   else await assert.rejects(provider.send(token,data,AbortSignal.timeout(1000)),e=>String(e)==='Error: private push unavailable');
 }
});
test('OAuth and FCM redirects never forward credentials to another origin',async()=>{
 for(const oauth of [true,false]){
   let calls=0;const provider=new FcmPrivatePushProvider(config,async input=>{
     calls++;if(!oauth&&(input as Request).url.includes('oauth2'))return Response.json({access_token:'synthetic',expires_in:3600});
     return new Response(null,{status:307,headers:{location:'https://foreign.invalid'}});
   });
   await assert.rejects(provider.send(token,data,AbortSignal.timeout(1000)),/private push unavailable/);assert.equal(calls,oauth?1:2);
 }
});
test('dispatch abort also bounds service-account token acquisition before a message can be sent',async()=>{
 let sends=0;const provider=new FcmPrivatePushProvider(config,async input=>{
   const request=input as Request;if(!request.url.includes('oauth2'))sends++;
   return new Promise<Response>((_resolve,reject)=>{request.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});});
 });
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20);
 try{await assert.rejects(provider.send(token,data,controller.signal),/private push unavailable/);}finally{clearTimeout(timer);}
 assert.equal(sends,0);
});
