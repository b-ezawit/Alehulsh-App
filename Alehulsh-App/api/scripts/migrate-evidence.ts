/**
 * P2-10.5 — retire base64 audio embedded in alert documents.
 *
 * audio_recording_service.dart:63 returns `data:audio/aac;base64,...` and that
 * string is stored in the alert's `voiceNotes` array. Two reasons it cannot
 * simply be left alone:
 *
 *   it is sensitive personal data (Art 2(5)) sitting in a document, counted
 *     against a 1MiB limit that silently failed writes past ~90 seconds;
 *   nothing can read it once the client stops producing that shape.
 *
 * WHAT THIS DOES NOT DO: it does not move the bytes into object storage.
 * Re-uploading someone's recording server-side means decoding it, writing it
 * somewhere new, and being certain the new copy is good before destroying the
 * only one that exists — with no way to ask her whether she still wants it.
 * That is a decision for Meron, not a default in a script.
 *
 * So this runs in two explicit modes:
 *
 *   --report   counts what exists and how large it is. Changes nothing.
 *   --migrate  decodes each note, uploads it, verifies the object is present
 *              and the right size, records it, and only then strips the base64.
 *
 * Anything that fails verification is left exactly as it was and named in the
 * summary. Losing a recording of an assault is not an acceptable failure mode
 * for a cleanup script.
 */
import { randomUUID } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import type { EvidenceRepository } from '../src/repositories/types.js';
import type { EvidenceStore } from '../src/evidence/EvidenceStore.js';
import type { Logger } from '../src/logger.js';

const DATA_URI = /^data:(audio\/[a-z0-9.+-]+);base64,(.+)$/i;

export interface MigrationSummary {
  alertsScanned: number;
  notesFound: number;
  bytesEmbedded: number;
  migrated: number;
  /** Left untouched, with the reason. Never silently dropped. */
  failed: Array<{ alertId: string; noteIndex: number; reason: string }>;
  dryRun: boolean;
}

interface VoiceNote {
  id?: string;
  audioData?: string;
  duration?: string;
  [k: string]: unknown;
}

export async function migrateEmbeddedAudio(deps: {
  db: Firestore;
  evidence: EvidenceRepository;
  store: EvidenceStore;
  logger: Logger;
  dryRun: boolean;
}): Promise<MigrationSummary> {
  const summary: MigrationSummary = {
    alertsScanned: 0, notesFound: 0, bytesEmbedded: 0,
    migrated: 0, failed: [], dryRun: deps.dryRun,
  };

  const snap = await deps.db.collection('active_alerts').get();

  for (const docSnap of snap.docs) {
    summary.alertsScanned++;
    const data = docSnap.data();
    const notes = Array.isArray(data['voiceNotes']) ? (data['voiceNotes'] as VoiceNote[]) : [];
    if (notes.length === 0) continue;

    const ownerUid = typeof data['userId'] === 'string' ? data['userId'] : docSnap.id;
    const keptNotes: VoiceNote[] = [];
    let changed = false;

    for (const [index, note] of notes.entries()) {
      const match = typeof note.audioData === 'string' ? DATA_URI.exec(note.audioData) : null;
      if (!match) { keptNotes.push(note); continue; }

      const [, contentType, base64] = match as unknown as [string, string, string];
      const bytes = Buffer.from(base64, 'base64');
      summary.notesFound++;
      summary.bytesEmbedded += bytes.byteLength;

      if (deps.dryRun) { keptNotes.push(note); continue; }

      try {
        const evidenceId = note.id ?? randomUUID();
        const ticket = await deps.store.createUploadTicket({
          ownerUid, alertId: docSnap.id, evidenceId, contentType,
        });

        const res = await fetch(ticket.url, {
          method: 'PUT',
          headers: { 'content-type': contentType },
          body: new Uint8Array(bytes),
        });
        if (!res.ok) throw new Error(`upload returned ${res.status}`);

        // Verified against the bucket before anything is destroyed. Size as
        // well as existence: a truncated object that exists is the failure
        // this check is for.
        const size = await deps.store.sizeOf(ticket.storagePath);
        if (size !== bytes.byteLength) {
          throw new Error(`size mismatch: stored ${String(size)}, expected ${bytes.byteLength}`);
        }

        await deps.evidence.create({
          id: evidenceId,
          alertId: docSnap.id,
          ownerUid,
          storagePath: ticket.storagePath,
          contentType,
          sizeBytes: size,
          durationMs: null,
          createdAt: new Date(),
          uploaded: true,
        });

        // Only now is the base64 dropped, and the note itself is kept so the
        // recording's place in the timeline survives.
        const { audioData: _dropped, ...rest } = note;
        keptNotes.push({ ...rest, id: evidenceId, migrated: true });
        changed = true;
        summary.migrated++;
      } catch (err) {
        // Left exactly as it was. A failed migration must never be the reason
        // a recording disappeared.
        keptNotes.push(note);
        summary.failed.push({
          alertId: docSnap.id, noteIndex: index,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (changed) await docSnap.ref.update({ voiceNotes: keptNotes });
  }

  const level = summary.failed.length > 0 ? 'error' : 'info';
  deps.logger[level]('embedded audio migration finished', {
    ...summary, failed: summary.failed.length,
  });
  return summary;
}
