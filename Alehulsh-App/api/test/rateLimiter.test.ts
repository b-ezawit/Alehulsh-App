import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySlidingWindowLimiter } from '../src/rate/RateLimiter.js';

describe('InMemorySlidingWindowLimiter', () => {
  test('allows up to the cap and refuses past it', async () => {
    const l = new InMemorySlidingWindowLimiter();
    for (let i = 1; i <= 3; i++) {
      assert.equal((await l.hit('k', 3, 60_000)).allowed, true, `hit ${i}`);
    }
    assert.equal((await l.hit('k', 3, 60_000)).allowed, false);
  });

  test('keys are independent', async () => {
    const l = new InMemorySlidingWindowLimiter();
    await l.hit('a', 1, 60_000);
    assert.equal((await l.hit('a', 1, 60_000)).allowed, false);
    assert.equal((await l.hit('b', 1, 60_000)).allowed, true);
  });

  test('a refused hit still counts — failing does not reset the budget', async () => {
    const l = new InMemorySlidingWindowLimiter();
    await l.hit('k', 1, 60_000);
    const second = await l.hit('k', 1, 60_000);
    const third = await l.hit('k', 1, 60_000);
    assert.equal(second.count, 2);
    assert.equal(third.count, 3);
  });

  test('hits outside the window are forgotten', async () => {
    const l = new InMemorySlidingWindowLimiter();
    // A 1ms window: by the next tick the earlier hit has aged out.
    await l.hit('k', 1, 1);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal((await l.hit('k', 1, 1)).allowed, true);
  });
});
