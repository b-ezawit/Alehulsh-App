import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AppError, toClientError } from '../src/errors.js';

describe('client error contract', () => {
  test('an unknown error never leaks its message to the client', () => {
    const { status, body, internal } = toClientError(
      new Error('FIRESTORE: permission denied on projects/alehulsh-app'),
    );
    assert.equal(status, 500);
    assert.equal(body.error.code, 'internal');
    assert.equal(body.error.message, 'Something went wrong on our side.');
    assert.ok(!JSON.stringify(body).includes('alehulsh-app'));
    // but it is still available for the log
    assert.ok(String(internal['unhandled']).includes('permission denied'));
  });

  test('forbidden and not_found are indistinguishable to a caller', () => {
    const a = toClientError(new AppError('forbidden'));
    const b = toClientError(new AppError('not_found'));
    assert.equal(a.body.error.message, b.body.error.message);
  });

  test('AppError detail stays server-side', () => {
    const { body, internal } = toClientError(
      new AppError('invalid_request', 'latitude out of range: 999'),
    );
    assert.ok(!JSON.stringify(body).includes('999'));
    assert.equal(internal['detail'], 'latitude out of range: 999');
  });

  test('status codes map correctly', () => {
    assert.equal(toClientError(new AppError('unauthenticated')).status, 401);
    assert.equal(toClientError(new AppError('rate_limited')).status, 429);
    assert.equal(toClientError(new AppError('conflict')).status, 409);
  });
});
