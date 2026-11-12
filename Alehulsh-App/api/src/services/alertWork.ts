import type { Alert } from '../repositories/types.js';
import { isTerminalStatus } from '../repositories/types.js';
import type { ScheduledTask, TaskQueue } from '../queue/TaskQueue.js';
import { taskKeys } from '../tasks.js';
import type { Logger } from '../logger.js';

/** Immutable deadlines and instance identifiers: a retry cannot postpone SOS. */
export function requiredAlertWork(alert: Alert, safetyDelayMs: number): ScheduledTask[] {
  const task = (kind: string, key: string, runAt: Date): ScheduledTask => ({
    key, runAt, payload: { kind, alertId: alert.id, alertKey: alert.key },
  });
  if (isTerminalStatus(alert.status)) {
    return [task('retract-inbox', `retract-inbox:${alert.key}`, alert.createdAt)];
  }
  const work = [
    task('safety-check', taskKeys.safetyCheck(alert),
      new Date(alert.createdAt.getTime() + safetyDelayMs)),
    task('expiry', taskKeys.expiry(alert), alert.expiresAt),
    task('notify-contacts', `notify-contacts:${alert.key}:initial`, alert.createdAt),
  ];
  if (alert.status === 'escalated') {
    work.push(task('notify-contacts', `notify-contacts:${alert.key}:escalation`,
      alert.escalatedAt ?? alert.createdAt));
  }
  return work;
}

/** Optimization only. The repository has already committed durable work. */
export async function expediteAlertWork(
  alert: Alert, delay: number, queue: TaskQueue, logger: Logger,
): Promise<void> {
  for (const task of requiredAlertWork(alert, delay)) {
    try { await queue.schedule(task); }
    catch {
      logger.error('task relay unavailable; durable alert work awaits recovery', {
        alertId: alert.id, kind: task.payload['kind'],
      });
    }
  }
}
