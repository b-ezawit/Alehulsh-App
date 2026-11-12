import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspectCloudflareOwnership,classifyDnsRecords,classifyDatabaseFailure,classifyJwksFailure} from '../scripts/hosted-inventory.mjs';
const dev='a'.repeat(32),prod='b'.repeat(32),config={CLOUDFLARE_ACCOUNT_ID:dev,CLOUDFLARE_API_TOKEN:'synthetic-token-sentinel'};
const origin='https://synthetic-api.owner-subdomain.workers.dev';
function provider(overrides={}){
 const calls=[];
 const fetcher=async(url,options)=>{
   calls.push({url,options});assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');assert.equal(new URL(url).origin,'https://api.cloudflare.com');
   if(overrides.redirect)return new Response(null,{status:302,headers:{location:'https://unrelated.invalid'}});
   if(overrides.denied)return Response.json({success:false,errors:[{code:9109,message:'synthetic-provider-secret'}]},{status:403});
   const path=new URL(url).pathname;
   let result;
   if(path.endsWith('/accounts'))return Response.json({success:true,result:[{id:dev},{id:prod}],result_info:{total_pages:1}});
   if(path===`/client/v4/accounts/${dev}/workers/subdomain`)return Response.json({success:false,errors:[{code:10007}]},{status:404});
   if(path===`/client/v4/accounts/${prod}/workers/subdomain`)result={subdomain:overrides.otherOwner?'unrelated':'owner-subdomain'};
   else if(path.endsWith('/subdomain'))result={enabled:true};
   else if(path.endsWith('/settings'))result={compatibility_date:'2024-01-01',bindings:[{name:'JWT_SECRET',type:'secret_text',text:'synthetic-secret-value'},{name:'ENVIRONMENT',type:'plain_text',text:'synthetic-private-value'},{name:'DB',type:'d1'},{name:'VOICE_NOTES',type:'r2_bucket',bucket_name:'synthetic-voice'}]};
   else if(path.endsWith('/deployments'))result={deployments:[{id:'synthetic-deployment',versions:[{version_id:'synthetic-version',percentage:100}]}]};
   else if(path.endsWith('/hyperdrive/configs'))result=[];
   else throw Error('unexpected endpoint');
   return Response.json({success:true,result});
 };
 return {calls,fetcher};
}
test('enumerates accessible accounts and locates an existing Worker outside the configured empty account',async()=>{
 const p=provider(),result=await inspectCloudflareOwnership(config,origin,p);
 assert.equal(result.ownership,'verified');assert.equal(result.ownerAccountId,prod);assert.equal(result.configuredAccountOwnsOrigin,false);
 assert.equal(result.route.enabled,true);assert.equal(result.settings.targetBindingsPresent,false);assert.equal(result.hyperdrive.count,0);assert.equal(result.deployments.versions[0].versions[0].id,'synthetic-version');
});
test('inaccessible accounts or unmatched subdomains remain unverifiable, never imply a new deployment is required',async()=>{
 for(const options of [{denied:true},{otherOwner:true}]){const result=await inspectCloudflareOwnership(config,origin,provider(options));assert.equal(result.ownership,'unverifiable');assert.equal(result.ownerAccountId,undefined);}
});
test('production owner pins detect a wrong account without rewriting development credentials',async()=>{
 const result=await inspectCloudflareOwnership(config,origin,{...provider(),expectedOwnerAccountId:dev,expectedWorkerName:'wrong-worker'});
 assert.equal(result.ownership,'verified');assert.equal(result.ownerMatchesExpected,false);assert.equal(config.CLOUDFLARE_ACCOUNT_ID,dev);
 assert.equal(result.workerMatchesExpected,false);
});
test('inventory returns binding names/types but no credentials, plain-text binding values or provider messages',async()=>{
 const result=JSON.stringify(await inspectCloudflareOwnership(config,origin,provider()));
 for(const sentinel of [config.CLOUDFLARE_API_TOKEN,'synthetic-secret-value','synthetic-private-value'])assert.ok(!result.includes(sentinel));
 const denied=JSON.stringify(await inspectCloudflareOwnership(config,origin,provider({denied:true})));assert.ok(!denied.includes('synthetic-provider-secret'));
});
test('redirects never forward the operator token and invalid origins fail before network',async()=>{
 const p=provider({redirect:true});const result=await inspectCloudflareOwnership(config,origin,p);assert.equal(result.ownership,'unverifiable');assert.equal(p.calls.length,1);
 for(const url of ['http://synthetic-api.owner.workers.dev','https://user:password@synthetic-api.owner.workers.dev','https://unrelated.invalid','https://synthetic-api.owner.workers.dev/private'])await assert.rejects(inspectCloudflareOwnership(config,url,{fetcher:()=>{throw Error('network forbidden');}}));
});
test('an IPv6-only direct endpoint is not misclassified as missing DNS',()=>{
 assert.equal(classifyDnsRecords({a:[],aaaa:['synthetic-v6']}),'ipv6_only');
 assert.equal(classifyDnsRecords({a:[],aaaa:[],publicRcode:3}),'nxdomain');
 assert.equal(classifyDnsRecords({a:[],aaaa:[]}),'unverifiable');
});
test('provider XX000 after verified TLS is not a client certificate failure or proof of a bad password',()=>{
 const result=classifyDatabaseFailure({code:'XX000',message:'synthetic-provider-secret'},{certificateAuthorized:true});
 assert.equal(result.cause,'provider_postgres_error_after_verified_tls');assert.equal(result.certificateAuthorized,true);assert.ok(!JSON.stringify(result).includes('synthetic-provider-secret'));
 assert.equal(classifyDatabaseFailure({code:'SELF_SIGNED_CERT_IN_CHAIN'}).cause,'client_certificate_verification');
 assert.equal(classifyDatabaseFailure({code:'28P01'}).cause,'database_authentication');
 for(const message of ['TenantOrUserNotFound','Tenant for user synthetic-user was not found','Tenant or user not found'])assert.equal(classifyDatabaseFailure({code:'XX000',message},{certificateAuthorized:true}).cause,'pooler_tenant_mapping');
});
test('JWKS DNS failure is distinguished from a transport timeout without returning provider text',()=>{
 assert.deepEqual(classifyJwksFailure({name:'TypeError',cause:{code:'ENOTFOUND',message:'synthetic-secret'}}),{cause:'dns',code:'ENOTFOUND'});
 assert.equal(classifyJwksFailure({name:'TimeoutError'}).cause,'timeout');
 assert.ok(!JSON.stringify(classifyJwksFailure({message:'synthetic-secret'})).includes('synthetic-secret'));
});
