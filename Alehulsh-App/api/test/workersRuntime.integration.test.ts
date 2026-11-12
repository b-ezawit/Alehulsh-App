import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash,generateKeyPairSync } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import {spawnSync} from 'node:child_process';
let runtime: Miniflare | undefined, directory: string | undefined;
before(async () => {
  if (process.env['ALEHULSH_WORKER_RUNTIME_TESTS'] !== '1') return;
  directory = await mkdtemp(join(tmpdir(), 'alehulsh-workerd-'));
  const bundle = join(directory, 'workersRuntime.js');
  // Exercise the deployment bundler's real Node compatibility integration.
  // A bare esbuild/createRequire bundle omits required CJS built-in shims.
  const compiled=spawnSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','deploy','test/fixtures/workersRuntime.ts',
    '--dry-run','--outdir',directory,'--config','src/workers/wrangler.local.jsonc'],{
    encoding:'utf8',timeout:60000,env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
  assert.equal(compiled.status,0,compiled.stderr);
  runtime = new Miniflare(convertV4MiniflareOptions({
    rootPath: directory, workers: [{
      name: 'local-review', modules: true, scriptPath: bundle, compatibilityDate: '2026-10-24', compatibilityFlags: ['nodejs_compat'],
      r2Buckets: ['LOCAL_BUCKET'],
      bindings:{PRIVATE_PUSH_TEST_KEY:generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}}).privateKey},
      outboundService: () => new Response(null, { status: 502 })
    }]
  }));
});
after(async () => { await runtime?.dispose(); if (directory) await rm(directory, { recursive: true, force: true }); });
function local(name: string, run: () => Promise<void>) { test(name, async t => { if (!runtime) { t.skip('requires explicit local workerd execution'); return; } await run(); }); }
local('real workerd serves health and refuses protected routes without a session checker', async () => {
  assert.equal((await runtime!.dispatchFetch('http://local/healthz')).status, 200);
  const response = await runtime!.dispatchFetch('http://local/v1/me/inbox', { headers: { authorization: 'Bearer synthetic' } });
  assert.equal(response.status, 503); assert.equal(response.headers.get('cache-control'), 'no-store');
});
local('real workerd runs official Google Auth signing and private FCM transport using synthetic provider HTTP',async()=>{
 const response=await runtime!.dispatchFetch('http://local/__test/private-push');assert.equal(response.status,200);
 assert.deepEqual(await response.json(),{oauth:1,sends:1,accepted:true});
});
local('real workerd native scrypt and portable scrypt verify the same stored format', async () => {
  const response = await runtime!.dispatchFetch('http://local/__test/crypto'); assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { nativeVerifiesPortable: true, portableVerifiesNative: true, rejectsWrongKeyword: true });
});
local('native local R2 conditional publication preserves bytes after staging overwrite', async () => {
  const response = await runtime!.dispatchFetch('http://local/__test/publication'); assert.equal(response.status, 200, response.status === 200 ? '' : await response.clone().text());
  assert.deepEqual(await response.json(), {
    bytes: 'original', collisionRefused: true, sizeBytes: 8,
    sha256: createHash('sha256').update('original').digest('hex')
  });
});

local('native bounded publication aborts unread collisions and rejects truncated streams', async () => {
  const response = await runtime!.dispatchFetch('http://local/__test/publication-failures'); assert.equal(response.status, 200, response.status === 200 ? '' : await response.clone().text());
  assert.deepEqual(await response.json(), { collisionRefused: true, truncationRefused: true });
});
