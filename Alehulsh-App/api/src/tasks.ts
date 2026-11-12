/**
 * Scheduled-task keys, in one place so the site that schedules and the site
 * that cancels cannot drift apart. An orphaned safety-check task would fire
 * against an already-resolved alert; a mistyped cancel key would leave it
 * firing forever.
 */
import type { Alert } from './repositories/types.js';

export const taskKeys = {
  safetyCheck: (a: Pick<Alert, 'id' | 'createdAt'> & Partial<Pick<Alert, 'key'>>): string =>
    `safety-check:${a.key ?? a.id}:${a.createdAt.getTime()}`,
  expiry: (a: Pick<Alert, 'id' | 'createdAt'> & Partial<Pick<Alert, 'key'>>): string =>
    `expiry:${a.key ?? a.id}:${a.createdAt.getTime()}`,
  /** Dispatched on escalation. Consumed by P3-04. */
  notifyContacts: (a: Pick<Alert, 'id'>, at: Date): string =>
    `notify-contacts:${a.id}:${at.getTime()}`,
};
