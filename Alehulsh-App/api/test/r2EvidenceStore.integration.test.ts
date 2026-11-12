/**
 * R2EvidenceStore against a real S3-compatible service.  (M-06)
 *
 * WHAT THIS PROVES: that the adapter speaks the S3 API correctly end to end -
 * a presigned PUT that a plain HTTP client can complete, HEAD, size, a
 * presigned GET that returns the bytes, delete, prefix deletion with
 * pagination, and owner isolation.
 *
 * WHAT IT DOES NOT PROVE, stated plainly: the local service is Adobe S3Mock,
 * which does NOT verify SigV4 signatures. So these tests cannot show that a
 * tampered URL is refused, that the content-type binding is ENFORCED, or that
 * an expired URL stops working. What they do show is that the URL carries a
 * well-formed SigV4 presignature with the right signed headers - the mechanism
 * by which R2 enforces those things. Enforcement itself needs a real R2
 * bucket, which needs Cloudflare credentials.
 *
 * Synthetic data only. No Cloudflare account is contacted.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { R2EvidenceStore } from '../src/evidence/R2EvidenceStore.js';
import { storagePathFor } from '../src/evidence/EvidenceStore.js';

const ENDPOINT = process.env['S3_TEST_ENDPOINT'] ?? 'http://127.0.0.1:9090';
const BUCKET = 'alehulsh-evidence-dev';

/** Throwaway credentials for a loopback mock. NOT a secret, never reused. */
const CREDS = { accessKeyId: 'test-access-key', secretAccessKey: 'test-secret-key' };

let store: R2EvidenceStore;
let available = false;
let skipReason = '';

const OWNER = `u${randomUUID().replace(/-/g, '').slice(0, 20)}`;
const OTHER = `o${randomUUID().replace(/-/g, '').slice(0, 20)}`;
const ALERT = `a${randomUUID().replace(/-/g, '').slice(0, 20)}`;

before(async () => {
  try {
    const ping = await fetch(`${ENDPOINT}/`, { signal: AbortSignal.timeout(2000) });
    if (!ping.ok) { skipReason = `S3-compatible service at ${ENDPOINT} returned ${ping.status}`; return; }
    // Idempotent: 200 whether or not it already existed.
    await fetch(`${ENDPOINT}/${BUCKET}`, { method: 'PUT' });
  } catch {
    skipReason = `no S3-compatible service reachable at ${ENDPOINT}`;
    return;
  }
  store = new R2EvidenceStore({ endpoint: ENDPOINT, bucket: BUCKET, ...CREDS });
  available = true;
});

after(async () => {
  if (!available) return;
  // Leave the mock as we found it.
  for (const uid of [OWNER, OTHER]) await store.removeAllForOwner(uid);
});

function stest(name: string, fn: () => Promise<void>): void {
  test(name, async (t) => {
    if (!available) { t.skip(skipReason); return; }
    await fn();
  });
}

/** Complete an upload the way a mobile client would: a plain PUT, no SDK. */
async function putViaTicket(url: string, contentType: string, body: string): Promise<Response> {
  return fetch(url, { method: 'PUT', headers: { 'content-type': contentType }, body });
}

