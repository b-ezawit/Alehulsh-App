import {spawnSync} from 'node:child_process';
import {readFile,lstat} from 'node:fs/promises';
import {resolve,basename,extname,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const repository=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const sensitive=/^(?:KEYWORD_PEPPER|FCM_PRIVATE_KEY|SUPABASE_DB_PASSWORD|R2_SECRET_ACCESS_KEY|CLOUDFLARE_API_TOKEN|JWT_SECRET|PGPASSWORD)$/;
/** Return classifications only. Never return a matching line or value. */
export function inspectRepositoryFile(filename,bytes){
  const findings=[],name=basename(filename);
  if((/^\.env(?:\.|$)|^\.dev\.vars(?:\.|$)/.test(name)&&!name.endsWith('.example'))||name==='key.properties'||['.jks','.keystore','.p12','.pfx'].includes(extname(name)))findings.push('sensitive_configuration_file');
  if(bytes.includes(0))return findings;
  const text=bytes.toString('utf8').replaceAll('\\r\\n','\n').replaceAll('\\n','\n');
  if(/-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----\s*[A-Za-z0-9+/=\s]{64,}\s*-----END (?:[A-Z ]*PRIVATE KEY)-----/.test(text))findings.push('private_key_material');
  // Assignment detection uses physical source lines, not escaped fixture data.
  for(const line of bytes.toString('utf8').split(/\r?\n/)){
    const match=line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if(!match||!sensitive.test(match[1]))continue;
    const value=match[2].replace(/^['"]|['"]$/g,'').trim();
    if(value&&!value.startsWith('#')&&!/^\$\{|^<[^>]+>$|^(?:your[_ -]|replace|changeme)/i.test(value))findings.push('nonempty_secret_assignment');
  }
  return [...new Set(findings)];
}
export async function scanRepository(root=repository,{workingTree=false}={}){
  const args=['-C',root,'ls-files','-z',...(workingTree?['--cached','--others','--exclude-standard']:[])];
  const files=spawnSync('git',args,{encoding:'utf8',maxBuffer:16*1024*1024});
  if(files.status!==0)throw Error('repository inventory unavailable');
  const findings=[];
  for(const filename of new Set(files.stdout.split('\0').filter(Boolean))){
    let bytes;
    if(workingTree){
      try{const path=resolve(root,filename),st=await lstat(path);if(!st.isFile()||st.isSymbolicLink())continue;bytes=await readFile(path);}
      catch{findings.push({file:filename,code:'source_unavailable'});continue;}
    }else{
      const blob=spawnSync('git',['-C',root,'show',`:${filename}`],{maxBuffer:16*1024*1024});
      if(blob.status!==0){findings.push({file:filename,code:'source_unavailable'});continue;}
      bytes=blob.stdout;
    }
    for(const code of inspectRepositoryFile(filename,bytes))findings.push({file:filename,code});
  }
  return {filesScanned:new Set(files.stdout.split('\0').filter(Boolean)).size,findings};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.slice(2).some(arg=>arg!=='--working-tree'))throw Error('invalid argument');
    const result=await scanRepository(repository,{workingTree:process.argv.includes('--working-tree')});
    console.log(JSON.stringify(result,null,2));if(result.findings.length)process.exitCode=1;
  }catch{console.error('Secret scan could not complete; no file contents were printed.');process.exitCode=2;}
}
