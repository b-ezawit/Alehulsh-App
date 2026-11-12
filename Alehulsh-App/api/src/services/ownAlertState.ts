import type { Alert, AlertRepository, AcceptanceRepository } from '../repositories/types.js';

/** Persistence, in-app acknowledgment, provider delivery and arrival are
 * separate claims. Return only a count of recorded human actions to the owner. */
export async function ownAlertState(alerts: Pick<AlertRepository,'findActiveByOwner'>,
  acceptances: Pick<AcceptanceRepository,'listForAlert'> | undefined, uid: string) {
  let alert = await alerts.findActiveByOwner(uid);
  if (!alert) return null;
  let acknowledgmentCount: number | null = null;
  if (acceptances) {
    const observed = alert;
    const rows = await acceptances.listForAlert(observed.id);
    alert = await alerts.findActiveByOwner(uid);
    if (!alert) return null;
    if (alert.key === observed.key) acknowledgmentCount = rows.filter(a =>
      (a.alertKey ?? a.alertId) === observed.key).length;
  }
  return dto(alert, acknowledgmentCount);
}
function dto(alert: Alert, acknowledgmentCount: number | null) {
  return { ...(alert.message?{message:alert.message}:{}),...(alert.isUrgent!==undefined?{isUrgent:alert.isUrgent}:{}),id: alert.id, key: alert.key, status: alert.status,
    createdAt: alert.createdAt.toISOString(), expiresAt: alert.expiresAt.toISOString(),
    hasLocation: alert.latitude !== null, locationQuality: alert.locationQuality,
    reportedDelayMs: alert.reportedDelayMs ?? null, acknowledgmentCount };
}
