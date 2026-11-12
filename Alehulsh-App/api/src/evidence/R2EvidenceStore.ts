import { R2ImmutablePublisher, type PublicationBucket } from './R2ImmutablePublisher.js';
import { AwsClient } from 'aws4fetch';
import {
  isAllowedContentType, storagePathFor, type EvidenceStore, type UploadTicket,
} from './EvidenceStore.js';

/**
 * Evidence objects in Cloudflare R2.  (M-06)
 *
 * Replaces FirebaseStorageEvidenceStore behind the same interface, so nothing
 * above it changes. R2 speaks the S3 API, which is what makes this a signing
 * problem rather than an SDK problem.
 *
 * WHY aws4fetch AND NOT THE AWS SDK. SigV4 presigning is HMAC-SHA256
 * composition over a canonical request, and CLAUDE.md §12 is clear that we do
 * not hand-roll cryptography - a mis-built canonical request does not fail
 * loudly, it produces a URL that grants the wrong thing. aws4fetch is 65 KB
 * with ZERO transitive dependencies, signs via WebCrypto, and therefore runs
 * unchanged in a Cloudflare Worker. `@aws-sdk/client-s3` would work on Node but
 * drags in a large dependency tree for one signature.
 *
 * Upload and playback go directly between the client and R2 using narrowly
 * signed URLs. Trusted finalization separately streams a bounded snapshot
 * through the native R2 binding to hash and freeze it at a server-only key.
 * That copy incurs Worker CPU and R2 read/write/storage costs; it is not a
 * metadata-only operation. Staging/orphan cleanup needs a reviewed lifecycle.
 *
 * NOT VERIFIED AGAINST REAL R2. Tested against a local S3-compatible service.
 * See the test file for exactly what that does and does not prove.
 */
export interface R2Config {
  /**
   * Full endpoint, e.g. `https://<accountId>.r2.cloudflarestorage.com`.
   * Taken whole rather than built from an account id so the same class can be
   * pointed at a local S3-compatible server in tests without a special case.
   */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** R2 ignores region but SigV4 requires one; R2's documented value is `auto`. */
  region?: string;
}

/** Fifteen minutes: enough for a slow upload, short enough not to be a grant. */
const UPLOAD_TTL_MS = 15 * 60 * 1000;

/** One ListObjectsV2 page. The S3 maximum, so fewer round trips per sweep. */
const LIST_PAGE_SIZE = 1000;

// SigV4 query signatures support at most seven days. Product routes request
// much shorter lifetimes; this is the protocol ceiling, not a new policy.
const MAX_SIGNED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function assertSegment(segment: string): void {
  if (!segment || segment === '.' || segment === '..' || /[/\\\u0000-\u001f\u007f]/.test(segment)) {
    throw new Error('invalid evidence path segment');
  }
}

export class R2EvidenceStore implements EvidenceStore {
  private readonly client: AwsClient;
  private readonly base: string;

