import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { R2EvidenceStore } from '../src/evidence/R2EvidenceStore.js';

// No network: all storage requests are handled by the supplied fetch stub.
const CONFIG = {
  endpoint: 'https://r2.invalid', bucket: 'synthetic-evidence',
  accessKeyId: 'test-access-key', secretAccessKey: 'test-secret-key',
};
const PATH = 'evidence/alice/alert/recording';

function listing(keys: string[], next?: string): string {
  return '<ListBucketResult>' + keys.map((key) => `<Contents><Key>${key}</Key></Contents>`).join('')
    + `<IsTruncated>${next === undefined ? 'false' : 'true'}</IsTruncated>`
    + (next === undefined ? '' : `<NextContinuationToken>${next}</NextContinuationToken>`)
    + '</ListBucketResult>';
}

function stubbed(pages: string[]) {
  const requests: Request[] = [];
  let page = 0;
  const store = new R2EvidenceStore(CONFIG, (async (input: RequestInfo | URL) => {
    const request = input instanceof Request ? input : new Request(input);
    requests.push(request);
    if (request.method === 'DELETE') return new Response(null, { status: 204 });
    const body = pages[page++];
    assert.notEqual(body, undefined, 'an unexpected extra list request was made');
    return new Response(body, { status: 200 });
  }) as typeof fetch);
  return { store, requests };
}

describe('R2 erasure fails closed', () => {
  test('a truncated page without a continuation token does not report partial success', async () => {
    const { store, requests } = stubbed([
      '<ListBucketResult><Key>evidence/alice/a/1</Key><IsTruncated>true</IsTruncated></ListBucketResult>',
    ]);
    await assert.rejects(store.removeAllForOwner('alice'), /without a continuation token/);
    assert.equal(requests.filter((r) => r.method === 'DELETE').length, 0);
  });

  test('a repeated continuation token fails rather than looping indefinitely', async () => {
    const { store, requests } = stubbed([
      listing(['evidence/alice/a/1'], 'token'), listing(['evidence/alice/a/2'], 'token'),
    ]);
    await assert.rejects(store.removeAllForOwner('alice'), /repeated a continuation token/);
    assert.equal(requests.filter((r) => r.method === 'GET').length, 2);
    assert.equal(requests.filter((r) => r.method === 'DELETE').length, 1);
  });

  test('a longer continuation-token cycle also fails', async () => {
    const { store } = stubbed([listing([], 'a'), listing([], 'b'), listing([], 'a')]);
    await assert.rejects(store.removeAllForOwner('alice'), /repeated a continuation token/);
  });

  test('valid pagination deletes all returned keys and preserves opaque tokens', async () => {
    const { store, requests } = stubbed([
      listing(['evidence/alice/a/1'], 'token&amp;2'), listing(['evidence/alice/a/2']),
    ]);
    assert.equal(await store.removeAllForOwner('alice'), 2);
    const lists = requests.filter((r) => r.method === 'GET');
    assert.deepEqual(lists.map((r) => new URL(r.url).searchParams.get('continuation-token')), [null, 'token&2']);
    assert.deepEqual(requests.filter((r) => r.method === 'DELETE').map((r) => new URL(r.url).pathname), [
      '/synthetic-evidence/evidence/alice/a/1', '/synthetic-evidence/evidence/alice/a/2',
    ]);
  });

  test('an empty complete listing reports zero', async () => {
    const { store } = stubbed([listing([])]);
    assert.equal(await store.removeAllForOwner('alice'), 0);
  });

  test('foreign-owner keys reject the whole page before deletion', async () => {
    const { store, requests } = stubbed([listing(['evidence/alice/a/1', 'evidence/bob/a/2'])]);
    await assert.rejects(store.removeAllForOwner('alice'), /outside the owner prefix/);
    assert.equal(requests.filter((r) => r.method === 'DELETE').length, 0);
  });

  test('malformed successful responses cannot complete erasure', async () => {
    for (const xml of ['', '<Error><Code>InternalError</Code></Error>',
      '<ListBucketResult></ListBucketResult>',
      '<ListBucketResult><IsTruncated>false</IsTruncated>']) {
      const { store } = stubbed([xml]);
      await assert.rejects(store.removeAllForOwner('alice'), /invalid listing/);
    }
  });

  test('list failures and deletion failures propagate without claiming success', async () => {
    const failing = new R2EvidenceStore(CONFIG, (async () => new Response(null, { status: 503 })) as typeof fetch);
    await assert.rejects(failing.removeAllForOwner('alice'), /list failed with 503/);
    const denied = new R2EvidenceStore(CONFIG, (async (request: Request) => request.method === 'DELETE'
      ? new Response(null, { status: 403 }) : new Response(listing([PATH]))) as typeof fetch);
    await assert.rejects(denied.removeAllForOwner('alice'), /DELETE failed with 403/);
  });
});

