/// Keeps provider provenance beside the coordinates. The existing native
/// freshness boundary (two minutes, inclusive) remains subject to device review.
class LocationEvidence {
  const LocationEvidence._(this.latitude, this.longitude, this.ageMs, this.accuracyMeters);
  final double? latitude, longitude, ageMs, accuracyMeters;
  bool get available => latitude != null && longitude != null;
  String get label {
    if (!available) return 'Location unavailable';
    final accuracy = accuracyMeters == null ? '' : ' (accuracy ±${accuracyMeters!.round()} m)';
    if (ageMs == null) return 'Last known location (age unknown)$accuracy';
    if (ageMs! <= 120000) return 'Recent GPS fix at submission$accuracy';
    return 'Last known location (${(ageMs! / 60000).floor()} min old at submission)$accuracy';
  }
  factory LocationEvidence.decide({required bool consent, double? latitude,
      double? longitude, double? accuracyMeters, DateTime? measuredAt, required DateTime now}) {
    if (!consent || latitude == null || longitude == null || !latitude.isFinite ||
        !longitude.isFinite || latitude.abs() > 90 || longitude.abs() > 180 ||
        (latitude == 0 && longitude == 0 && (accuracyMeters == null || !accuracyMeters.isFinite || accuracyMeters <= 0))) {
      return const LocationEvidence._(null, null, null, null);
    }
    final age = measuredAt == null ? null : now.difference(measuredAt).inMilliseconds.toDouble();
    return LocationEvidence._(latitude, longitude, age != null && age >= 0 ? age : null,
        accuracyMeters != null && accuracyMeters.isFinite && accuracyMeters > 0 ? accuracyMeters : null);
  }
}
