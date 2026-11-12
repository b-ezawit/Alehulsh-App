const { createHash, randomUUID } = require('node:crypto');

/**
 * Reconcile only due LIVE incidents. The status/expiry composite index is
 * already declared in firestore.indexes.json. Pagination prevents a fixed
 * first page (including old terminal documents) from starving later alerts.
 * No network provider is called here; closure and durable cleanup intent are
 * committed together in Firestore.
 */
async function reconcileExpiredAlerts({ db, now, timestampFromDate, serverTimestamp,
  logger, pageSize = 200 }) {
  let cursor;
  let transitioned = 0;
  for (;;) {
    let query = db.collection('active_alerts')
      .where('status', 'in', ['active', 'escalated'])
      .where('expiresAtTimestamp', '<=', now)
      .orderBy('expiresAtTimestamp')
      .limit(pageSize);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    if (page.empty) break;
    for (const selected of page.docs) {
      const selectedKey = selected.get('alertKey');
      const selectedExpiry = millis(selected.get('expiresAtTimestamp'));
      const changed = await db.runTransaction(async (tx) => {
        const current = await tx.get(selected.ref);
        if (!current.exists) return false;
        const data = current.data();
        // Re-read INSIDE the transaction: a resolved/cancelled incident or a
        // new incident in the reused owner slot must never be expired by an
        // earlier query's stale candidate.
        if (!['active', 'escalated'].includes(data.status)) return false;
        const expires = millis(data.expiresAtTimestamp);
        if (expires === null || expires > now.getTime() || expires !== selectedExpiry) return false;
        if (selectedKey && selectedKey !== data.alertKey) return false;

        const alertKey = data.alertKey || randomUUID();
        const key = `retract-inbox:${alertKey}`;
        const intent = db.collection('alert_task_outbox')
          .doc(createHash('sha256').update(key).digest('hex'));
        const existing = await tx.get(intent);
        tx.update(selected.ref, {
          status: 'expired', expiredAt: serverTimestamp(), alertKey,
          ...(!data.createdAt ? { createdAt: timestampFromDate(now) } : {}),
        });
        if (!existing.exists) tx.create(intent, {
          key, payload: { kind: 'retract-inbox', alertId: selected.id, alertKey },
          runAt: timestampFromDate(now), state: 'pending',
        });
        return true;
      });
      if (changed) {
        transitioned++;
        logger.error('Alert expired while still open — escalation did not resolve it', { alertId: selected.id });
      }
    }
    cursor = page.docs[page.docs.length - 1];
    if (page.docs.length < pageSize) break;
  }
  return transitioned;
}

function millis(value) {
  if (value && typeof value.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return null;
}

module.exports = { reconcileExpiredAlerts };
