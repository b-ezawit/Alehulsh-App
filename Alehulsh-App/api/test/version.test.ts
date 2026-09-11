import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, compareVersions, mustUpgrade } from '../src/version.js';

describe('parseVersion', () => {
  test('reads a plain semver', () => {
    assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3 });
  });

  test('tolerates a leading v and a build suffix', () => {
    assert.deepEqual(parseVersion('v1.2.3+45'), { major: 1, minor: 2, patch: 3 });
    assert.deepEqual(parseVersion('1.2.3-beta.1'), { major: 1, minor: 2, patch: 3 });
  });

  test('returns null for anything it cannot read', () => {
    for (const bad of ['', '1.2', 'x.y.z', '1.2.3.4', undefined, null, '99999999.0.0']) {
      assert.equal(parseVersion(bad as string), null, String(bad));
    }
  });
});

describe('compareVersions', () => {
  test('orders by major, then minor, then patch', () => {
    const v = (s: string) => parseVersion(s)!;
    assert.ok(compareVersions(v('1.0.0'), v('2.0.0')) < 0);
    assert.ok(compareVersions(v('1.9.0'), v('1.10.0')) < 0);
    assert.ok(compareVersions(v('1.2.3'), v('1.2.3')) === 0);
    assert.ok(compareVersions(v('2.0.1'), v('2.0.0')) > 0);
  });
});

describe('mustUpgrade — when in doubt, do not block', () => {
  test('blocks a client genuinely behind the minimum', () => {
    assert.equal(mustUpgrade('1.0.0', '1.1.0'), true);
  });

  test('allows a client at or above the minimum', () => {
    assert.equal(mustUpgrade('1.1.0', '1.1.0'), false);
    assert.equal(mustUpgrade('2.0.0', '1.1.0'), false);
  });

  test('an unreadable client version never blocks', () => {
    // She is opening a safety app. A version string we could not parse is our
    // problem, not a reason to stop her.
    for (const bad of ['', 'unknown', undefined, null]) {
      assert.equal(mustUpgrade(bad as string, '1.1.0'), false, String(bad));
    }
  });

  test('an unreadable or missing minimum never blocks', () => {
    // A typo in the remotely-configured value must not brick every install.
    for (const bad of ['', 'oops', undefined, null]) {
      assert.equal(mustUpgrade('1.0.0', bad as string), false, String(bad));
    }
  });
});
