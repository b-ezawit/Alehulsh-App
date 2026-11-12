import { AppError } from '../errors.js';
import { isTerminalStatus, type AlertRepository, type InboxRepository, type AcceptanceRepository } from '../repositories/types.js';

export async function acceptAlert(deps: {
  alerts: AlertRepository; inbox: InboxRepository; acceptances: AcceptanceRepository;
}, uid: string, alertId: string, incidentKey?: string) {
  const projection = await deps.inbox.get(uid, alertId);
  if (!projection) throw new AppError('not_found');
  if (incidentKey !== undefined && incidentKey !== (projection.alertKey ?? projection.alertId)) throw new AppError('alert_closed');
  const alert = await deps.alerts.findById(alertId);
  if (!alert) throw new AppError('not_found');
  if (isTerminalStatus(alert.status) || alert.expiresAt <= new Date()) throw new AppError('alert_closed');
  const result = await deps.acceptances.record({
    alertId, alertKey: alert.key, responderUid: uid, acceptedAt: new Date(), audience: projection.audience,
  });
  return {
    created: result.created, body: {
      acceptance: { alertId: result.acceptance.alertId, acceptedAt: result.acceptance.acceptedAt.toISOString(), audience: result.acceptance.audience },
      alert: {
        id: projection.alertId, status: alert.status, latitude: projection.fuzzedLat,
        longitude: projection.fuzzedLng, precision: projection.fuzzedPrecision,
        hasVoiceNote: projection.hasVoiceNote, createdAt: projection.createdAt.toISOString()
      },
    }
  };
}