describe('R2 signed grants stay within their path and lifetime', () => {
  const store = new R2EvidenceStore(CONFIG, (async () => {
    throw new Error('signing must not contact storage');
  }) as typeof fetch);

  test('upload signs the content type and reports the signature expiry exactly', async () => {
    const ticket = await store.createUploadTicket({
      ownerUid: 'alice', alertId: 'alert', evidenceId: 'recording', contentType: 'audio/aac',
    });
    const params = new URL(ticket.url).searchParams;
    assert.match(params.get('X-Amz-SignedHeaders') ?? '', /content-type/);
    assert.equal(params.get('X-Amz-Expires'), '900');
    assert.equal(ticket.storagePath, PATH);
    const stamp = params.get('X-Amz-Date')!;
    const issued = Date.UTC(Number(stamp.slice(0, 4)), Number(stamp.slice(4, 6)) - 1,
      Number(stamp.slice(6, 8)), Number(stamp.slice(9, 11)), Number(stamp.slice(11, 13)), Number(stamp.slice(13, 15)));
    assert.equal(ticket.expiresAt.getTime(), issued + 900_000);
    assert.ok(!ticket.url.includes(CONFIG.secretAccessKey));
  });

  test('fractional seconds are bounded by the signed whole-second lifetime', async () => {
    const ticket = await store.createPlaybackUrl(PATH, 1500);
    assert.equal(new URL(ticket.url).searchParams.get('X-Amz-Expires'), '1');
    assert.equal(ticket.expiresAt.getTime() % 1000, 0);
  });

  test('NaN, infinity, subsecond and oversized lifetimes are refused', async () => {
    for (const ttl of [NaN, Infinity, -Infinity, -1, 0, 999, 7 * 24 * 60 * 60 * 1000 + 1]) {
      await assert.rejects(store.createPlaybackUrl(PATH, ttl), /ttl/);
    }
  });

  test('path traversal or nested identifiers cannot move a grant across owners', async () => {
    for (const segment of ['', '.', '..', '../bob', 'alice/bob', 'alice\\bob', 'alice\u0000']) {
      await assert.rejects(store.createUploadTicket({
        ownerUid: segment, alertId: 'alert', evidenceId: 'recording', contentType: 'audio/aac',
      }), /path segment/);
      await assert.rejects(store.removeAllForOwner(segment), /path segment/);
    }
    for (const path of ['evidence/alice/../bob', '/evidence/alice/a/b', 'evidence/alice/a/b/c']) {
      await assert.rejects(store.createPlaybackUrl(path, 1000), /path/);
    }
  });

  test('unsupported content types cannot receive a signed upload grant', async () => {
    await assert.rejects(store.createUploadTicket({
      ownerUid: 'alice', alertId: 'alert', evidenceId: 'recording', contentType: 'application/octet-stream',
    }), /unsupported/);
  });

  test('insecure remote or credential-bearing endpoints are rejected at construction', () => {
    for (const endpoint of ['http://r2.invalid', 'https://user:password@r2.invalid',
      'https://r2.invalid?key=1', 'https://r2.invalid/path', 'https://r2.invalid#fragment']) {
      assert.throws(() => new R2EvidenceStore({ ...CONFIG, endpoint }), /HTTPS origin/);
    }
    assert.doesNotThrow(() => new R2EvidenceStore({ ...CONFIG, endpoint: 'http://127.0.0.1:9090' }));
  });
});

describe('R2 metadata does not hide corrupted responses', () => {
  test('invalid content lengths throw instead of becoming trusted evidence sizes', async () => {
    for (const value of ['-1', '1.5', '', 'NaN', 'Infinity', '9007199254740992']) {
      const store = new R2EvidenceStore(CONFIG, (async () => new Response(null, {
        headers: { 'content-length': value },
      })) as typeof fetch);
      await assert.rejects(store.sizeOf(PATH), /invalid content length/);
    }
  });

  test('a missing object remains distinct from access denial', async () => {
    const absent = new R2EvidenceStore(CONFIG, (async () => new Response(null, { status: 404 })) as typeof fetch);
    assert.equal(await absent.exists(PATH), false);
    assert.equal(await absent.sizeOf(PATH), null);
    const denied = new R2EvidenceStore(CONFIG, (async () => new Response(null, { status: 403 })) as typeof fetch);
    await assert.rejects(denied.exists(PATH), /403/);
    await assert.rejects(denied.sizeOf(PATH), /403/);
  });
});


test('immutable published paths support playback, inspection and owner-prefix erasure', async () => {
  const published = `${PATH}/published/12345678-1234-1234-1234-123456789abc`;
  const requests: Request[] = [];
  const store = new R2EvidenceStore(CONFIG, (async (input: Request) => {
    requests.push(input);
    return input.method === 'HEAD' ? new Response(null, {headers: {'content-length': '24'}})
      : input.method === 'DELETE' ? new Response(null, {status:204}) : new Response(listing([PATH, published]));
  }) as typeof fetch);
  const grant = await store.createPlaybackUrl(published, 300000);
  assert.ok(new URL(grant.url).pathname.endsWith(published));
  assert.equal(await store.exists(published), true);
  assert.equal(await store.sizeOf(published), 24);
  assert.equal(await store.removeAllForOwner('alice'), 2);
  assert.equal(requests.filter(r => r.method === 'DELETE').length, 2);
  for (const path of [`${PATH}/published/bad`, `${published}/extra`, `${PATH}/elsewhere/12345678-1234-1234-1234-123456789abc`]) {
    await assert.rejects(store.createPlaybackUrl(path, 1000), /path/);
  }
});
