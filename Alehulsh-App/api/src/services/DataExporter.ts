import type {
  AlertRepository, ContactRepository, EvidenceRepository, UserRepository,
} from '../repositories/types.js';
import type { EvidenceStore } from '../evidence/EvidenceStore.js';
import type { Logger } from '../logger.js';

/**
 * Everything we hold about one person, assembled for her.  (P2-21 · C-16 Art 24-32)
 *
 * Not a compliance checkbox. This is how a survivor obtains her own evidence
 * for a protection order or a prosecution, which makes completeness and
 * usefulness product requirements, not legal ones.
 *
 * TWO THINGS THE CALLER MUST UNDERSTAND, both stated in the payload itself
 * rather than only here:
 *
 * 1. There is no alert history to export. The alert document is keyed by the
 *    owner's uid, so each SOS overwrites the last one. For a woman in a
 *    repeated-abuse situation — the primary user of this app — that is exactly
 *    the pattern of evidence that matters most, and it is the pattern the
 *    schema destroys. It is recorded here as a known gap so an export can
 *    never be mistaken for a complete record. Fixed properly at M-05, where
 *    one row per alert is the natural shape.
 *
 * 2. Recordings are referenced by expiring URL, not embedded. A permanent link
 *    inside an exported file would be a standing grant to the most sensitive
 *    data we hold, surviving in whatever inbox or cloud drive the file lands
 *    in (CLAUDE.md §11).
 */
export interface DataExport {
  exportedAt: string;
  uid: string;
  profile: { safetyKeywordSet: boolean; mustSetKeyword: boolean };
  emergencyContacts: Array<{ name: string; isPrimary: boolean; reachable: boolean }>;
  currentAlert: {
    id: string; status: string; createdAt: string; expiresAt: string;
    hasLocation: boolean; latitude: number | null; longitude: number | null;
    resolvedAt: string | null; escalatedAt: string | null;
    escalationReason: string | null; failedKeywordAttempts: number;
  } | null;
  evidence: Array<{
    id: string; alertId: string; contentType: string;
    sizeBytes: number | null; durationMs: number | null;
    createdAt: string; uploaded: boolean;
    downloadUrl: string | null; downloadUrlExpiresAt: string | null;
  }>;
  /** Stated limits of this export. Never omitted, never empty by accident. */
  knownGaps: string[];
}

const DOWNLOAD_TTL_MS = 60 * 60 * 1000;

export class DataExporter {
  constructor(
    private readonly users: UserRepository,
    private readonly alerts: AlertRepository,
    private readonly contacts: ContactRepository,
    private readonly evidence: EvidenceRepository,
    private readonly evidenceStore: EvidenceStore,
    private readonly logger: Logger,
  ) {}

  async exportFor(uid: string): Promise<DataExport> {
    const [user, alert, contacts, evidence] = await Promise.all([
      this.users.findByUid(uid),
      this.alerts.findById(uid),
      this.contacts.listByOwner(uid),
      this.evidence.listForOwner(uid),
    ]);

    const items = await Promise.all(evidence.map(async (e) => {
      // An hour: long enough to download a recording on a poor connection,
      // short enough that the exported file is not itself a lasting key.
      const link = e.uploaded
        ? await this.evidenceStore.createPlaybackUrl(e.storagePath, DOWNLOAD_TTL_MS)
        : null;
      return {
        id: e.id,
        alertId: e.alertId,
        contentType: e.contentType,
        sizeBytes: e.sizeBytes,
        durationMs: e.durationMs,
        createdAt: e.createdAt.toISOString(),
        uploaded: e.uploaded,
        downloadUrl: link?.url ?? null,
        downloadUrlExpiresAt: link?.expiresAt.toISOString() ?? null,
      };
    }));

    const knownGaps = [
      'Alert history is not included. Only the most recent alert is stored: '
      + 'each new SOS replaces the previous one. Earlier alerts cannot be recovered.',
    ];
    const notUploaded = evidence.filter((e) => !e.uploaded).length;
    if (notUploaded > 0) {
      // Named rather than quietly dropped. A recording that never finished
      // uploading is exactly the thing she would otherwise assume she had.
      knownGaps.push(
        `${notUploaded} recording(s) were started but never finished uploading, `
        + 'and no audio exists for them.',
      );
    }

    // The uid is logged, not the contents. An export is a significant event —
    // it is the moment all of someone's data exists in one place.
    this.logger.info('data export generated', {
      subject: uid,
      contacts: contacts.length,
      evidenceItems: items.length,
      hasCurrentAlert: alert !== null,
    });

    return {
      exportedAt: new Date().toISOString(),
      uid,
      profile: {
        // Never the hash, and obviously never the keyword. Whether one is set
        // is the only part that is hers to know from this.
        safetyKeywordSet: Boolean(user?.safetyKeywordHash),
        mustSetKeyword: user?.mustSetKeyword ?? false,
      },
      emergencyContacts: contacts.map((c) => ({
        name: c.name,
        isPrimary: c.isPrimary,
        // Whether we could reach them, without re-exposing the hashes.
        reachable: Boolean(c.phoneHash ?? c.emailHash),
      })),
      currentAlert: alert && alert.ownerId === uid ? {
        id: alert.id,
        status: alert.status,
        createdAt: alert.createdAt.toISOString(),
        expiresAt: alert.expiresAt.toISOString(),
        hasLocation: alert.latitude !== null,
        latitude: alert.latitude,
        longitude: alert.longitude,
        resolvedAt: alert.resolvedAt?.toISOString() ?? null,
        escalatedAt: alert.escalatedAt?.toISOString() ?? null,
        escalationReason: alert.escalationReason ?? null,
        // A cluster of these is itself evidence of coercion.
        failedKeywordAttempts: alert.attemptCount,
      } : null,
      evidence: items,
      knownGaps,
    };
  }
}
