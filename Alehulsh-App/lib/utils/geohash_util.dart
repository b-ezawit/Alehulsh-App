import 'dart:math';

/// High-performance Geohash utility for 500m proximity spatial queries
/// and FCM topic partitioning during viral load.
class GeohashUtil {
  static const String _base32 = '0123456789bcdefghjkmnpqrstuvwxyz';

  /// Encode (latitude, longitude) into a Geohash string
  static String encode(double latitude, double longitude, {int precision = 9}) {
    double minLat = -90.0, maxLat = 90.0;
    double minLng = -180.0, maxLng = 180.0;

    StringBuffer hash = StringBuffer();
    int bits = 0;
    int hashValue = 0;
    bool isEven = true;

    while (hash.length < precision) {
      if (isEven) {
        double mid = (minLng + maxLng) / 2.0;
        if (longitude >= mid) {
          hashValue = (hashValue << 1) | 1;
          minLng = mid;
        } else {
          hashValue = (hashValue << 1) | 0;
          maxLng = mid;
        }
      } else {
        double mid = (minLat + maxLat) / 2.0;
        if (latitude >= mid) {
          hashValue = (hashValue << 1) | 1;
          minLat = mid;
        } else {
          hashValue = (hashValue << 1) | 0;
          maxLat = mid;
        }
      }

      isEven = !isEven;
      bits++;

      if (bits == 5) {
        hash.write(_base32[hashValue]);
        bits = 0;
        hashValue = 0;
      }
    }

    return hash.toString();
  }

  /// Get 5-character Geohash prefix (~2.4km bounding box) for FCM emergency topic broadcast
  static String getFCMTopicGeohash(double latitude, double longitude) {
    return encode(latitude, longitude, precision: 5);
  }

  /// Get 6-character Geohash prefix (~610m bounding box) for tight 500m proximity
  static String getLocalRadarGeohash(double latitude, double longitude) {
    return encode(latitude, longitude, precision: 6);
  }

  /// Calculate bounding box range [startHash, endHash] for Firestore range query
  static List<String> getGeohashQueryRange(String geohashPrefix) {
    return [
      geohashPrefix,
      "$geohashPrefix~", // ~ is lexicographically after all base32 characters
    ];
  }

  /// Get the 8 neighboring geohashes + center for complete 360-degree 500m coverage
  static List<String> getSurroundingGeohashPrefixes(double lat, double lng, {int precision = 5}) {
    // Delta approximations for ~1km offset
    const double latDelta = 0.009; // ~1km
    final double lngDelta = 0.009 / cos(lat * pi / 180.0);

    final Set<String> prefixes = {};

    for (int dx = -1; dx <= 1; dx++) {
      for (int dy = -1; dy <= 1; dy++) {
        final neighborLat = lat + (dy * latDelta);
        final neighborLng = lng + (dx * lngDelta);
        prefixes.add(encode(neighborLat, neighborLng, precision: precision));
      }
    }

    return prefixes.toList();
  }
}
