import { AppError } from '../errors.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { isAllowedContentType, type PublishedEvidence } from './EvidenceStore.js';

/** Minimal native R2 binding; no account API, public URL or S3 secret needed. */
export interface PublicationBucket {
  get(key: string): Promise<{
    body: ReadableStream<Uint8Array>; size: number;
    httpMetadata?: { contentType?: string; }
    ;
} | null>;
  put(key: string, body: ReadableStream<Uint8Array>, options: {
    onlyIf: { etagDoesNotMatch: string; }; httpMetadata: { contentType: string; };
  }): Promise<unknown | null>;
  delete(key: string): Promise<unknown>;
}
const LIMIT = 100 * 1024 * 1024;

/** A fresh server-only key plus conditional create prevents later PUT-ticket overwrites. */
export class R2ImmutablePublisher {
  constructor(private readonly bucket: PublicationBucket) { }
  async publish(source: string, contentType: string): Promise<PublishedEvidence> {
    if (!isAllowedContentType(contentType) || !/^evidence\/[^/]+\/[^/]+\/[^/]+$/.test(source)) throw Error('invalid staging evidence');
    const object = await this.bucket.get(source);
    if (!object) throw new AppError('not_found');
    if (object.size < 1 || object.size > LIMIT || object.httpMetadata?.contentType !== contentType) {
      await object.body.cancel(); throw Error('evidence metadata invalid');
    }
    const destination = `${source}/published/${crypto.randomUUID()}`;
    const hash = sha256.create(); let size = 0;
    const measured = object.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) { size += chunk.byteLength; if (size > LIMIT) throw Error('evidence too large'); hash.update(chunk); controller.enqueue(chunk); },
      flush() { if (size !== object.size || size < 1) throw Error('incomplete evidence snapshot'); },
    }));
    // Native R2 requires a stream whose length is known by the runtime. A
    // TransformStream loses the source body's length annotation, so preserve
    // bounded streaming through Workers' FixedLengthStream instead of buffering.
    const FixedLength = (globalThis as typeof globalThis & {
      FixedLengthStream?: new (length: number) => { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array>; };
    }).FixedLengthStream;
    const fixed = FixedLength ? new FixedLength(object.size) : undefined;
    const abort = new AbortController();
    const pump = fixed ? measured.pipeTo(fixed.writable, { signal: abort.signal }) : undefined;
    // Attach a rejection observer before awaiting R2; the put and pump fail as
    // one operation, including a stream that ends before its advertised size.
    void pump?.catch(() => { });
    try {
      const stored = await this.bucket.put(destination, fixed?.readable ?? measured, {
        onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType },
      });
      if (stored === null) throw Error('immutable destination already exists');
      await pump;
      return {
        storagePath: destination, sizeBytes: size,
        sha256: Array.from(hash.digest()).map(x => x.toString(16).padStart(2, '0')).join('')
      };
    } finally {
      if (fixed) {
        // A failed precondition may leave the body unread. Cancel it so the
        // measuring pump cannot wait forever on backpressure.
        try { await fixed.readable.cancel(); } catch { /* R2 may own its reader. */ }
        abort.abort();
        await pump?.catch(() => { });
      }
      // Never delete on a conditional conflict or an ambiguous storage result.
      // Private candidates remain within the owner's erasure prefix.
    }
  }
}
