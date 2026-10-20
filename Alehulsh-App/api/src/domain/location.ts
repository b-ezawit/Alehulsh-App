/**
 * What a position may be said to be.  (M-05, sprint 3)
 *
 * These rules exist in three places and must agree in all three:
 *
 *   - SosLocationDecision.kt   — decides what the device publishes (33 tests)
 *   - this module              — the server's validation and derivation
 *   - 0005_identity_location_outbox.sql — the same derivation inside the
 *                                database, so no writer can bypass it
 *
 * Two implementations of one rule is a drift risk, so it is not left to
 * discipline: location.parity.integration.test.ts runs one table of cases
 * through both this module and the SQL functions and fails if they ever
 * disagree.
 *
 * The important decision here is about trust. The device sends EVIDENCE -
 * coordinates, horizontal accuracy, how old the fix is - and never a quality.
 * "Live" is a claim that sends someone running to a position; a device is free
 * to be wrong about it, and a hostile client is free to lie. So the server
 * derives the quality from the evidence and ignores any claim about it.
 */

/**
 * At or under this age a fix counts as current. Inclusive boundary.
 *
 * Mirrors SosLocationDecision.FRESH_FIX_MS. A judgment call, not a measured
 * product requirement, and flagged NEEDS PRODUCT REVIEW there - so if it
 * changes, it changes in both places.
 */
export const FRESH_FIX_MS = 2 * 60 * 1000;

export type LocationQuality = 'live' | 'stale' | 'age_unknown' | 'unavailable';

/**
 * Accuracy that could only have come from an actual measurement.
 *
 * Read as evidence that a fix is real, NEVER as a quality bar: a 2 km fix is
 * still a real position and a far better starting point than "unknown", so
 * nothing is discarded for being imprecise.
 */
export function hasMeasurementEvidence(accuracyMeters: number | null | undefined): boolean {
  if (accuracyMeters === null || accuracyMeters === undefined) return false;
  if (!Number.isFinite(accuracyMeters)) return false;
  return accuracyMeters > 0;
}

/**
 * Whether this pair may be published as her position.
 *
 * STRUCTURAL rejection - NaN, infinity, out of range. Not points on Earth
 * under any interpretation. No geography is assumed: the poles, the
 * antimeridian and a zero on a SINGLE axis are all legitimate and kept.
 *
 * EVIDENTIAL rejection - exactly (0,0), and only when the provider offered no
 * evidence it measured anything. (0,0) is the value an unpopulated location
 * struct holds, so a bare (0,0) is an uninitialised reading. A (0,0) that
 * arrives WITH plausible accuracy is a real place and is kept.
 */
export function isUsableCoordinate(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
  accuracyMeters: number | null | undefined = null,
): boolean {
  if (latitude === null || latitude === undefined) return false;
  if (longitude === null || longitude === undefined) return false;

  // Structural.
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  if (latitude < -90 || latitude > 90) return false;
  if (longitude < -180 || longitude > 180) return false;

  // Evidential, and only for the uninitialised-struct value.
  if (latitude === 0 && longitude === 0) return hasMeasurementEvidence(accuracyMeters);
  return true;
}

/**
 * The strongest quality the evidence actually supports.
 *
 * A negative age means the device clock moved, which is unknown rather than
 * fresh. An unusable coordinate keeps its position NOWHERE: nothing is
 * substituted, because a fabricated coordinate sends responders confidently
 * to the wrong place, which is worse than sending them nothing.
 */
export function deriveLocationQuality(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
  ageMs: number | null | undefined,
  accuracyMeters: number | null | undefined = null,
  freshMs: number = FRESH_FIX_MS,
  /**
   * How long the alert was in transit before the server received it.
   *
   * A fix is only as fresh as the moment it ARRIVES. `ageMs` is how old the
   * fix was when the DEVICE captured it, so an alert that sat three hours in
   * the offline queue carries a position three hours older than that by the
   * time anyone can act on it. Deriving freshness from `ageMs` alone labelled
   * such an alert 'live', and a responder trusting that label would go where
   * she was three hours ago.
   *
   * Defaults to 0 for a live request, which has no transit delay.
   */
  delayMs: number | null | undefined = 0,
): LocationQuality {
  if (!isUsableCoordinate(latitude, longitude, accuracyMeters)) return 'unavailable';
  if (ageMs === null || ageMs === undefined || !Number.isFinite(ageMs) || ageMs < 0) {
    // Keep the position, withdraw the claim that it is current. Discarding it
    // would throw away a real starting point for someone looking for her;
    // calling it live would be a lie.
    //
    // An unknown age stays unknown: adding a known delay to an unknown age
    // does not produce knowledge.
    return 'age_unknown';
  }
  // Floored at zero so a device clock running ahead cannot subtract from the
  // fix age and buy freshness it has not got.
  const delay = Number.isFinite(delayMs as number) ? Math.max(0, delayMs as number) : 0;
  return ageMs + delay <= freshMs ? 'live' : 'stale';
}

/** A position and the metadata that is actually justified for it. */
export interface NormalizedLocation {
  latitude: number | null;
  longitude: number | null;
  quality: LocationQuality;
  /** Null unless a usable position exists AND the age is known and sane. */
  ageMs: number | null;
  /** Null unless a usable position exists AND accuracy is real evidence. */
  accuracyMeters: number | null;
}

/**
 * Reduce whatever arrived to what may be stored.
 *
 * Metadata is normalised to what the database's CHECK constraints accept
 * rather than being passed through to violate them. That is a safety choice,
 * not tidiness: a constraint violation here would cost her the entire alert in
 * order to preserve a field nobody needs. A negative age, a zero accuracy and
 * an unjustifiable freshness claim all become "we do not know".
 */
export function normalizeLocation(input: {
  latitude?: number | null;
  longitude?: number | null;
  locationAgeMs?: number | null;
  accuracyMeters?: number | null;
  freshMs?: number;
  /** Transit delay, so a queued alert is not labelled fresh. See above. */
  queuedDelayMs?: number | null;
}): NormalizedLocation {
  const quality = deriveLocationQuality(
    input.latitude, input.longitude, input.locationAgeMs,
    input.accuracyMeters, input.freshMs ?? FRESH_FIX_MS,
    input.queuedDelayMs ?? 0,
  );

  if (quality === 'unavailable') {
    return { latitude: null, longitude: null, quality, ageMs: null, accuracyMeters: null };
  }

  const age = input.locationAgeMs;
  return {
    latitude: input.latitude as number,
    longitude: input.longitude as number,
    quality,
    ageMs: age !== null && age !== undefined && Number.isFinite(age) && age >= 0 ? age : null,
    accuracyMeters: hasMeasurementEvidence(input.accuracyMeters)
      ? (input.accuracyMeters as number)
      : null,
  };
}
