import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../src/logger.js';

describe('redact', () => {
  test('removes sensitive values at the top level', () => {
    const out = redact({ uid: 'u1', phoneNumber: '+251911', catName: 'sunflower' }) as Record<string, unknown>;
    assert.equal(out['uid'], 'u1');
    assert.equal(out['phoneNumber'], '[redacted]');
    assert.equal(out['catName'], '[redacted]');
  });

  test('removes them when nested — this is what defeats a naive redactor', () => {
    const out = redact({
      alert: { meta: { deep: { latitude: 9.0125, longitude: 38.7636, status: 'active' } } },
    }) as any;
    assert.equal(out.alert.meta.deep.latitude, '[redacted]');
    assert.equal(out.alert.meta.deep.longitude, '[redacted]');
    assert.equal(out.alert.meta.deep.status, 'active');
  });

  test('redacts inside arrays', () => {
    const out = redact({ emergencyContacts: [{ phone: '+251911' }] }) as any;
    // the key itself is sensitive, so the whole array goes
    assert.equal(out.emergencyContacts, '[redacted]');
  });

  test('redacts sensitive keys held in a non-sensitive array', () => {
    const out = redact({ items: [{ phone: '+251911', id: 'a' }] }) as any;
    assert.equal(out.items[0].phone, '[redacted]');
    assert.equal(out.items[0].id, 'a');
  });

  test('matches case-insensitively and on substrings', () => {
    const out = redact({ AlerterPhone: 'x', lastKnownLat: 1, safetyKeyword: 'k' }) as any;
    assert.equal(out.AlerterPhone, '[redacted]');
    assert.equal(out.lastKnownLat, '[redacted]');
    assert.equal(out.safetyKeyword, '[redacted]');
  });

  test('caps recursion depth', () => {
    let deep: any = { status: 'ok' };
    for (let i = 0; i < 20; i++) deep = { nested: deep };
    assert.doesNotThrow(() => redact(deep));
    assert.ok(JSON.stringify(redact(deep)).includes('[max-depth]'));
  });

  test('keeps an Error message but never its stack', () => {
    const out = redact(new Error('boom')) as any;
    assert.equal(out.message, 'boom');
    assert.equal(out.stack, undefined);
  });

  test('leaves non-sensitive scalars alone', () => {
    assert.equal(redact('hello'), 'hello');
    assert.equal(redact(42), 42);
    assert.equal(redact(null), null);
  });
});
