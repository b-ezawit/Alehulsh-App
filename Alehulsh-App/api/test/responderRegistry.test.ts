import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ResponderRegistry } from '../src/services/ResponderRegistry.js';
import { createLogger } from '../src/logger.js';
import { AppError } from '../src/errors.js';
import { FakeResponderRepository } from './fakes.js';

/**
 * AppError keeps the descriptive string in `detail` and never in `message` —
 * the client gets text we wrote, not internal reasoning (errors.ts). So tests
 * assert on the code and the detail, which is also what a caller debugging a
 * failure would look at.
 */
const rejectsWith = async (fn: () => Promise<unknown>, code: string, detail?: RegExp) => {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof AppError, `expected AppError, got ${String(err)}`);
    assert.equal(err.code, code);
    if (detail) assert.match(err.detail ?? '', detail);
    return true;
  });
};

const FOUNDER = 'founder_uid';
const A = 'a_uid';
const B = 'b_uid';
const C = 'c_uid';

let repo: FakeResponderRepository;
let reg: ResponderRegistry;

beforeEach(() => {
  repo = new FakeResponderRepository();
  reg = new ResponderRegistry(repo, 3, createLogger('error'));
});

describe('eligibility — the question the fan-out asks', () => {
  test('an unknown user is not eligible', async () => {
    // The default. A user is not a responder just by existing.
    assert.equal(await reg.isEligible(A), false);
  });

  test('being vouched for is not enough — she has to accept', async () => {
    await reg.bootstrap(FOUNDER);
    await reg.vouchFor(FOUNDER, A);
    assert.equal(await reg.isEligible(A), false);
  });

  test('accepting makes her eligible', async () => {
    await reg.bootstrap(FOUNDER);
    await reg.vouchFor(FOUNDER, A);
    await reg.acceptVouch(A);
    assert.equal(await reg.isEligible(A), true);
  });

  test('a suspended responder is not eligible', async () => {
    await reg.bootstrap(FOUNDER);
    await reg.suspend(FOUNDER, 'cause');
    assert.equal(await reg.isEligible(FOUNDER), false);
  });
});

describe('vouching', () => {
  test('nobody can vouch for themselves', async () => {
    await reg.bootstrap(FOUNDER);
    await rejectsWith(() => reg.vouchFor(FOUNDER, FOUNDER), 'invalid_request', /vouch for yourself/);
  });

  test('a non-responder cannot vouch', async () => {
    await rejectsWith(() => reg.vouchFor(A, B), 'forbidden');
  });

  test('a pending responder cannot vouch — she has nothing to stake yet', async () => {
    await reg.bootstrap(FOUNDER);
    await reg.vouchFor(FOUNDER, A);
    await rejectsWith(() => reg.vouchFor(A, B), 'forbidden');
  });

  test('a suspended responder cannot vouch', async () => {
    await reg.bootstrap(FOUNDER);
    await reg.suspend(FOUNDER, 'cause');
    await assert.rejects(() => reg.vouchFor(FOUNDER, A));
  });

  test('vouches are capped, so one account cannot grow a network', async () => {
    await reg.bootstrap(FOUNDER);
    for (const u of ['u1', 'u2', 'u3']) await reg.vouchFor(FOUNDER, u);
    await rejectsWith(() => reg.vouchFor(FOUNDER, 'u4'), 'forbidden', /vouch limit/);
  });

  test('cannot vouch for someone who already has status', async () => {
    await reg.bootstrap(FOUNDER);
    await reg.vouchFor(FOUNDER, A);
    await rejectsWith(() => reg.vouchFor(FOUNDER, A), 'conflict', /already has responder status/);
  });

  test('the chain is recorded — this is what makes accountability possible', async () => {
    await reg.bootstrap(FOUNDER);
    await reg.vouchFor(FOUNDER, A);
    assert.equal((await repo.findByUid(A))!.vouchedBy, FOUNDER);
  });

  test('the founding set has no voucher', async () => {
    await reg.bootstrap(FOUNDER);
    assert.equal((await repo.findByUid(FOUNDER))!.vouchedBy, null);
  });

  test('bootstrapping an existing responder is refused', async () => {
    await reg.bootstrap(FOUNDER);
    await rejectsWith(() => reg.bootstrap(FOUNDER), 'conflict', /already a responder/);
  });
});

describe('suspension cascade — "both in trouble"', () => {
  const chain = async () => {
    await reg.bootstrap(FOUNDER);
    await reg.vouchFor(FOUNDER, A); await reg.acceptVouch(A);
    await reg.vouchFor(A, B);       await reg.acceptVouch(B);
    await reg.vouchFor(B, C);       await reg.acceptVouch(C);
  };

  test('suspending someone flags everyone they vouched for', async () => {
    await chain();
    const { cascaded } = await reg.suspend(A, 'harmed a user');
    assert.deepEqual(cascaded, [B]);
    assert.equal((await repo.findByUid(B))!.status, 'needs_revouch');
  });

  test('the cascade is one level — it does not punish strangers', async () => {
    // C is two removes from A and has not been accused of anything.
    await chain();
    await reg.suspend(A, 'cause');
    assert.equal((await repo.findByUid(C))!.status, 'active');
  });

  test('cascaded users are flagged, not accused', async () => {
    // needs_revouch, never suspended: they lost a voucher, they did nothing.
    await chain();
    await reg.suspend(A, 'cause');
    assert.notEqual((await repo.findByUid(B))!.status, 'suspended');
  });

  test('a flagged user can be re-vouched by someone else', async () => {
    await chain();
    await reg.suspend(A, 'cause');
    await reg.vouchFor(FOUNDER, B);
    await reg.acceptVouch(B);
    assert.equal(await reg.isEligible(B), true);
    assert.equal((await repo.findByUid(B))!.vouchedBy, FOUNDER);
  });

  test('an already-suspended downstream user is left suspended', async () => {
    await chain();
    await reg.suspend(B, 'their own conduct');
    const { cascaded } = await reg.suspend(A, 'cause');
    assert.deepEqual(cascaded, []);
    assert.equal((await repo.findByUid(B))!.status, 'suspended');
  });

  test('the reason is recorded', async () => {
    await reg.bootstrap(FOUNDER);
    await reg.suspend(FOUNDER, 'harassment report');
    assert.equal((await repo.findByUid(FOUNDER))!.suspensionReason, 'harassment report');
  });
});
