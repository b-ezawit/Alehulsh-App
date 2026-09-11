/**
 * Deterministic location fuzzing.  (docs/responder-projection.md §3)
 *
 * The obvious implementation — a random offset within 200m — is dangerously
 * wrong. Each regenerated or per-responder copy would carry an independent
 * offset, so two samples halve the error and ten put you within metres. A
 * responder able to prompt a re-fan-out could average his way to her exact
 * position, and the protection would become a slow leak.
 *
 * So: snap, never jitter. The same alert yields the same fuzzed point for every
 * responder, forever. Sampling gains nothing.
 */
const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

/** ~153m x 153m, so the true point is within roughly 108m of the centre. */
export const FUZZ_PRECISION = 7;
export const FUZZ_LABEL = '~150m';

/** Decodes a geohash prefix back to the centre of the cell it describes. */
export function geohashCellCentre(hash: string): { lat: number; lng: number } {
  let minLat = -90, maxLat = 90, minLng = -180, maxLng = 180;
  let even = true;

  for (const ch of hash) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new RangeError(`not a geohash character: ${ch}`);
    for (let bit = 4; bit >= 0; bit--) {
      const on = (idx >> bit) & 1;
      if (even) {
        const mid = (minLng + maxLng) / 2;
        if (on) minLng = mid; else maxLng = mid;
      } else {
        const mid = (minLat + maxLat) / 2;
        if (on) minLat = mid; else maxLat = mid;
      }
      even = !even;
    }
  }
  return { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 };
}

/**
 * Truncate to FUZZ_PRECISION and return that cell's centre.
 * Null in, null out — an alert with no location must stay location-less
 * rather than acquiring a plausible fabricated one (P1-17).
 */
export function fuzzFromGeohash(geohash: string | null): { lat: number; lng: number } | null {
  if (!geohash || geohash.length < FUZZ_PRECISION) return null;
  return geohashCellCentre(geohash.slice(0, FUZZ_PRECISION));
}
