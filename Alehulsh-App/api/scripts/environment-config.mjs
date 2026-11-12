import {readFile,writeFile,appendFile,mkdir,lstat,chmod} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseEnv} from 'node:util';
import {createPrivateKey} from 'node:crypto';

const appRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const runtimeKeys=[
  'SUPABASE_AUTH_ISSUER','SUPABASE_AUTH_AUDIENCE','KEYWORD_PEPPER',
  'R2_ENDPOINT','R2_BUCKET','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY',
  'SUPABASE_SESSION_MAX_AGE_SECONDS','SUPABASE_SESSION_INACTIVITY_SECONDS',
  'TASK_BATCH_SIZE','TASK_CONCURRENCY','TASK_LEASE_MS','TASK_DISPATCH_TIMEOUT_MS','TASK_QUERY_TIMEOUT_MS',
  'PUSH_DELIVERY_ENABLED','PUSH_CONSENT_VERSION','PUSH_CONSENT_TEXT','FCM_PROJECT_ID','FCM_CLIENT_EMAIL','FCM_PRIVATE_KEY',
];
const environments=new Set(['dev','prod']);
const configured=value=>typeof value==='string'&&value.trim().length>0&&!/^(?:<.*>|replace.*|your[_ -].*|changeme)$/i.test(value.trim());
function origin(value){
  try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&['','/'].includes(u.pathname)?u.origin:null;}
  catch{return null;}
}
function publicAuthKey(value){
  if(!configured(value)||value.startsWith('sb_secret_'))return false;
  if(value.startsWith('sb_publishable_'))return value.length>'sb_publishable_'.length;
  try{return value.split('.').length===3&&JSON.parse(Buffer.from(value.split('.')[1],'base64url').toString()).role==='anon';}
  catch{return false;}
}
function issue(issues,configuration,code){issues.push({configuration,code});}
/** Only selected runtime fields may be forwarded to a local Worker adapter.
 * Operator database/Cloudflare credentials never become request bindings. */
