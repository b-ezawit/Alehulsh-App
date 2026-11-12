import { createHash } from 'node:crypto';
import { Timestamp, type Firestore, type Transaction } from 'firebase-admin/firestore';
import type { Alert } from '../repositories/types.js';
import { requiredAlertWork } from '../services/alertWork.js';
import type { TaskQueue } from './TaskQueue.js';

export const ALERT_WORK_COLLECTION = 'alert_task_outbox';

/** Read before ANY writes in the caller's Firestore transaction. */
export async function prepareAlertWork(
  db: Firestore, tx: Transaction, alert: Alert, safetyDelayMs: number,
): Promise<() => void> {
  const work = requiredAlertWork(alert, safetyDelayMs);
  const refs = work.map((t) => db.collection(ALERT_WORK_COLLECTION)
    .doc(createHash('sha256').update(t.key).digest('hex')));
  const existing = await tx.getAll(...refs);
  return () => {
    work.forEach((task, i) => {
      if (!existing[i]!.exists) tx.create(refs[i]!, {
        key: task.key, payload: task.payload, runAt: Timestamp.fromDate(task.runAt),
        state: 'pending',
      });
    });
  };
}

/** At least once: a crash after enqueue and before marking delivered is safe. */
export async function relayAlertWork(db: Firestore, queue: TaskQueue, limit = 100) {
  const pending = await db.collection(ALERT_WORK_COLLECTION)
    .where('state', '==', 'pending').limit(limit).get();
  let delivered = 0;
  let failed = false;
  for (const row of pending.docs) {
    const d = row.data();
    try {
      await queue.schedule({ key: d['key'], payload: d['payload'], runAt: d['runAt'].toDate() });
      await row.ref.update({ state: 'delivered', deliveredAt: Timestamp.now() });
      delivered++;
    } catch { failed = true; }

  }
  if (failed) throw new Error('some durable alert work remains pending');
  return delivered;
}
