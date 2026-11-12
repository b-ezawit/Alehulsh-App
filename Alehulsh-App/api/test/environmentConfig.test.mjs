import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,copyFile,stat,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseEnv} from 'node:util';
import {generateKeyPairSync} from 'node:crypto';
import {initializeEnvironments,validateMobile,validateBackend,checkEnvironment,runtimeBindings} from '../scripts/environment-config.mjs';
const source=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const mobile=(environment='prod')=>({ALEHULSH_DATA_ACCESS:'trusted_api',ALEHULSH_API_AUTH:'supabase',FIREBASE_ENV:environment,
  [`ALEHULSH_API_ORIGIN_${environment.toUpperCase()}`]:'https://synthetic-api.invalid',
  [`ALEHULSH_SUPABASE_URL_${environment.toUpperCase()}`]:'https://synthetic-auth.invalid',
  [`ALEHULSH_SUPABASE_PUBLISHABLE_KEY_${environment.toUpperCase()}`]:'sb_publishable_synthetic_only',
  [`ALEHULSH_EVIDENCE_ORIGIN_${environment.toUpperCase()}`]:'https://synthetic-storage.invalid'});
const backend=()=>({SUPABASE_AUTH_ISSUER:'https://synthetic-auth.invalid/auth/v1',SUPABASE_AUTH_AUDIENCE:'authenticated',KEYWORD_PEPPER:'synthetic-existing-authoritative-value',
 R2_ENDPOINT:'https://synthetic-storage.invalid',R2_BUCKET:'synthetic-bucket',R2_ACCESS_KEY_ID:'synthetic-id',R2_SECRET_ACCESS_KEY:'synthetic-secret',
 SUPABASE_SESSION_MAX_AGE_SECONDS:'3600',SUPABASE_SESSION_INACTIVITY_SECONDS:'1800',TASK_BATCH_SIZE:'2',TASK_CONCURRENCY:'1',
 TASK_LEASE_MS:'10000',TASK_DISPATCH_TIMEOUT_MS:'1000',TASK_QUERY_TIMEOUT_MS:'500',PUSH_DELIVERY_ENABLED:'false'});
