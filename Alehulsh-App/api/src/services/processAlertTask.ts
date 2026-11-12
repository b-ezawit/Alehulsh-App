import { isTerminalStatus } from '../repositories/types.js';
import type { Deps } from '../server.js';
import { AppError } from '../errors.js';
import { expediteAlertWork } from './alertWork.js';

export type AlertTaskKind = 'safety-check' | 'expiry' | 'notify-contacts' | 'retract-inbox';
export interface AlertTaskInput { alertId: string; alertKey?: string; }
type TaskDeps = Pick<Deps, 'alerts' | 'fanout' | 'inbox' | 'queue' | 'logger'> & { config: Pick<Deps['config'], 'safetyCheckDelayMs'>; };

/** Persistence and inbox projections only. No SMS, push or external delivery. */
export async function processAlertTask(deps: TaskDeps, kind: AlertTaskKind, input: AlertTaskInput) {
  const alert = await deps.alerts.findById(input.alertId);
  if (kind === 'retract-inbox') {
    if (!input.alertKey || alert?.key === input.alertKey && !isTerminalStatus(alert.status)) return { handled: false };
    await deps.fanout.retract(input.alertId, input.alertKey);
    return { handled: true };
  }
  const skipped = kind === 'notify-contacts' ? { handled: false, notified: 0 } : { handled: false };
  if (!alert || (input.alertKey ?? alert.id) !== alert.key || isTerminalStatus(alert.status)) return skipped;
  if (kind === 'safety-check') {
    const alreadyEscalated = alert.status === 'escalated';
    const updated = await deps.alerts.updateStatus(alert.id, 'escalated', alreadyEscalated ? {} : {
      escalatedAt: new Date(), escalationReason: 'no_answer',
    }, alert.key);
    if (updated.status !== 'escalated') return { handled: false };
    await expediteAlertWork(updated, deps.config.safetyCheckDelayMs, deps.queue, deps.logger);
    return { handled: !alreadyEscalated };
  }
  if (kind === 'expiry') {
    const updated = await deps.alerts.updateStatus(alert.id, 'expired', {}, alert.key);
    await expediteAlertWork(updated, deps.config.safetyCheckDelayMs, deps.queue, deps.logger);
    await deps.fanout.retract(alert.id, alert.key);
    deps.logger[alert.status === 'active' ? 'error' : 'warn']('alert expired unresolved', { alertId: alert.id });
    return { handled: true };
  }
  if (kind === 'notify-contacts') {
    const previous = new Set(await deps.inbox.listRecipients(alert.id));
    const result = await deps.fanout.dispatch(alert);
    return { handled: true, notified: result.contacts.filter(uid => !previous.has(uid)).length };
  }
  throw new AppError('invalid_request');
}