  constructor(
    private readonly config: R2Config,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly publicationBucket?: PublicationBucket,
  ) {
    if (!config.endpoint || !config.bucket) {
      // Fail at construction, not on the first upload during an emergency.
      throw new Error('R2EvidenceStore requires an endpoint and a bucket');
    }
    if (!config.accessKeyId || !config.secretAccessKey) {
      throw new Error('R2EvidenceStore requires credentials');
    }
    assertSegment(config.bucket);
    const endpoint = new URL(config.endpoint);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
    if ((endpoint.protocol !== 'https:' && !(loopback && endpoint.protocol === 'http:'))
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || !/^\/*$/.test(endpoint.pathname)) {
      throw new Error('R2 endpoint must be an HTTPS origin (HTTP only for loopback tests)');
    }
    this.client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: 's3',
      region: config.region ?? 'auto',
    });
    this.base = `${endpoint.origin}/${encodeURIComponent(config.bucket)}`;
  }

  async publish(path: string, contentType: string) {
    if (!this.publicationBucket) throw new Error('native R2 publication binding required');
    return new R2ImmutablePublisher(this.publicationBucket).publish(path,contentType);
  }

  private objectUrl(storagePath: string): string {
    const segments = storagePath.split('/');
    if ((segments.length !== 4 && !(segments.length === 6 && segments[4] === 'published'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segments[5]!)))
      || segments[0] !== 'evidence') {
      throw new Error('invalid evidence storage path');
    }
    segments.forEach(assertSegment);
    // Each segment encoded separately: the path separators are structural and
    // must NOT be escaped, while anything inside a segment must be.
    const encoded = segments.map(encodeURIComponent).join('/');
    return `${this.base}/${encoded}`;
  }

  /**
   * A URL that can PUT exactly one object, of exactly one content type.
   *
   * `content-type` is a SIGNED header, not a hint: it appears in
   * X-Amz-SignedHeaders, so a client that sends a different type produces a
   * signature mismatch and R2 refuses the write. Without that binding the
   * ticket would accept any payload at that path - a video, an executable -
   * under a path the server vouched for.
   *
   * The path comes from storagePathFor and never from the caller, so a client
   * cannot aim a ticket at another woman's evidence.
   */
  async createUploadTicket(input: {
    ownerUid: string; alertId: string; evidenceId: string; contentType: string;
  }): Promise<UploadTicket> {
    [input.ownerUid, input.alertId, input.evidenceId].forEach(assertSegment);
    if (!isAllowedContentType(input.contentType)) throw new Error('unsupported evidence content type');
    const storagePath = storagePathFor(input.ownerUid, input.alertId, input.evidenceId);
    const signed = await this.signedUrlWithExpiry(storagePath, 'PUT', UPLOAD_TTL_MS, input.contentType);

    return {
      storagePath,
      ...signed,
      contentType: input.contentType,
    };
  }

  /** Short-lived read URL. Never permanent, never public. */
  async createPlaybackUrl(storagePath: string, ttlMs: number) {
    return this.signedUrlWithExpiry(storagePath, 'GET', ttlMs);
  }

  /**
   * Sign with the expiry inside the signature.
   *
   * X-Amz-Expires must be signed, so it is set BEFORE signing. Appending it
   * afterwards would leave a URL whose stated lifetime is not the one the
   * signature enforces.
   */
  private async signedUrlWithExpiry(
    storagePath: string,
    method: 'GET' | 'PUT',
    ttlMs: number,
    contentType?: string,
  ): Promise<{ url: string; expiresAt: Date }> {
    if (!Number.isFinite(ttlMs) || ttlMs < 1000 || ttlMs > MAX_SIGNED_TTL_MS) {
      throw new Error('signed URL ttl must be positive, at least one second and at most seven days');
    }
    const seconds = Math.floor(ttlMs / 1000);
    const issuedAt = Math.floor(Date.now() / 1000) * 1000;
    const url = new URL(this.objectUrl(storagePath));
    url.searchParams.set('X-Amz-Expires', String(seconds));

    const signed = await this.client.sign(url.toString(), {
      method,
      ...(contentType ? { headers: { 'content-type': contentType } } : {}),
      aws: {
        datetime: new Date(issuedAt).toISOString().replace(/[:-]|\.\d{3}/g, ''),
        signQuery: true,
        // allHeaders is REQUIRED for the content-type binding to exist. By
        // default aws4fetch signs only `host` when presigning, which leaves
        // content-type an unsigned hint - and a ticket that does not sign it
        // accepts ANY payload at a path the server vouched for: a video, an
        // executable, anything. Caught by a test asserting
        // X-Amz-SignedHeaders, after the first version silently dropped the
        // binding the Firebase implementation had.
        ...(contentType ? { allHeaders: true } : {}),
      },
    });
    return { url: signed.url, expiresAt: new Date(issuedAt + seconds * 1000) };
  }

  /**
   * True once the object is really there.
   *
   * 404 is false. ANY OTHER FAILURE THROWS - a 403 from a rotated credential
   * must not be reported as "she never finished the upload", because the
   * caller would then record her evidence as missing and move on. Same
   * discipline as the malformed-id guards: never convert an outage into a
   * negative answer.
   */
  async exists(storagePath: string): Promise<boolean> {
    const res = await this.send(storagePath, 'HEAD');
    if (res.status === 404) return false;
    if (res.ok) return true;
    throw new Error(`R2 HEAD failed with ${res.status}`);
  }

  /**
   * Size from the object's own metadata, so it is not a number the client told
   * us. Null only when the object is absent or R2 omitted the header.
   */
  async sizeOf(storagePath: string): Promise<number | null> {
    const res = await this.send(storagePath, 'HEAD');
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`R2 HEAD failed with ${res.status}`);

    const raw = res.headers.get('content-length');
    if (raw === null) return null;
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
      throw new Error('R2 HEAD returned an invalid content length');
    }
    return Number(raw);
  }

