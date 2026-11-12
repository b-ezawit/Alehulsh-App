import { FieldPath, type Firestore, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import type { FirestoreAlertRepository } from '../repositories/firestore/FirestoreAlertRepository.js';
import type { AlertFanout } from '../services/AlertFanout.js';
import { isTerminalStatus } from '../repositories/types.js';
import type { Logger } from '../logger.js';
import type { TaskQueue } from './TaskQueue.js';
import { relayAlertWork } from './FirestoreAlertWork.js';

/** Temporary bridge while legacy clients write Firestore directly.
 * Cursor advances past terminal records, preventing expiry/recovery starvation.
 * Restarting resets the cursor and rechecks durable state, never RAM receipts.
 */
export class FirestoreAlertRecovery {
  private cursor: QueryDocumentSnapshot | undefined;
  private running: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly db: Firestore,
    private readonly alerts: FirestoreAlertRepository,
    private readonly queue: TaskQueue,
    private readonly fanout: AlertFanout,
    private readonly logger: Logger,
  ) {}

  async runOnce(): Promise<void> {
    let query = this.db.collection('active_alerts').orderBy(FieldPath.documentId()).limit(100);
    if (this.cursor) query = query.startAfter(this.cursor);
    const page = await query.get();
    for (const row of page.docs) {
      try {
        await this.alerts.ensureWorkflow(row.id);
        const alert = await this.alerts.findById(row.id);
        if (!alert) continue;
        if (!isTerminalStatus(alert.status) && alert.expiresAt.getTime() <= Date.now()) {
          await this.alerts.updateStatus(alert.id, 'expired', {}, alert.key);
        }
        if (isTerminalStatus(alert.status) || alert.expiresAt.getTime() <= Date.now()) {
          await this.fanout.retract(alert.id, alert.key);
        }
      } catch {
        this.logger.error('Firestore alert recovery failed; will revisit', { alertId: row.id });
      }
    }
    this.cursor = page.size === 100 ? page.docs.at(-1) : undefined;
    await relayAlertWork(this.db, this.queue);
  }

  start(): void {
    if (this.timer) return;
    const tick = () => {
      if (this.running) return;
      this.running = this.runOnce().catch(() => {
        this.logger.error('Firestore workflow relay failed; durable work remains pending');
      }).finally(() => { this.running = undefined; });
    };
    tick();
    this.timer = setInterval(tick, 1000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
}
