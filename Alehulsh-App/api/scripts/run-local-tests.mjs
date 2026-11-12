import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

export function assertLocalFixtures(env) {
  if (env.ALEHULSH_LOCAL_DB_TESTS !== '1' || !['127.0.0.1','localhost','::1'].includes(env.PGHOST)) {
    throw Error('Explicit loopback PostgreSQL fixture required');
  }
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(env.FIRESTORE_EMULATOR_HOST ?? '')) {
    throw Error('Loopback Firestore emulator required');
  }
}
export function unexpectedSkips(filename, skipped) {
  // These require explicitly approved external integration environments.
  const allowed = { 'r2EvidenceStore.integration.test.js': 16, 'supabaseIdentity.integration.test.js': 11 };
  return skipped > (allowed[filename] ?? 0);
}
export function isolatedTestEnvironment(original){
  const env={...original,ALEHULSH_WORKER_RUNTIME_TESTS:'1',METADATA_SERVER_DETECTION:'none'};
  for(const key of Object.keys(env))if(/^(R2_|AWS_|SUPABASE_|CLOUDFLARE_|GOOGLE_|FCM_|PUSH_)/.test(key)||
    ['DATABASE_URL','KEYWORD_PEPPER','FIREBASE_CONFIG','ALEHULSH_SUPABASE_INTEGRATION'].includes(key))delete env[key];
  return env;
}
function run() {
  assertLocalFixtures(process.env);
  const env = isolatedTestEnvironment(process.env);
  const files = readdirSync('dist/test').filter(n=>n.endsWith('.test.js')).sort().map(n=>`dist/test/${n}`);
  if (!files.length) throw Error('Compile tests before executing the integration gate');
  files.push(...readdirSync('test').filter(n=>n.endsWith('.test.mjs')).sort().map(n=>`test/${n}`));
  if (!files.length) throw Error('Compile tests before executing the integration gate');
  let failed = false;
  for (const path of files) {
    const result = spawnSync(process.execPath, [path], { env, encoding:'utf8', timeout:180000, maxBuffer:16*1024*1024 });
    process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
    const skipped = Number((result.stdout ?? '').match(/(?:ℹ|#) skipped (\d+)/)?.[1] ?? 0);
    if (result.status !== 0 || result.error || unexpectedSkips(path.split('/').at(-1),skipped)) failed = true;
  }
  process.exitCode = failed ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) run();
