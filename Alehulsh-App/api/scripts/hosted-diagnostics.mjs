/** Pure, value-free classifications shared by read-only infrastructure tools. */
export function classifyDnsRecords({a,aaaa,publicRcode}){
  if(publicRcode===3)return 'nxdomain';
  if(aaaa?.length&&!a?.length)return 'ipv6_only';
  if(a?.length||aaaa?.length)return 'resolved';
  return 'unverifiable';
}
export function classifyDatabaseFailure(error,{certificateAuthorized=false}={}){
  const code=typeof error?.code==='string'&&/^[A-Z0-9_]+$/.test(error.code)?error.code:'UNKNOWN';
  const message=typeof error?.message==='string'?error.message:'';
  const tlsCodes=new Set(['SELF_SIGNED_CERT_IN_CHAIN','DEPTH_ZERO_SELF_SIGNED_CERT','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','ERR_TLS_CERT_ALTNAME_INVALID','UNABLE_TO_GET_ISSUER_CERT_LOCALLY']);
  let cause='unclassified';
  if(code==='ENOTFOUND'||code==='EAI_AGAIN')cause='dns';
  else if(tlsCodes.has(code))cause='client_certificate_verification';
  else if(code==='ENETUNREACH'||code==='EHOSTUNREACH')cause='network_route';
  else if(/tenant[\s\S]{0,200}(?:not[\s_-]*found|unknown|invalid)/i.test(message))cause='pooler_tenant_mapping';
  else if(code==='28P01'||/password authentication failed/i.test(message))cause='database_authentication';
  else if(/circuit breaker/i.test(message))cause='pooler_circuit_breaker';
  else if(/paused|suspended/i.test(message))cause='provider_project_unavailable';
  else if(certificateAuthorized&&/^[0-9A-Z]{5}$/.test(code))cause='provider_postgres_error_after_verified_tls';
  return {code,cause,certificateAuthorized};
}
export function classifyJwksFailure(error){
  const code=error?.cause?.code??error?.code;
  if(code==='ENOTFOUND'||code==='EAI_AGAIN')return {cause:'dns',code};
  if(error?.name==='TimeoutError'||error?.name==='AbortError')return {cause:'timeout',code:'TIMEOUT'};
  return {cause:'unverifiable'};
}
