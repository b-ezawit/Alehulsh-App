import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeywordAdmission, KeywordCapacityError } from '../src/crypto/KeywordAdmission.js';

test('KDF work is serialized, bounded, and releases admission after failure', async () => {
  const admission = new KeywordAdmission(1);
  let release!: () => void, active = 0, peak = 0;
  const first = admission.run(async () => { active++; peak=Math.max(active,peak); await new Promise<void>(r=>{release=r;}); active--; throw Error('synthetic'); });
  const failed = assert.rejects(first);
  const second = admission.run(async () => { active++; peak=Math.max(active,peak); active--; return 2; });
  await assert.rejects(admission.run(async()=>3), KeywordCapacityError);
  release(); await failed; assert.equal(await second,2); assert.equal(peak,1);
  assert.equal(await admission.run(async()=>4),4);
});
