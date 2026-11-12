import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {inspectRepositoryFile,scanRepository} from '../scripts/check-repository-secrets.mjs';
test('private key findings never return matching lines or key material',()=>{
 const material='A'.repeat(128),pem=['-----BEGIN PRIVATE KEY-----',material,'-----END PRIVATE KEY-----'].join('\n');
 for(const text of [pem,JSON.stringify({private_key:pem})]){
   const result=inspectRepositoryFile('synthetic-service-account.json',Buffer.from(text));assert.ok(result.includes('private_key_material'));assert.ok(!JSON.stringify(result).includes(material));
 }
});
test('literal validation markers and public certificates are not mistaken for secret keys',()=>{
 for(const text of ["key.startsWith('-----BEGIN PRIVATE KEY-----')",'-----BEGIN CERTIFICATE-----\n'+ 'A'.repeat(128)+'\n-----END CERTIFICATE-----'])assert.deepEqual(inspectRepositoryFile('source.ts',Buffer.from(text)),[]);
});
test('forced sensitive files and nonempty secret assignments fail while empty examples remain safe',()=>{
 for(const file of ['.dev.vars','.dev.vars.production','.env.production','android/key.properties','release.jks'])assert.ok(inspectRepositoryFile(file,Buffer.from('')).includes('sensitive_configuration_file'));
 assert.deepEqual(inspectRepositoryFile('.dev.vars.production.example',Buffer.from('KEYWORD_PEPPER=\nFCM_PRIVATE_KEY=\nPUSH_DELIVERY_ENABLED=false\n')),[]);
 assert.deepEqual(inspectRepositoryFile('example.sh',Buffer.from('KEYWORD_PEPPER="${LOCAL_TEST_KEYWORD_PEPPER:?required}"\n')),[]);
 const result=inspectRepositoryFile('bad-config.txt',Buffer.from('KEYWORD_PEPPER=synthetic-secret-sentinel\n'));assert.ok(result.includes('nonempty_secret_assignment'));assert.ok(!JSON.stringify(result).includes('synthetic-secret-sentinel'));
});
test('default scan reads the index rather than hiding staged secrets behind clean working files',async t=>{
 const root=await mkdtemp(join(tmpdir(),'alehulsh-index-scan-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const git=(...args)=>{const r=spawnSync('git',['-C',root,...args],{encoding:'utf8'});assert.equal(r.status,0);};git('init','--quiet');
 const file=join(root,'config.txt');await writeFile(file,'FCM_PRIVATE_KEY=synthetic-staged-sentinel\n');git('add','--','config.txt');await writeFile(file,'FCM_PRIVATE_KEY=\n');
 const index=await scanRepository(root);assert.deepEqual(index.findings,[{file:'config.txt',code:'nonempty_secret_assignment'}]);assert.ok(!JSON.stringify(index).includes('synthetic-staged-sentinel'));
 assert.deepEqual((await scanRepository(root,{workingTree:true})).findings,[]);
});