export function runtimeBindings(config){return Object.fromEntries(runtimeKeys.filter(k=>Object.hasOwn(config,k)).map(k=>[k,config[k]]));}
export function validateMobile(config,environment){
  if(!environments.has(environment))throw Error('invalid environment');
  const issues=[],suffix=environment.toUpperCase();
  if(!config||typeof config!=='object'||Array.isArray(config))return [{configuration:'mobile',code:'invalid_object'}];
  const required={ALEHULSH_DATA_ACCESS:'trusted_api',ALEHULSH_API_AUTH:'supabase',FIREBASE_ENV:environment};
  const allowed=new Set([...Object.keys(required),...['ALEHULSH_API_ORIGIN','ALEHULSH_SUPABASE_URL','ALEHULSH_SUPABASE_PUBLISHABLE_KEY','ALEHULSH_EVIDENCE_ORIGIN'].map(k=>`${k}_${suffix}`)]);
  for(const k of Object.keys(config))if(!allowed.has(k))issue(issues,'mobile','unexpected_field');
  for(const [k,value]of Object.entries(required))if(config[k]!==value)issue(issues,k,'incorrect_selection');
  for(const k of ['ALEHULSH_API_ORIGIN','ALEHULSH_SUPABASE_URL','ALEHULSH_EVIDENCE_ORIGIN']){
    const name=`${k}_${suffix}`;
    if(!configured(config[name]))issue(issues,name,'missing');else if(!origin(config[name]))issue(issues,name,'https_origin_required');
  }
  const key=`ALEHULSH_SUPABASE_PUBLISHABLE_KEY_${suffix}`;
  if(!publicAuthKey(config[key]))issue(issues,key,'public_auth_key_required');
  return issues;
}
export function validateBackend(config,environment){
  if(!environments.has(environment))throw Error('invalid environment');
  const issues=[];
  for(const k of ['SUPABASE_AUTH_ISSUER','SUPABASE_AUTH_AUDIENCE','KEYWORD_PEPPER','R2_ENDPOINT','R2_BUCKET','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY'])if(!configured(config[k]))issue(issues,k,'missing');
  if(configured(config.SUPABASE_AUTH_ISSUER)){
    try{const u=new URL(config.SUPABASE_AUTH_ISSUER);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/auth/v1')throw Error();}
    catch{issue(issues,'SUPABASE_AUTH_ISSUER','https_auth_issuer_required');}
  }
  if(configured(config.R2_ENDPOINT)&&!origin(config.R2_ENDPOINT))issue(issues,'R2_ENDPOINT','https_origin_required');
  for(const k of ['SUPABASE_SESSION_MAX_AGE_SECONDS','SUPABASE_SESSION_INACTIVITY_SECONDS','TASK_BATCH_SIZE','TASK_CONCURRENCY','TASK_LEASE_MS','TASK_DISPATCH_TIMEOUT_MS','TASK_QUERY_TIMEOUT_MS']){
    const n=Number(config[k]),minimum=k.startsWith('SUPABASE_SESSION_')?0:1;
    if(!/^\d+$/.test(config[k]??'')||!Number.isSafeInteger(n)||n<minimum)issue(issues,k,'explicit_integer_required');
    if(k.startsWith('SUPABASE_SESSION_')&&Number.isSafeInteger(n)&&n>2147483647)issue(issues,k,'postgres_integer_range');
  }
  const batch=Number(config.TASK_BATCH_SIZE),concurrency=Number(config.TASK_CONCURRENCY),lease=Number(config.TASK_LEASE_MS),dispatch=Number(config.TASK_DISPATCH_TIMEOUT_MS),query=Number(config.TASK_QUERY_TIMEOUT_MS);
  if(Number.isFinite(batch)&&batch>100)issue(issues,'TASK_BATCH_SIZE','maximum_100');
  if(Number.isFinite(concurrency)&&Number.isFinite(batch)&&concurrency>batch)issue(issues,'TASK_CONCURRENCY','exceeds_batch');
  if(lease>0&&lease<1000)issue(issues,'TASK_LEASE_MS','minimum_1000');
  if(lease>0&&dispatch>0&&query>0&&lease<=dispatch+query)issue(issues,'TASK_LEASE_MS','insufficient_lease_budget');
  if(batch>0&&concurrency>0&&dispatch>0&&lease>0){
    const budget=Math.ceil(batch/concurrency)*dispatch,actualLease=Math.round(lease/1000)*1000;
    if(!Number.isSafeInteger(budget)||!Number.isSafeInteger(actualLease)||actualLease<=budget)issue(issues,'TASK_LEASE_MS','insufficient_task_batch_budget');
  }
  if(!['true','false'].includes(config.PUSH_DELIVERY_ENABLED))issue(issues,'PUSH_DELIVERY_ENABLED','explicit_boolean_required');
  if(environment==='prod'&&config.PUSH_DELIVERY_ENABLED==='false')issue(issues,'PUSH_DELIVERY_ENABLED','emergency_delivery_disabled');
  if(config.PUSH_DELIVERY_ENABLED==='true'){
    for(const k of ['PUSH_CONSENT_VERSION','PUSH_CONSENT_TEXT','FCM_PROJECT_ID','FCM_CLIENT_EMAIL','FCM_PRIVATE_KEY'])if(!configured(config[k]))issue(issues,k,'missing');
    if(configured(config.FCM_PROJECT_ID)&&!/^[a-z][a-z0-9-]{4,62}$/.test(config.FCM_PROJECT_ID))issue(issues,'FCM_PROJECT_ID','invalid_project');
    if(configured(config.FCM_CLIENT_EMAIL)&&!/^[a-zA-Z0-9._-]+@[a-zA-Z0-9-]+\.iam\.gserviceaccount\.com$/.test(config.FCM_CLIENT_EMAIL))issue(issues,'FCM_CLIENT_EMAIL','invalid_service_account');
    if(configured(config.FCM_PRIVATE_KEY)){
      try{if(createPrivateKey(config.FCM_PRIVATE_KEY).asymmetricKeyType!=='rsa')throw Error();}
      catch{issue(issues,'FCM_PRIVATE_KEY','invalid_rsa_key');}
    }
    if(lease>0&&batch>0&&dispatch>0&&lease<=batch*dispatch)issue(issues,'TASK_LEASE_MS','insufficient_private_delivery_budget');
  }
  for(const k of ['JWT_SECRET','ALLOW_INSECURE_TOKENS','FIREBASE_SERVICE_ACCOUNT_JSON','RESEND_API_KEY'])if(configured(config[k]))issue(issues,k,'unsupported_legacy_setting');
  if(environment==='prod')for(const k of ['SUPABASE_DB_PASSWORD','CLOUDFLARE_API_TOKEN','DATABASE_URL','PGPASSWORD'])if(configured(config[k]))issue(issues,k,'operator_credential_in_runtime_file');
  return issues;
}
async function existsFile(path){try{const st=await lstat(path);if(!st.isFile()||st.isSymbolicLink())throw Error('regular file required');return st;}catch(e){if(e.code==='ENOENT')return null;throw e;}}
/** Existing values and comments are preserved byte-for-byte. No secret is
 * generated, copied from the process environment, or accepted as a CLI flag. */
export async function initializeEnvironments(root=appRoot,publicValues={}){
  if(publicValues.productionApiOrigin&&!origin(publicValues.productionApiOrigin))throw Error('valid production origin required');
  for(const value of [publicValues.fcmProjectId,publicValues.fcmClientEmail])if(value&&!/^[a-zA-Z0-9@._-]+$/.test(value))throw Error('invalid public metadata');
  const result={created:[],preserved:[],extended:[]};
  for(const env of environments){
    const name=`config/mobile.${env}.json`,path=resolve(root,name),template=resolve(root,`config/mobile.${env}.example.json`);
    await mkdir(dirname(path),{recursive:true});
    if(await existsFile(path)){await chmod(path,0o600);result.preserved.push(name);}
    else{
      const config=JSON.parse(await readFile(template,'utf8'));
      if(env==='prod'&&publicValues.productionApiOrigin){
        if(!origin(publicValues.productionApiOrigin))throw Error('valid production origin required');
        config.ALEHULSH_API_ORIGIN_PROD=origin(publicValues.productionApiOrigin);
      }
      await writeFile(path,JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600});result.created.push(name);
    }
    const backendName=env==='dev'?'api/.dev.vars':'api/.dev.vars.production',backend=resolve(root,backendName);
    let text=await readFile(resolve(root,env==='dev'?'api/.dev.vars.example':'api/.dev.vars.production.example'),'utf8');
    if(env==='prod')for(const [key,value]of [['FCM_PROJECT_ID',publicValues.fcmProjectId],['FCM_CLIENT_EMAIL',publicValues.fcmClientEmail]]){
      if(value){if(!/^[a-zA-Z0-9@._-]+$/.test(value))throw Error('invalid public metadata');text=text.replace(new RegExp('^'+key+'=$','m'),key+'='+value);}
    }
    if(await existsFile(backend)){
      const old=await readFile(backend,'utf8'),present=parseEnv(old),defaults=parseEnv(text);
      const additions=Object.entries(defaults).filter(([k])=>!Object.hasOwn(present,k));
      await chmod(backend,0o600);
      if(additions.length){await appendFile(backend,'\n# Runtime configuration: missing entries only; existing values preserved.\n'+additions.map(([k,v])=>`${k}=${v}`).join('\n')+'\n');result.extended.push(backendName);}
      else result.preserved.push(backendName);
    }else{await writeFile(backend,text,{flag:'wx',mode:0o600});result.created.push(backendName);}
  }
  return result;
}
export async function checkEnvironment(root=appRoot,environment='dev'){
  if(!environments.has(environment))throw Error('invalid environment');
  const issues=[];let mobile,backend;
  const files={mobile:`config/mobile.${environment}.json`,backend:environment==='dev'?'api/.dev.vars':'api/.dev.vars.production'};
  for(const kind of ['mobile','backend']){
    const path=resolve(root,files[kind]);
    try{
      const st=await existsFile(path);if(!st){issue(issues,files[kind],'file_missing');continue;}
      if((st.mode&0o077)!==0)issue(issues,files[kind],'private_file_permissions_required');
      const text=await readFile(path,'utf8');
      if(kind==='mobile'){mobile=JSON.parse(text);issues.push(...validateMobile(mobile,environment));}
      else{backend=parseEnv(text);issues.push(...validateBackend(backend,environment));}
    }catch{issue(issues,files[kind],'invalid_or_unreadable_file');}
  }
  if(mobile&&backend){
    const auth=mobile[`ALEHULSH_SUPABASE_URL_${environment.toUpperCase()}`];
    if(origin(auth)&&backend.SUPABASE_AUTH_ISSUER&&`${origin(auth)}/auth/v1`!==backend.SUPABASE_AUTH_ISSUER)issue(issues,'SUPABASE_AUTH_ISSUER','mobile_backend_mismatch');
    const evidence=mobile[`ALEHULSH_EVIDENCE_ORIGIN_${environment.toUpperCase()}`];
    if(origin(evidence)&&origin(backend.R2_ENDPOINT)&&origin(evidence)!==origin(backend.R2_ENDPOINT))issue(issues,'R2_ENDPOINT','mobile_backend_mismatch');
  }
  if(mobile){
    const other=environment==='dev'?'prod':'dev';
    try{
      const peer=JSON.parse(await readFile(resolve(root,`config/mobile.${other}.json`),'utf8'));
      for(const key of ['ALEHULSH_API_ORIGIN','ALEHULSH_SUPABASE_URL']){
        const current=origin(mobile[`${key}_${environment.toUpperCase()}`]),counterpart=origin(peer[`${key}_${other.toUpperCase()}`]);
        if(current&&current===counterpart)issue(issues,key,'reused_across_environments');
      }
    }catch{/* The selected file is validated independently; an absent peer grants nothing. */}
  }
  return {environment,files,configurationComplete:issues.length===0,productionReadiness:'not_verified',externalChecksPerformed:false,issues,
    integrationGates:['restricted Hyperdrive binding and verified origin TLS','private R2 binding and real upload/finalization','hosted Auth and session isolation','reviewed consent, retention and existing-user cutover','physical Android lifecycle and delivery','release signing and operational recovery']};
}
async function main(){
  const args=process.argv.slice(2),options={};
  for(let i=0;i<args.length;i++){
    const key=args[i];if(key==='--init'){options.init=true;continue;}
    if(!['--environment','--production-api-origin','--fcm-project-id','--fcm-client-email'].includes(key)||!args[i+1]||args[i+1].startsWith('--'))throw Error('invalid arguments');
    options[key]=args[++i];
  }
  if(options.init){console.log(JSON.stringify(await initializeEnvironments(appRoot,{productionApiOrigin:options['--production-api-origin'],fcmProjectId:options['--fcm-project-id'],fcmClientEmail:options['--fcm-client-email']}),null,2));return;}
  const result=await checkEnvironment(appRoot,options['--environment']??'dev');console.log(JSON.stringify(result,null,2));if(!result.configurationComplete)process.exitCode=1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('Environment configuration failed; no configuration values were printed.');process.exitCode=2;});
