/**
 * Geohash encoding, server-side.
 *
 * Computed here rather than trusted from the client: the geohash decides which
 * responders are selected by the fan-out (P2-05), so a client that can choose
 * its own geohash can choose who gets told.
 *
 * Same algorithm as lib/utils/geohash_util.dart so both sides agree.
 */
const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export function encodeGeohash(lat: number, lon: number, precision = 9): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new RangeError('geohash requires finite coordinates');
  }
  let minLat = -90, maxLat = 90, minLon = -180, maxLon = 180;
  let hash = '';
  let bits = 0;
  let value = 0;
  let even = true;

  while (hash.length < precision) {
    if (even) {
      const mid = (minLon + maxLon) / 2;
      if (lon >= mid) { value = (value << 1) | 1; minLon = mid; }
      else { value = value << 1; maxLon = mid; }
    } else {
      const mid = (minLat + maxLat) / 2;
      if (lat >= mid) { value = (value << 1) | 1; minLat = mid; }
      else { value = value << 1; maxLat = mid; }
    }
    even = !even;
    if (++bits === 5) {
      hash += BASE32[value];
      bits = 0;
      value = 0;
    }
  }
  return hash;
}

/**
 * Great-circle distance in metres.
 *
 * Used to decide whether a responder is close enough for exact coordinates
 * (P2-08). Haversine is accurate to well under a metre at the ~50m scale this
 * is compared against, so the spherical-earth approximation costs nothing here.
 */
export function distanceMetres(
  aLat: number, aLng: number, bLat: number, bLng: number,
): number {
  const R = 6_371_008.8; // IUGG mean earth radius
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
