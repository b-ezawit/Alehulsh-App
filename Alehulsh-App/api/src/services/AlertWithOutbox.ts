/**
 * One transaction: the alert, and the work of telling someone about it.
 *
 * This is the PERSISTENCE half only. Nothing here contacts FCM, an SMS
 * provider or any recipient - it writes rows that a worker will later claim.
 * Contact fan-out is not implemented and is explicitly out of scope; this
 * exists to prove the transaction boundary works, which is the guarantee an
 * outbox is for:
 *
 *   - There is no instant at which an alert is live with no work queued for
 *     it. A crash between the two writes used to leave an alert nobody would
 *     ever be told about - the silent failure that matters most here.
 *   - There is no instant at which work is queued for an alert that was
 *     rolled back, which would notify contacts about an emergency that does
 *     not exist and teach them to ignore the next one.
 *
 * Why it lives outside the repository: the repository must not open or end a
 * transaction, because it cannot know whether it is part of a larger unit of
 * work. Transaction ownership is explicit and belongs to the caller, here.
 */
import type { Pool } from 'pg';
import { withTransaction } from '../db/pool.js';
import type { PostgresAlertRepository } from '../repositories/postgres/PostgresAlertRepository.js';
import type { Alert, AlertCreateInput } from '../repositories/types.js';

export interface AlertWithOutboxResult {
  alert: Alert;
  /** False when this folded onto an alert that was already live. */
  created: boolean;
  /** Recipient subjects whose work was queued by THIS call. */
  enqueued: string[];
  /**
   * Recipient subjects with no internal account.
   *
   * Reported rather than thrown. One unresolvable contact must not cost the
   * other contacts their notification, nor cost her the alert - but it must
   * not be swallowed either, or a woman would believe she had three contacts
   * and have two.
   */
  unresolved: string[];
}

/**
 * Create an alert and queue its notification work atomically.
 *
 * @param recipientSubjects verified external subjects of the people to notify.
 *   Resolved to internal uuids inside the transaction, so a mapping cannot
 *   change between resolution and use.
 */
export async function createAlertWithOutbox(
  pool: Pool,
  repo: PostgresAlertRepository,
  input: AlertCreateInput,
  recipientSubjects: readonly string[],
  channel = 'fcm',
): Promise<AlertWithOutboxResult> {
  return withTransaction(pool, async (tx) => {
    // Rebound to this transaction's client. Without this the repository would
    // take its own pooled connection and commit independently, and a rollback
    // here would leave the alert behind.
    const txRepo = repo.withQueryable(tx);
    const { alert, created } = await txRepo.create(input);

    const enqueued: string[] = [];
    const unresolved: string[] = [];

    for (const subject of recipientSubjects) {
      const { rows } = await tx.query<{ user_id: string }>(
        `SELECT user_id FROM identity_map WHERE firebase_uid = $1`, [subject],
      );
      const recipientId = rows[0]?.user_id;
      if (!recipientId) { unresolved.push(subject); continue; }

      // dedupe_key is UNIQUE and derived from (alert, recipient, channel), so
      // a retry of this whole operation folds onto the existing row instead of
      // queueing a second notification for one emergency. The alert id is used
      // rather than the request id because a re-trigger folds onto the live
      // alert, and that alert's contacts have already been queued.
      //
      // No payload content: the row says WHO to tell about WHICH alert. What
      // they are permitted to see is decided when the notification is built,
      // against the audience rules - never baked into a queue row that then
      // sits in the database carrying her position.
      const { rows: inserted } = await tx.query<{ enqueue_outbox: boolean }>(
        `SELECT enqueue_outbox($1::text, $2::uuid, $3::uuid, $4::text, $5::jsonb)`,
        [
          `alert:${alert.id}:${recipientId}:${channel}`,
          alert.id, recipientId, channel,
          JSON.stringify({ kind: 'alert-notification', alertId: alert.id }),
        ],
      );
      if (inserted[0]?.enqueue_outbox) enqueued.push(subject);
    }

    return { alert, created, enqueued, unresolved };
  });
}
