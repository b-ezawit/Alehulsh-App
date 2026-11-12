/** Read-only development inventory. Never prints credentials or reads app rows. */
import {readFile, readdir} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {classifyDatabaseFailure,classifyJwksFailure} from './hosted-diagnostics.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
export async function readDevelopmentConfig(path=resolve(root,'.dev.vars')) {
  return parseEnv(await readFile(path,'utf8'));
}
const errorCode=error=>typeof error?.code==='string'&&/^[A-Z0-9_]+$/.test(error.code)?error.code:'UNAVAILABLE';
export async function inspectDatabase(client) {
  let begun=false;
  try {
    await client.connect();
    await client.query('BEGIN TRANSACTION READ ONLY');begun=true;
    await client.query("SET LOCAL statement_timeout='5000ms'");
    const {rows:[server]}=await client.query(`SELECT current_setting('server_version_num') AS version,
      (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS privileged,
      (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS bypassrls,
      (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS originBackendTls,
      EXISTS(SELECT 1 FROM pg_extension WHERE extname='postgis') AS postgis,
      to_regclass('public.alehulsh_migrations') IS NOT NULL AS ledger`);
    const {rows:tables}=await client.query(`SELECT c.relname AS name,c.relrowsecurity AS rls,c.relforcerowsecurity AS forced
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname`);
    const {rows:roles}=await client.query(`SELECT rolname AS name,rolsuper AS privileged,rolbypassrls AS bypassrls,rolcanlogin AS login
      FROM pg_roles WHERE rolname IN ('anon','authenticated','alehulsh_api') ORDER BY rolname`);
    const {rows:authColumns}=await client.query(`SELECT table_name AS table,column_name AS column,data_type AS type
      FROM information_schema.columns WHERE table_schema='auth'
        AND table_name IN ('users','sessions','identities') ORDER BY table_name,ordinal_position`);
    const {rows:authTables}=await client.query(`SELECT c.relname AS name,c.relrowsecurity AS rls,c.relforcerowsecurity AS forced,
      has_table_privilege(current_user,c.oid,'SELECT') AS inspector_select,
      pg_has_role(current_user,c.relowner,'USAGE') AS inspector_policy_owner,
      has_table_privilege(current_user,c.oid,'SELECT WITH GRANT OPTION') AS inspector_grant_select,
      has_schema_privilege(current_user,n.oid,'USAGE WITH GRANT OPTION') AS inspector_grant_schema
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='auth' AND c.relname IN ('users','sessions') ORDER BY c.relname`);
    const {rows:functions}=await client.query(`SELECT p.proname AS name,p.prosecdef AS definer,
      pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname IN ('create_alert','transition_alert','resolve_identity','fail_keyword_attempt',
        'request_keyword_reset','confirm_keyword_reset','guard_evidence_immutability') ORDER BY p.proname`);
    const applied=server.ledger?(await client.query('SELECT filename FROM public.alehulsh_migrations ORDER BY filename')).rows.map(row=>row.filename):[];
    let roleContext={available:false};let probeStage='set-role';let authPrivileges;
    if(roles.some(role=>role.name==='alehulsh_api')) {
      await client.query('SAVEPOINT role_probe');
      try {
        await client.query('SET LOCAL ROLE alehulsh_api');
        probeStage='set-claims';
        const claims='11111111-1111-4111-8111-111111111111';
        await client.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",[claims,JSON.stringify({sub:claims})]);
        probeStage='auth-privileges';
        authPrivileges=(await client.query("SELECT has_schema_privilege(current_user,'auth','USAGE') AS schema_usage,has_function_privilege(current_user,p.oid,'EXECUTE') AS uid_execute FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='auth' AND p.proname='uid' AND p.pronargs=0")).rows[0];
        probeStage='auth-uid';
        const {rows:[probe]}=await client.query(`SELECT current_user='alehulsh_api' AS restricted_role,
          auth.uid()::text=$1 AS local_identity`,[claims]);
        roleContext={available:true,...probe,authPrivileges};
      } catch(error){roleContext={available:false,errorCode:errorCode(error),stage:probeStage,authPrivileges};}
      await client.query('ROLLBACK TO SAVEPOINT role_probe');
    }
    const stream=client.connection?.stream;
    const clientTls={encrypted:stream?.encrypted===true,certificateAuthorized:stream?.authorized===true};
    return {connected:true,clientTls,server,tables,roles,authColumns,authTables,functions,applied,roleContext};
  } finally {
    if(begun)await client.query('ROLLBACK').catch(()=>{});
    await client.end().catch(()=>{});
  }
}
export async function preflight(config,options={}) {
  for(const key of ['SUPABASE_PROJECT_REF','SUPABASE_DB_HOST','SUPABASE_DB_PORT','SUPABASE_DB_NAME','SUPABASE_DB_USER','SUPABASE_DB_PASSWORD']){
    if(!config[key])throw Error(`missing ${key}`);
  }
  if(config.SUPABASE_DB_HOST!==`db.${config.SUPABASE_PROJECT_REF}.supabase.co`)throw Error('direct database host does not match development project');
  const candidates=[{kind:'direct',host:config.SUPABASE_DB_HOST,port:Number(config.SUPABASE_DB_PORT),user:config.SUPABASE_DB_USER}];
  if(config.SUPABASE_POOLER_HOST&&config.SUPABASE_POOLER_USER&&config.SUPABASE_POOLER_SESSION_PORT){
    if(!config.SUPABASE_POOLER_HOST.endsWith('.pooler.supabase.com')||!config.SUPABASE_POOLER_USER.endsWith(`.${config.SUPABASE_PROJECT_REF}`))throw Error('pooler does not match development project');
    candidates.push({kind:'session-pooler',host:config.SUPABASE_POOLER_HOST,port:Number(config.SUPABASE_POOLER_SESSION_PORT),user:config.SUPABASE_POOLER_USER});
  }
  let ca=config.PGSSL_CA_PEM;
  if(config.PGSSL_CA_FILE)ca=await readFile(resolve(root,config.PGSSL_CA_FILE),'utf8');
  else {try{ca=await readFile(resolve(root,'.dev-certs/supabase-ca.pem'),'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}}
  const database=[];
  for(const candidate of candidates) {
    let client;
    try {
      client=new pg.Client({...candidate,database:config.SUPABASE_DB_NAME,password:config.SUPABASE_DB_PASSWORD,
        connectionTimeoutMillis:8000,query_timeout:8000,ssl:{rejectUnauthorized:true,
          ...(ca?{ca}:{})}});
      database.push({kind:candidate.kind,...await inspectDatabase(client)});
      break;
    } catch(error){database.push({kind:candidate.kind,connected:false,errorCode:errorCode(error),
      failure:classifyDatabaseFailure(error,{certificateAuthorized:client?.connection?.stream?.authorized===true})});}
  }
  const files=(await readdir(resolve(root,'db/migrations'))).filter(name=>name.endsWith('.sql')).sort();
  const migrations=await Promise.all(files.map(async filename=>({filename,sha256:createHash('sha256').update(await readFile(resolve(root,'db/migrations',filename))).digest('hex')})));
  let auth={reachable:false};
  const issuer=`https://${config.SUPABASE_PROJECT_REF}.supabase.co/auth/v1`;
  try {
    if(config.SUPABASE_AUTH_ISSUER&&config.SUPABASE_AUTH_ISSUER!==issuer)throw Error('issuer mismatch');
    const response=await fetch(`${issuer}/.well-known/jwks.json`,{redirect:'error',signal:AbortSignal.timeout(8000)});
    const data=response.ok?await response.json():null;
    auth={reachable:response.ok,status:response.status,asymmetricKeyCount:Array.isArray(data?.keys)?data.keys.filter(key=>['ES256','RS256'].includes(key.alg)).length:0};
  } catch(error) {auth={reachable:false,failure:classifyJwksFailure(error)};}
  let hyperdrive={inspected:false};
  if(options.expectedAccountId&&config.CLOUDFLARE_ACCOUNT_ID===options.expectedAccountId&&config.CLOUDFLARE_API_TOKEN) {
    try {
      const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${config.CLOUDFLARE_ACCOUNT_ID}/hyperdrive/configs`,{
        headers:{authorization:`Bearer ${config.CLOUDFLARE_API_TOKEN}`},redirect:'error',signal:AbortSignal.timeout(8000)});
      const body=response.ok?await response.json():null;
      hyperdrive={inspected:response.ok,status:response.status,configs:Array.isArray(body?.result)?body.result.map(item=>({id:item.id,cacheDisabled:item.caching?.disabled===true,
        matchesDevelopment:item.origin?.host===config.SUPABASE_DB_HOST||item.origin?.host===config.SUPABASE_POOLER_HOST})):[]};
    } catch{hyperdrive={inspected:false};}
  }
  return {readOnly:true,database,auth,hyperdrive,migrations,
    missingConfiguration:['KEYWORD_PEPPER','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','R2_ENDPOINT','R2_BUCKET'].filter(key=>!config[key])};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try{const index=process.argv.indexOf('--cloudflare-account');console.log(JSON.stringify(await preflight(await readDevelopmentConfig(),{expectedAccountId:index>=0?process.argv[index+1]:undefined}),null,2));}
  catch(error){console.error(error instanceof Error&&/^missing [A-Z_]+$/.test(error.message)?error.message:'Development preflight refused; no credential details reported.');process.exitCode=1;}
}
