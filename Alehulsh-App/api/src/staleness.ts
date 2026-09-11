/**
 * How old is this alert, really?  (P3-13)
 *
 * M-02 gives the client a durable offline queue, so an SOS triggered with no
 * signal is replayed when connectivity returns — possibly hours later. The
 * server stamps its own clock on arrival, which is correct for expiry: the
 * alert gets its full window from the moment we learn about it, so a queued
 * alert still dispatches rather than arriving pre-expired.
 *
 * But that alone would tell every recipient an emergency is happening now,
 * with coordinates describing where she was hours ago. Responders would be
 * sent to the wrong place and told it was current. So the delay is computed
 * and passed on.
 *
 * The device clock is the only source for when the trigger happened, and it
 * cannot be trusted — it can be wrong, unset, or deliberately altered. It is
 * therefore used for exactly one thing: labelling staleness. It never affects
 * expiry, escalation timing, or any authorization decision.
 */

/** Beyond this, recipients are told the position may be out of date. */
export const STALE_AFTER_MS = 5 * 60 * 1000;

/**
 * An alert claiming to be older than this is not believed. A device weeks
 * behind is far likelier than a genuine two-week-old queued SOS, and treating
 * the claim as true would label a live emergency as ancient.
 */
export const MAX_BELIEVABLE_DELAY_MS = 24 * 60 * 60 * 1000;

/**
 * Null when we cannot tell — no reported time, a clock ahead of ours, or a
 * claim too old to believe. Null means "assume current", which is the safe
 * default: it never causes a real emergency to be dismissed as stale.
 */
export function reportedDelayMs(
  receivedAt: Date,
  deviceReportedAt: Date | null | undefined,
): number | null {
  if (!deviceReportedAt || Number.isNaN(deviceReportedAt.getTime())) return null;
  const delay = receivedAt.getTime() - deviceReportedAt.getTime();
  // Negative means the device clock runs ahead. That tells us the clock is
  // wrong, not that the alert is from the future.
  if (delay < 0) return null;
  if (delay > MAX_BELIEVABLE_DELAY_MS) return null;
  return delay;
}

export function isStale(delayMs: number | null): boolean {
  return delayMs !== null && delayMs >= STALE_AFTER_MS;
}
