import {readFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readDevelopmentConfig} from './preflight-development.mjs';
export {classifyDnsRecords,classifyDatabaseFailure,classifyJwksFailure} from './hosted-diagnostics.mjs';

const apiRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const idPattern=/^[a-f0-9]{32}$/i;
const errorCodes=body=>Array.isArray(body?.errors)?body.errors.map(e=>e.code).filter(Number.isSafeInteger):[];
/** GET only, fixed API host, no redirect following, bounded response. Never
 * return provider error messages, tokens, account secrets or binding values. */
async function cloudflareGet(path,token,fetcher){
  const response=await fetcher('https://api.cloudflare.com/client/v4/'+path,{
    method:'GET',headers:{authorization:'Bearer '+token},redirect:'manual',signal:AbortSignal.timeout(10000),
  });
  if(response.status>=300&&response.status<400){await response.body?.cancel();return {status:response.status,success:false,errorCodes:[],redirectRefused:true};}
  const reader=response.body?.getReader();let size=0,text='';const decoder=new TextDecoder();
  try{if(reader)for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>1024*1024)throw Error('response limit');text+=decoder.decode(part.value,{stream:true});}}
  finally{await reader?.cancel();}
  let body;try{body=JSON.parse(text);}catch{}
  return {status:response.status,success:response.ok&&body?.success===true,errorCodes:errorCodes(body),result:body?.result,totalPages:body?.result_info?.total_pages};
}
export async function inspectCloudflareOwnership(config,origin,{fetcher=fetch,expectedOwnerAccountId,expectedWorkerName}={}){
  const url=new URL(origin);
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!['','/'].includes(url.pathname))throw Error('HTTPS origin required');
  const labels=url.hostname.split('.');
  if(labels.length!==4||labels.slice(-2).join('.')!=='workers.dev'||!labels.slice(0,2).every(s=>/^[a-z0-9-]+$/.test(s)))throw Error('exact workers.dev origin required');
  if(!idPattern.test(config.CLOUDFLARE_ACCOUNT_ID??'')||!config.CLOUDFLARE_API_TOKEN)throw Error('operator configuration required');
  if(expectedOwnerAccountId&&!idPattern.test(expectedOwnerAccountId))throw Error('valid owner pin required');
  if(expectedWorkerName&&!/^[a-z0-9-]+$/.test(expectedWorkerName))throw Error('valid worker pin required');
  const token=config.CLOUDFLARE_API_TOKEN,script=labels[0];
  const accounts=[];let complete=false;
  for(let page=1;page<=10;page++){
    const result=await cloudflareGet('accounts?per_page=50&page='+page,token,fetcher);
    if(!result.success||!Array.isArray(result.result))return {configuredAccountId:config.CLOUDFLARE_ACCOUNT_ID,ownership:'unverifiable',accountInventoryStatus:result.status,errorCodes:result.errorCodes};
    accounts.push(...result.result.filter(a=>idPattern.test(a.id??'')));
    if(!result.totalPages||page>=result.totalPages){complete=true;break;}
  }
  const inspected=[];let owner;
  for(const account of accounts){
    const sub=await cloudflareGet(`accounts/${account.id}/workers/subdomain`,token,fetcher);
    const matches=sub.success&&typeof sub.result?.subdomain==='string'&&url.hostname===`${script}.${sub.result.subdomain}.workers.dev`;
    inspected.push({id:account.id,configured:account.id===config.CLOUDFLARE_ACCOUNT_ID,subdomainStatus:sub.status,matchesOrigin:matches});
    if(matches)owner=account.id;
  }
  const summary={configuredAccountId:config.CLOUDFLARE_ACCOUNT_ID,accounts:inspected,accountInventoryComplete:complete,
    ownership:owner?'verified':'unverifiable',ownerAccountId:owner,configuredAccountOwnsOrigin:owner?owner===config.CLOUDFLARE_ACCOUNT_ID:undefined,
    expectedOwnerAccountId,ownerMatchesExpected:owner&&expectedOwnerAccountId?owner===expectedOwnerAccountId:undefined,
    workerName:script,workerMatchesExpected:expectedWorkerName?script===expectedWorkerName:undefined};
  if(!owner)return summary; // An empty or inaccessible account is never proof a deployment is absent globally.
  for(const [label,suffix]of [['route',`workers/scripts/${script}/subdomain`],['settings',`workers/scripts/${script}/settings`],['deployments',`workers/scripts/${script}/deployments`],['hyperdrive','hyperdrive/configs']]){
    const result=await cloudflareGet(`accounts/${owner}/${suffix}`,token,fetcher);
    const detail={status:result.status,verified:result.success,errorCodes:result.errorCodes};
    if(result.success){
      const value=result.result;
      if(label==='route')detail.enabled=value?.enabled===true;
      if(label==='settings'){
        detail.bindings=(value?.bindings??[]).map(b=>({name:b.name,type:b.type,...(b.type==='r2_bucket'?{bucketName:b.bucket_name}:{})}));
        detail.compatibilityDate=value?.compatibility_date;
        detail.targetBindingsPresent=detail.bindings.some(b=>b.name==='HYPERDRIVE'&&b.type==='hyperdrive')&&detail.bindings.some(b=>b.name==='EVIDENCE_BUCKET'&&b.type==='r2_bucket');
      }
      if(label==='deployments')detail.versions=(value?.deployments??[]).slice(0,3).map(d=>({deploymentId:d.id,versions:(d.versions??[]).map(v=>({id:v.version_id,percentage:v.percentage}))}));
      if(label==='hyperdrive')detail.count=Array.isArray(value)?value.length:undefined;
    }
    summary[label]=detail;
  }
  return summary;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.slice(2).length)throw Error('no arguments supported');
    const mobile=JSON.parse(await readFile(resolve(apiRoot,'../config/mobile.prod.json'),'utf8'));
    const production=await readDevelopmentConfig(resolve(apiRoot,'.dev.vars.production'));
    const result=await inspectCloudflareOwnership(await readDevelopmentConfig(),mobile.ALEHULSH_API_ORIGIN_PROD,{expectedOwnerAccountId:production.CLOUDFLARE_ACCOUNT_ID,expectedWorkerName:production.CLOUDFLARE_WORKER_NAME});
    console.log(JSON.stringify(result,null,2));
    if(result.ownership!=='verified'||result.ownerMatchesExpected===false||result.workerMatchesExpected===false)process.exitCode=1;
  }catch{console.error('Read-only hosted inventory could not complete; no credentials or provider messages were printed.');process.exitCode=1;}
}
