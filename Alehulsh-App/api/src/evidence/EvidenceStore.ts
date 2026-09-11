/**
 * Swap point #5. See docs/api-layer.md.  (P2-10.1)
 *
 * Firebase Storage now; MinIO or a local S3-compatible provider at M-06, where
 * the objects must also come to rest in Ethiopia — Art 2(5) makes a recording
 * of someone's voice sensitive personal data, and Art 22(3) requires prior
 * Authority approval to hold it abroad. Nothing above this interface knows
 * which vendor is behind it.
 */
export interface UploadTicket {
  /** Where the object will live. The client never chooses this. */
  storagePath: string;
  /** Short-lived, single-object, write-only. */
  url: string;
  expiresAt: Date;
  /** The client must send exactly this, and the signature enforces it. */
  contentType: string;
}

export interface EvidenceStore {
  /**
   * A URL the client can PUT one object to, and nothing else.
   *
   * The path is server-chosen on purpose. If the client named it, it could
   * name someone else's and overwrite her evidence — which is CRIT-04 again,
   * moved from Firestore to the bucket.
   */
  createUploadTicket(input: {
    ownerUid: string;
    alertId: string;
    evidenceId: string;
    contentType: string;
  }): Promise<UploadTicket>;

  /** Short-lived read URL. Never a permanent or public one. */
  createPlaybackUrl(storagePath: string, ttlMs: number): Promise<{ url: string; expiresAt: Date }>;

  /** True once the client has actually finished the PUT. */
  exists(storagePath: string): Promise<boolean>;

  /** Size in bytes, for recording metadata we did not have to trust. */
  sizeOf(storagePath: string): Promise<number | null>;

  remove(storagePath: string): Promise<void>;

  /** C-16. Everything under this owner's prefix. Returns how many objects went. */
  removeAllForOwner(ownerUid: string): Promise<number>;
}

/**
 * Object layout: evidence/{ownerUid}/{alertId}/{evidenceId}
 *
 * Owner-first so deletion is a prefix operation rather than a query — the one
 * shape that cannot miss an object because an index was stale.
 */
export function storagePathFor(ownerUid: string, alertId: string, evidenceId: string): string {
  return `evidence/${ownerUid}/${alertId}/${evidenceId}`;
}

/** The only formats the recorder produces. An allowlist, never a passthrough. */
export const ALLOWED_CONTENT_TYPES = ['audio/aac', 'audio/mp4', 'audio/mpeg'] as const;

export function isAllowedContentType(t: string): boolean {
  return (ALLOWED_CONTENT_TYPES as readonly string[]).includes(t);
}