describe('the upload ticket', () => {
  stest('a client can complete the PUT, and the object is then really there', async () => {
    const evidenceId = `e${randomUUID()}`;
    const ticket = await store.createUploadTicket({
      ownerUid: OWNER, alertId: ALERT, evidenceId, contentType: 'audio/aac',
    });

    assert.equal(ticket.storagePath, storagePathFor(OWNER, ALERT, evidenceId));
    assert.equal(ticket.contentType, 'audio/aac');
    assert.ok(ticket.expiresAt.getTime() > Date.now());

    // Before: nothing. This is what `exists` is for - confirming she finished.
    assert.equal(await store.exists(ticket.storagePath), false);

    const put = await putViaTicket(ticket.url, 'audio/aac', 'synthetic-audio-bytes');
    assert.ok(put.ok, `the presigned PUT failed with ${put.status}`);

    assert.equal(await store.exists(ticket.storagePath), true);
    assert.equal(await store.sizeOf(ticket.storagePath), 'synthetic-audio-bytes'.length);
  });

  stest('the path is server-chosen — a caller cannot aim it elsewhere', async () => {
    // The only inputs are owner/alert/evidence ids; there is no path parameter
    // to point at another woman's evidence.
    const t1 = await store.createUploadTicket({
      ownerUid: OWNER, alertId: ALERT, evidenceId: 'x1', contentType: 'audio/aac',
    });
    assert.ok(t1.storagePath.startsWith(`evidence/${OWNER}/`));
    assert.ok(!t1.storagePath.includes('..'));
  });

  stest('the ticket is a well-formed SigV4 presignature bound to the content type', async () => {
    // S3Mock does not verify signatures, so this asserts the MECHANISM is
    // present and correct in shape — the part R2 would enforce.
    const ticket = await store.createUploadTicket({
      ownerUid: OWNER, alertId: ALERT, evidenceId: 'x2', contentType: 'audio/mp4',
    });
    const q = new URL(ticket.url).searchParams;

    assert.equal(q.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
    assert.match(q.get('X-Amz-Signature') ?? '', /^[0-9a-f]{64}$/);
    assert.ok(q.get('X-Amz-Credential')?.includes('test-access-key'));
    assert.match(q.get('X-Amz-Date') ?? '', /^\d{8}T\d{6}Z$/);
    // The expiry is INSIDE the signed query, not appended afterwards.
    assert.equal(q.get('X-Amz-Expires'), String(15 * 60));
    // content-type is a SIGNED header: a client sending a different type
    // produces a signature mismatch at R2.
    assert.ok(
      (q.get('X-Amz-SignedHeaders') ?? '').includes('content-type'),
      'content-type must be signed, or the ticket accepts any payload',
    );
    // The secret itself must never appear in a URL we hand out.
    assert.ok(!ticket.url.includes('test-secret-key'));
  });
});

describe('playback', () => {
  stest('a presigned GET returns the bytes, and is time-boxed', async () => {
    const evidenceId = `e${randomUUID()}`;
    const ticket = await store.createUploadTicket({
      ownerUid: OWNER, alertId: ALERT, evidenceId, contentType: 'audio/aac',
    });
    await putViaTicket(ticket.url, 'audio/aac', 'playback-bytes');

    const { url, expiresAt } = await store.createPlaybackUrl(ticket.storagePath, 60_000);
    const got = await fetch(url);
    assert.ok(got.ok);
    assert.equal(await got.text(), 'playback-bytes');

    assert.ok(expiresAt.getTime() > Date.now());
    assert.ok(expiresAt.getTime() <= Date.now() + 60_000);
    assert.equal(new URL(url).searchParams.get('X-Amz-Expires'), '60');
  });

  stest('a non-positive ttl is refused — no permanent URL can be minted', async () => {
    for (const ttl of [0, -1, -60_000]) {
      await assert.rejects(
        () => store.createPlaybackUrl(`evidence/${OWNER}/${ALERT}/nope`, ttl),
        /positive/,
      );
    }
  });
});

describe('absence and failure are different answers', () => {
  stest('a missing object is false / null, not an error', async () => {
    const missing = `evidence/${OWNER}/${ALERT}/does-not-exist`;
    assert.equal(await store.exists(missing), false);
    assert.equal(await store.sizeOf(missing), null);
  });

  stest('deleting an absent object succeeds — remove is idempotent', async () => {
    const path = `evidence/${OWNER}/${ALERT}/absent`;
    await store.remove(path);
    await store.remove(path);
  });

  stest('a 403 THROWS rather than reporting the upload as missing', async () => {
    // The defect this prevents: a rotated credential returns 403, `exists`
    // reads it as false, and her evidence is recorded as never uploaded.
    const denying = (async () => new Response('AccessDenied', { status: 403 })) as typeof fetch;
    const broken = new R2EvidenceStore(
      { endpoint: ENDPOINT, bucket: BUCKET, ...CREDS }, denying,
    );
    await assert.rejects(() => broken.exists('evidence/x/y/z'), /403/);
    await assert.rejects(() => broken.sizeOf('evidence/x/y/z'), /403/);
    await assert.rejects(() => broken.remove('evidence/x/y/z'), /403/);
  });

  stest('a 500 on list THROWS rather than reporting zero objects deleted', async () => {
    // Reporting 0 would let a deletion request be recorded as satisfied.
    const failing = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    const broken = new R2EvidenceStore(
      { endpoint: ENDPOINT, bucket: BUCKET, ...CREDS }, failing,
    );
    await assert.rejects(() => broken.removeAllForOwner('someone'), /list failed with 500/);
  });

  stest('construction fails closed on missing configuration', async () => {
    const base = { endpoint: ENDPOINT, bucket: BUCKET, ...CREDS };
    assert.throws(() => new R2EvidenceStore({ ...base, endpoint: '' }), /endpoint and a bucket/);
    assert.throws(() => new R2EvidenceStore({ ...base, bucket: '' }), /endpoint and a bucket/);
    assert.throws(() => new R2EvidenceStore({ ...base, accessKeyId: '' }), /credentials/);
    assert.throws(() => new R2EvidenceStore({ ...base, secretAccessKey: '' }), /credentials/);
  });
});

describe('erasure — removeAllForOwner', () => {
  stest('every object under her prefix goes, and the count is real', async () => {
    const ids = ['r1', 'r2', 'r3'];
    for (const id of ids) {
      const t = await store.createUploadTicket({
        ownerUid: OWNER, alertId: ALERT, evidenceId: id, contentType: 'audio/aac',
      });
      await putViaTicket(t.url, 'audio/aac', `bytes-${id}`);
    }

    const removed = await store.removeAllForOwner(OWNER);
    assert.ok(removed >= ids.length, `expected at least ${ids.length}, got ${removed}`);

    for (const id of ids) {
      assert.equal(
        await store.exists(storagePathFor(OWNER, ALERT, id)), false,
        `${id} survived erasure`,
      );
    }
  });

  stest('another owner’s evidence is untouched', async () => {
    const mine = await store.createUploadTicket({
      ownerUid: OWNER, alertId: ALERT, evidenceId: 'mine', contentType: 'audio/aac',
    });
    const theirs = await store.createUploadTicket({
      ownerUid: OTHER, alertId: ALERT, evidenceId: 'theirs', contentType: 'audio/aac',
    });
    await putViaTicket(mine.url, 'audio/aac', 'mine');
    await putViaTicket(theirs.url, 'audio/aac', 'theirs');

    await store.removeAllForOwner(OWNER);

    assert.equal(await store.exists(mine.storagePath), false);
    assert.equal(await store.exists(theirs.storagePath), true,
      'erasure must be scoped to one owner');
  });

  stest('a prefix is not a substring match', async () => {
    // `evidence/{uid}/` with the trailing slash: a uid that merely STARTS with
    // another uid must not be swept up with it.
    const sibling = `${OWNER}x`;
    const t = await store.createUploadTicket({
      ownerUid: sibling, alertId: ALERT, evidenceId: 's1', contentType: 'audio/aac',
    });
    await putViaTicket(t.url, 'audio/aac', 'sibling');
    try {
      await store.removeAllForOwner(OWNER);
      assert.equal(await store.exists(t.storagePath), true,
        `${sibling} must not be deleted by erasing ${OWNER}`);
    } finally {
      await store.removeAllForOwner(sibling);
    }
  });

  stest('it follows pagination instead of stopping at the first page', async () => {
    // Driven with a stub, because proving this against the mock would need
    // 1001 objects. A truncated page whose continuation is ignored means
    // recordings left behind while reporting success.
    const pages = [
      `<ListBucketResult><Key>evidence/p/a/1</Key><Key>evidence/p/a/2</Key>`
      + `<IsTruncated>true</IsTruncated><NextContinuationToken>TOKEN2</NextContinuationToken>`
      + `</ListBucketResult>`,
      `<ListBucketResult><Key>evidence/p/a/3</Key>`
      + `<IsTruncated>false</IsTruncated></ListBucketResult>`,
    ];
    const seenTokens: (string | null)[] = [];
    let listCalls = 0;
    const deleted: string[] = [];

    const stub = (async (input: Request | string | URL) => {
      const url = new URL(typeof input === 'string' ? input : 'url' in input ? input.url : String(input));
      const method = typeof input === 'object' && 'method' in input ? input.method : 'GET';
      if (url.searchParams.get('list-type') === '2') {
        seenTokens.push(url.searchParams.get('continuation-token'));
        const body = pages[Math.min(listCalls, pages.length - 1)] ?? '';
        listCalls += 1;
        return new Response(body, { status: 200 });
      }
      if (method === 'DELETE') {
        deleted.push(decodeURIComponent(url.pathname));
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const paged = new R2EvidenceStore(
      { endpoint: ENDPOINT, bucket: BUCKET, ...CREDS }, stub,
    );
    const removed = await paged.removeAllForOwner('p');

    assert.equal(removed, 3, 'all three objects across two pages');
    assert.equal(listCalls, 2);
    assert.deepEqual(seenTokens, [null, 'TOKEN2'], 'the continuation token must be sent');
    assert.equal(deleted.length, 3);
  });

  stest('a truncated page with no token does not loop forever', async () => {
    // A malformed response must fail erasure, not report partial success.
    const stub = (async (input: Request | string | URL) => {
      const url = new URL(typeof input === 'string' ? input : 'url' in input ? input.url : String(input));
      if (url.searchParams.get('list-type') === '2') {
        return new Response(
          '<ListBucketResult><Key>evidence/q/a/1</Key><IsTruncated>true</IsTruncated></ListBucketResult>',
          { status: 200 },
        );
      }
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const looping = new R2EvidenceStore(
      { endpoint: ENDPOINT, bucket: BUCKET, ...CREDS }, stub,
    );
    await assert.rejects(() => looping.removeAllForOwner('q'), /without a continuation token/);
  });

  stest('an empty prefix deletes nothing and reports zero', async () => {
    assert.equal(await store.removeAllForOwner(`nobody${randomUUID()}`), 0);
  });
});
