import {
  storagePathFor, type EvidenceStore, type UploadTicket,
} from './EvidenceStore.js';

/**
 * Interim implementation. Replaced at M-06 by in-country S3-compatible
 * storage — a recording of someone's voice is sensitive personal data under
 * Art 2(5) and must come to rest in Ethiopia.
 *
 * Signing requires the service account to have iam.serviceAccounts.signBlob
 * (roles/iam.serviceAccountTokenCreator). Without it every signed URL call
 * throws at request time rather than at startup, which is worth knowing before
 * the first upload rather than during one.
 */
/**
 * Only the handful of bucket methods this class uses.
 *
 * Declared structurally rather than imported from @google-cloud/storage: that
 * package ships dual ESM and CJS type trees, firebase-admin hands back the CJS
 * one, and importing the ESM one makes them non-assignable under
 * exactOptionalPropertyTypes. It is also a transitive dependency we would
 * rather not name directly, since it disappears entirely at M-06.
 */
interface SignedUrlConfig {
  version: 'v4';
  action: 'read' | 'write';
  expires: Date;
  contentType?: string;
}

interface FileLike {
  getSignedUrl(cfg: SignedUrlConfig): Promise<[string]>;
  exists(): Promise<[boolean]>;
  /** The real call resolves to [metadata, apiResponse]. */
  getMetadata(): Promise<[{ size?: string | number }, ...unknown[]]>;
  delete(opts?: { ignoreNotFound?: boolean }): Promise<unknown>;
}

export interface BucketLike {
  file(path: string): FileLike;
  /** The real call resolves to [files, nextQuery, apiResponse]. */
  getFiles(opts: { prefix: string }): Promise<[FileLike[], ...unknown[]]>;
}

export class FirebaseStorageEvidenceStore implements EvidenceStore {
  constructor(private readonly bucket: BucketLike) {}

  async createUploadTicket(input: {
    ownerUid: string; alertId: string; evidenceId: string; contentType: string;
  }): Promise<UploadTicket> {
    const storagePath = storagePathFor(input.ownerUid, input.alertId, input.evidenceId);
    // Fifteen minutes: long enough for a slow upload on a poor connection,
    // short enough that a leaked URL is not a standing grant.
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    const [url] = await this.bucket.file(storagePath).getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: expiresAt,
      // Binds the signature to the declared type. Without this the ticket
      // would accept any payload at that path.
      contentType: input.contentType,
    });

    return { storagePath, url, expiresAt, contentType: input.contentType };
  }

  async createPlaybackUrl(storagePath: string, ttlMs: number) {
    const expiresAt = new Date(Date.now() + ttlMs);
    const [url] = await this.bucket.file(storagePath).getSignedUrl({
      version: 'v4', action: 'read', expires: expiresAt,
    });
    return { url, expiresAt };
  }

  async exists(storagePath: string): Promise<boolean> {
    const [ok] = await this.bucket.file(storagePath).exists();
    return ok;
  }

  async sizeOf(storagePath: string): Promise<number | null> {
    try {
      const [meta] = await this.bucket.file(storagePath).getMetadata();
      const size = meta.size;
      return size === undefined ? null : Number(size);
    } catch {
      return null;
    }
  }

  async remove(storagePath: string): Promise<void> {
    await this.bucket.file(storagePath).delete({ ignoreNotFound: true });
  }

  async removeAllForOwner(ownerUid: string): Promise<number> {
    // Prefix delete, not a query over metadata. If the database and the bucket
    // ever disagree, the bucket is the one holding her voice, so the bucket is
    // what deletion must be driven from.
    const [files] = await this.bucket.getFiles({ prefix: `evidence/${ownerUid}/` });
    await Promise.all(files.map((f) => f.delete({ ignoreNotFound: true })));
    return files.length;
  }
}