async function fixture(t){
 const root=await mkdtemp(resolve(tmpdir(),'alehulsh-env-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
 for(const file of ['config/mobile.dev.example.json','config/mobile.prod.example.json','api/.dev.vars.example','api/.dev.vars.production.example']){
   await mkdir(dirname(resolve(root,file)),{recursive:true});await copyFile(resolve(source,file),resolve(root,file));
 }
 return root;
}
function envText(config){return Object.entries(config).map(([k,v])=>`${k}=${JSON.stringify(v)}`).join('\n')+'\n';}
test('mobile configuration accepts only the selected public trusted API inputs',()=>{
 assert.deepEqual(validateMobile(mobile(),'prod'),[]);
 assert.deepEqual(validateMobile(mobile('dev'),'dev'),[]);
 for(const key of ['FCM_PRIVATE_KEY','KEYWORD_PEPPER','DATABASE_URL','SUPABASE_DB_PASSWORD','BASE_URL']){
   const issues=validateMobile({...mobile(),[key]:'synthetic-secret-sentinel'},'prod');
   assert.ok(issues.some(i=>i.code==='unexpected_field'));assert.ok(!JSON.stringify(issues).includes('synthetic-secret-sentinel'));
 }
});
test('wrong environment, mixed origins and Firebase fallback cannot pass the production configuration gate',()=>{
 for(const config of [{...mobile(),FIREBASE_ENV:'dev'},{...mobile(),ALEHULSH_API_AUTH:'firebase'},{...mobile(),ALEHULSH_DATA_ACCESS:'firestore'},mobile('dev'),{...mobile(),ALEHULSH_API_ORIGIN_DEV:'https://synthetic-dev.invalid'}])assert.ok(validateMobile(config,'prod').length>0);
});
test('origins require HTTPS and refuse credentials, paths, queries and fragments',()=>{
 for(const url of ['http://localhost:8787','https://synthetic:sentinel@host.invalid','https://host.invalid/path','https://host.invalid?secret=sentinel','https://host.invalid/#sentinel']){
   const issues=validateMobile({...mobile(),ALEHULSH_API_ORIGIN_PROD:url},'prod');
   assert.ok(issues.some(i=>i.code==='https_origin_required'));assert.ok(!JSON.stringify(issues).includes('sentinel'));
 }
});
test('service-role and secret Auth keys cannot be embedded in mobile configuration',()=>{
 const jwt=role=>`synthetic.${Buffer.from(JSON.stringify({role})).toString('base64url')}.synthetic`;
 for(const key of ['sb_secret_synthetic',jwt('service_role'),'arbitrary-synthetic-token','sb_publishable_'])assert.ok(validateMobile({...mobile(),ALEHULSH_SUPABASE_PUBLISHABLE_KEY_PROD:key},'prod').some(i=>i.code==='public_auth_key_required'));
 assert.deepEqual(validateMobile({...mobile(),ALEHULSH_SUPABASE_PUBLISHABLE_KEY_PROD:jwt('anon')},'prod'),[]);
});
test('operator secrets and unsupported legacy token settings never become runtime bindings',()=>{
 const cfg={...backend(),SUPABASE_DB_PASSWORD:'synthetic-operator-sentinel',CLOUDFLARE_API_TOKEN:'synthetic-cloud-sentinel',JWT_SECRET:'synthetic-unused-sentinel',ALLOW_INSECURE_TOKENS:'true'};
 const bindings=runtimeBindings(cfg);for(const k of ['SUPABASE_DB_PASSWORD','CLOUDFLARE_API_TOKEN','JWT_SECRET','ALLOW_INSECURE_TOKENS'])assert.equal(bindings[k],undefined);
 const issues=validateBackend(cfg,'prod');assert.ok(issues.some(i=>i.code==='operator_credential_in_runtime_file'));assert.ok(issues.some(i=>i.code==='unsupported_legacy_setting'));
 assert.ok(!JSON.stringify(issues).includes('sentinel'));
});
test('session limits and task bounds must be explicit; disabled delivery blocks production completeness',()=>{
 assert.deepEqual(validateBackend(backend(),'dev'),[]);
 assert.ok(validateBackend(backend(),'prod').some(i=>i.code==='emergency_delivery_disabled'));
 for(const [key,value]of [['SUPABASE_SESSION_MAX_AGE_SECONDS',''],['TASK_CONCURRENCY','3'],['TASK_BATCH_SIZE','101'],['TASK_LEASE_MS','1000'],['PUSH_DELIVERY_ENABLED','yes']])assert.ok(validateBackend({...backend(),[key]:value},'dev').length>0);
 assert.ok(validateBackend({...backend(),TASK_BATCH_SIZE:'10',TASK_LEASE_MS:'5000'},'dev').some(i=>i.code==='insufficient_task_batch_budget'));
 assert.ok(validateBackend({...backend(),SUPABASE_SESSION_MAX_AGE_SECONDS:'2147483648'},'dev').some(i=>i.code==='postgres_integer_range'));
});
test('enabled delivery requires reviewed consent, explicit credentials and sufficient lease budget',()=>{
 const cfg={...backend(),PUSH_DELIVERY_ENABLED:'true'};
 for(const key of ['PUSH_CONSENT_VERSION','PUSH_CONSENT_TEXT','FCM_PROJECT_ID','FCM_CLIENT_EMAIL','FCM_PRIVATE_KEY'])assert.ok(validateBackend(cfg,'prod').some(i=>i.configuration===key));
 const privateKey=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}}).privateKey;
 const complete={...cfg,PUSH_CONSENT_VERSION:'synthetic-review',PUSH_CONSENT_TEXT:'Synthetic fixture consent only',FCM_PROJECT_ID:'synthetic-project',FCM_CLIENT_EMAIL:'synthetic@synthetic-project.iam.gserviceaccount.com',FCM_PRIVATE_KEY:privateKey};
 assert.deepEqual(validateBackend(complete,'prod'),[]);
 assert.ok(validateBackend({...complete,TASK_LEASE_MS:'2000'},'prod').some(i=>i.code==='insufficient_private_delivery_budget'));
 assert.ok(!JSON.stringify(validateBackend({...complete,FCM_PRIVATE_KEY:'synthetic-private-key-sentinel'},'prod')).includes('synthetic-private-key-sentinel'));
});
test('initialization preserves every existing value and comment, fills missing slots, and creates private files only',async t=>{
 const root=await fixture(t),old='# Preserve these exact comments\nKEYWORD_PEPPER=synthetic-authoritative\nSUPABASE_DB_PASSWORD=synthetic-operator\n';
 await writeFile(resolve(root,'api/.dev.vars'),old,{mode:0o600});
 const result=await initializeEnvironments(root,{productionApiOrigin:'https://supplied-production.invalid/',fcmProjectId:'synthetic-project',fcmClientEmail:'synthetic@synthetic-project.iam.gserviceaccount.com'});
 const current=await readFile(resolve(root,'api/.dev.vars'),'utf8');assert.ok(current.startsWith(old));assert.equal(parseEnv(current).KEYWORD_PEPPER,'synthetic-authoritative');
 assert.equal(JSON.parse(await readFile(resolve(root,'config/mobile.prod.json'),'utf8')).ALEHULSH_API_ORIGIN_PROD,'https://supplied-production.invalid');
 assert.equal(JSON.parse(await readFile(resolve(root,'config/mobile.dev.json'),'utf8')).ALEHULSH_API_ORIGIN_DEV,'');
 const prod=parseEnv(await readFile(resolve(root,'api/.dev.vars.production'),'utf8'));assert.equal(prod.KEYWORD_PEPPER,'');assert.equal(prod.SUPABASE_DB_PASSWORD,undefined);assert.equal(prod.FCM_PRIVATE_KEY,'');assert.equal(prod.PUSH_DELIVERY_ENABLED,'false');
 for(const file of [...result.created,...result.extended])assert.equal((await stat(resolve(root,file))).mode&0o777,0o600);
 const second=await initializeEnvironments(root,{productionApiOrigin:'https://other.invalid'});assert.equal(second.created.length,0);assert.equal(second.extended.length,0);
 assert.equal(await readFile(resolve(root,'api/.dev.vars'),'utf8'),current);
});
test('initialization rejects symlinks and invalid public metadata without changing external files',async t=>{
 const root=await fixture(t),outside=resolve(root,'outside');await writeFile(outside,'synthetic-preserved');
 await symlink(outside,resolve(root,'config/mobile.dev.json'));
 await assert.rejects(initializeEnvironments(root));assert.equal(await readFile(outside,'utf8'),'synthetic-preserved');
 await assert.rejects(initializeEnvironments(root,{fcmProjectId:'synthetic\nFCM_PRIVATE_KEY=bad'}));
});
test('offline checks report configuration names only and never certify production readiness',async t=>{
 const root=await fixture(t);await initializeEnvironments(root);
 const oldFetch=globalThis.fetch;globalThis.fetch=()=>{throw Error('external network must not be used');};t.after(()=>{globalThis.fetch=oldFetch;});
 await writeFile(resolve(root,'config/mobile.dev.json'),JSON.stringify(mobile('dev')),{mode:0o600});
 await writeFile(resolve(root,'api/.dev.vars'),envText(backend()),{mode:0o600});
 const result=await checkEnvironment(root,'dev');assert.equal(result.configurationComplete,true);assert.equal(result.productionReadiness,'not_verified');assert.equal(result.externalChecksPerformed,false);
 assert.ok(!JSON.stringify(result).includes('synthetic-existing-authoritative-value'));
 await writeFile(resolve(root,'api/.dev.vars'),envText({...backend(),SUPABASE_AUTH_ISSUER:'https://other.invalid/auth/v1'}));
 assert.ok((await checkEnvironment(root,'dev')).issues.some(i=>i.code==='mobile_backend_mismatch'));
});
test('malformed JSON, missing files and permissive permissions fail without leaking their contents',async t=>{
 const root=await fixture(t);await initializeEnvironments(root);
 await writeFile(resolve(root,'config/mobile.prod.json'),'invalid-synthetic-secret-sentinel',{mode:0o600});
 await rm(resolve(root,'api/.dev.vars.production'));
 let result=await checkEnvironment(root,'prod');assert.equal(result.configurationComplete,false);assert.ok(!JSON.stringify(result).includes('synthetic-secret-sentinel'));
 await writeFile(resolve(root,'api/.dev.vars.production'),envText(backend()),{mode:0o644});
 result=await checkEnvironment(root,'prod');assert.ok(result.issues.some(i=>i.code==='private_file_permissions_required'));
});
test('development cannot silently reuse the configured production API or Auth origin',async t=>{
 const root=await fixture(t);await initializeEnvironments(root);
 await writeFile(resolve(root,'config/mobile.dev.json'),JSON.stringify(mobile('dev')));
 await writeFile(resolve(root,'config/mobile.prod.json'),JSON.stringify(mobile('prod')));
 const result=await checkEnvironment(root,'dev');
 for(const name of ['ALEHULSH_API_ORIGIN','ALEHULSH_SUPABASE_URL'])assert.ok(result.issues.some(i=>i.configuration===name&&i.code==='reused_across_environments'));
});
test('Wrangler actually selects the correct env file and excludes operator credentials from both runtime environments',async t=>{
 const root=await fixture(t),path=resolve(root,'api/wrangler.local.jsonc');
 const manifest=JSON.parse(await readFile(resolve(source,'api/wrangler.local.jsonc'),'utf8'));
 const expected=Object.keys(runtimeBindings(Object.fromEntries([...Object.keys(backend()),'PUSH_CONSENT_VERSION','PUSH_CONSENT_TEXT','FCM_PROJECT_ID','FCM_CLIENT_EMAIL','FCM_PRIVATE_KEY'].map(k=>[k,'synthetic'])))).sort();
 for(const cfg of [manifest,manifest.env.production]){
   assert.deepEqual([...cfg.secrets.required,...Object.keys(cfg.vars)].sort(),expected);
   assert.equal(cfg.workers_dev,false);assert.equal(cfg.triggers,undefined);assert.equal(cfg.hyperdrive,undefined);assert.equal(cfg.r2_buckets,undefined);
 }
 manifest.main=resolve(source,'api/src/workers/index.ts');await writeFile(path,JSON.stringify(manifest));
 const operator={SUPABASE_DB_PASSWORD:'synthetic-operator-secret',CLOUDFLARE_API_TOKEN:'synthetic-operator-token',JWT_SECRET:'synthetic-unused',CLOUDFLARE_ACCOUNT_ID:'synthetic-operator-account',CLOUDFLARE_WORKER_NAME:'synthetic-production-worker'};
 await writeFile(resolve(root,'api/.dev.vars'),envText({...backend(),...operator,KEYWORD_PEPPER:'synthetic-development-pepper'}));
 await writeFile(resolve(root,'api/.dev.vars.production'),envText({...backend(),...operator,KEYWORD_PEPPER:'synthetic-production-pepper'}));
 const {getPlatformProxy}=await import('wrangler');
 for(const environment of [undefined,'production']){
   const proxy=await getPlatformProxy({configPath:path,environment,persist:false});
   try{
     assert.equal(proxy.env.KEYWORD_PEPPER,environment?'synthetic-production-pepper':'synthetic-development-pepper');
     assert.equal(proxy.env.PUSH_DELIVERY_ENABLED,'false');
     for(const key of Object.keys(operator))assert.equal(proxy.env[key],undefined);
   }finally{await proxy.dispose();}
 }
});
