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
 * 1. Alert history IS included, newest first, and it is the part that does the
 *    work. A single incident proves little; six over four months is a course
 *    of conduct, which is what a protection order rests on. Each alert lists
 *    the recordings belonging to it.
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
  /**
   * Every alert she has raised, newest first.  (P2-22)
   *
   * A single incident proves little. Six over four months is a course of
   * conduct, and that is what a protection order rests on — so this is the
   * part of the export that does the work.
   */
  alerts: Array<{
    key: string; status: string; createdAt: string; expiresAt: string;
    hasLocation: boolean; latitude: number | null; longitude: number | null;
    resolvedAt: string | null; escalatedAt: string | null;
    escalationReason: string | null; failedKeywordAttempts: number;
    /** Recordings belonging to this alert, by alertKey. */
    evidenceIds: string[];
  }>;
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
    const [user, history, contacts, evidence] = await Promise.all([
      this.users.findByUid(uid),
      this.alerts.listHistoryForOwner(uid),
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

    const knownGaps: string[] = [];
    // Recordings made before alert keys existed carry the owner's uid as their
    // key, so they cannot be tied to one incident. Said plainly rather than
    // attached to the wrong alert.
    const unattributed = evidence.filter((e) => e.alertKey === uid).length;
    if (unattributed > 0) {
      knownGaps.push(
        `${unattributed} recording(s) predate per-alert identifiers and cannot be `
        + 'attributed to a specific incident. They are listed under evidence.',
      );
    }
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
      alerts: history.length,
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
      alerts: history.map((a) => ({
        key: a.key,
        status: a.status,
        createdAt: a.createdAt.toISOString(),
        expiresAt: a.expiresAt.toISOString(),
        hasLocation: a.latitude !== null,
        latitude: a.latitude,
        longitude: a.longitude,
        resolvedAt: a.resolvedAt?.toISOString() ?? null,
        escalatedAt: a.escalatedAt?.toISOString() ?? null,
        escalationReason: a.escalationReason ?? null,
        // A cluster of these is itself evidence of coercion.
        failedKeywordAttempts: a.attemptCount,
        evidenceIds: evidence.filter((e) => e.alertKey === a.key).map((e) => e.id),
      })),
      evidence: items,
      knownGaps,
    };
  }
}
