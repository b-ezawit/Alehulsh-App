import { toClientError } from '../src/errors.js';
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

  test('retains Error classification without its sensitive message or stack', () => {
    const out = redact(new Error('boom')) as any;
    assert.equal(out.error, 'Error');
    assert.equal(out.message, undefined);
    assert.equal(out.stack, undefined);
  });

  test('leaves non-sensitive scalars alone', () => {
    assert.equal(redact('hello'), 'hello');
    assert.equal(redact(42), 42);
    assert.equal(redact(null), null);
  });
});

test('driver and provider diagnostic objects cannot log row, cause, or credential text', () => {
  const marker = 'synthetic-sensitive-diagnostic';
  const error = Object.assign(new Error(marker), { detail: marker, cause: new Error(marker) });
  const output = JSON.stringify(redact({ error, response: { message: marker, detail: marker, cause: marker }, err: marker }));
  assert.equal(output.includes(marker), false);
  assert.equal(output.includes('stack'), false);
});
test('untrusted Error names cannot smuggle diagnostic text into classification', () => {
  const error = new Error('synthetic-secret'); error.name = 'synthetic-secret';
  assert.deepEqual(redact(error), { error: 'Error' });
});

test('unhandled error mapping cannot expose diagnostics through the actual logger context', () => {
  const marker = 'synthetic-sensitive-diagnostic';
  const internal = toClientError(Object.assign(new Error(marker), { code: '23514', constraint: 'live_requires_age', detail: marker })).internal;
  const output = JSON.stringify(redact(internal));
  assert.equal(output.includes(marker), false);
  assert.equal(output.includes('live_requires_age'), true);
  assert.equal(output.includes('23514'), true);
});