  /** Idempotent: deleting an absent object is success, as S3 defines it. */
  async remove(storagePath: string): Promise<void> {
    const res = await this.send(storagePath, 'DELETE');
    // S3 returns 204 whether or not the key existed. 404 is tolerated for
    // implementations that report it.
    if (!res.ok && res.status !== 404) {
      throw new Error(`R2 DELETE failed with ${res.status}`);
    }
  }

  /**
   * Everything under one owner's prefix.  (C-16, her right to erasure)
   *
   * Driven from the BUCKET, not from the database: if the two disagree, the
   * bucket is the one holding her voice. Paginated, because a truncated first
   * page would silently leave recordings behind and report success - the worst
   * possible outcome for a deletion request.
   */
  async removeAllForOwner(ownerUid: string): Promise<number> {
    assertSegment(ownerUid);
    const prefix = `evidence/${ownerUid}/`;
    let token: string | undefined;
    let removed = 0;
    const seenTokens = new Set<string>();

    do {
      const page = await this.listPage(prefix, token);
      if (page.nextToken !== undefined) {
        if (seenTokens.has(page.nextToken)) throw new Error('R2 list repeated a continuation token');
        seenTokens.add(page.nextToken);
      }
      for (const key of page.keys) {
        await this.remove(key);
        removed += 1;
      }
      token = page.nextToken;
    } while (token !== undefined);

    return removed;
  }

  /** One ListObjectsV2 page. XML parsed by extraction, not by a DOM. */
  private async listPage(
    prefix: string,
    token: string | undefined,
  ): Promise<{ keys: string[]; nextToken: string | undefined }> {
    const url = new URL(this.base);
    url.searchParams.set('list-type', '2');
    url.searchParams.set('prefix', prefix);
    url.searchParams.set('max-keys', String(LIST_PAGE_SIZE));
    if (token !== undefined) url.searchParams.set('continuation-token', token);

    const signed = await this.client.sign(url.toString(), { method: 'GET' });
    const res = await this.fetchImpl(signed);
    if (!res.ok) throw new Error(`R2 list failed with ${res.status}`);

    const xml = await res.text();
    // A 200 error payload or incomplete XML must not masquerade as an empty
    // bucket and complete an erasure request. Fail before deleting this page.
    const truncation = /<IsTruncated>\s*(true|false)\s*<\/IsTruncated>/.exec(xml);
    if (!/<ListBucketResult(?:\s[^>]*)?>/.test(xml) || !/<\/ListBucketResult>\s*$/.test(xml)
      || !truncation || /<Error(?:\s|>)/.test(xml)) {
      throw new Error('R2 list returned an invalid listing');
    }
    // <Key> may contain XML-escaped characters; decode the five predefined
    // entities. A key is a path we wrote, so nothing exotic is expected, but a
    // wrongly-decoded key would mean a delete that misses.
    const keys = [...xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)]
      .map((m) => decodeXmlText(m[1] ?? ''))
      .filter((k) => k.length > 0);

    for (const key of keys) {
      if (!key.startsWith(prefix)) throw new Error('R2 list returned an object outside the owner prefix');
      this.objectUrl(key);
    }

    const truncated = truncation[1] === 'true';
    const next = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml);
    if (truncated && !next?.[1]) {
      throw new Error('R2 list truncated without a continuation token');
    }

    return {
      keys,
      nextToken: truncated && next?.[1] ? decodeXmlText(next[1]) : undefined,
    };
  }

  private async send(storagePath: string, method: 'HEAD' | 'DELETE'): Promise<Response> {
    const signed = await this.client.sign(this.objectUrl(storagePath), { method });
    return this.fetchImpl(signed);
  }
}

function decodeXmlText(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
