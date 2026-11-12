import 'package:flutter_test/flutter_test.dart';
import 'package:alehulsh_app/services/location_evidence.dart';

void main() {
  final now = DateTime.utc(2026, 11, 11);
  LocationEvidence fix({bool consent = true, double lat = 9, double lng = 38, double? accuracy = 7, int? age}) =>
    LocationEvidence.decide(consent: consent, latitude: lat, longitude: lng,
      accuracyMeters: accuracy, measuredAt: age == null ? null : now.subtract(Duration(milliseconds: age)), now: now);
  test('consent is required even with a fresh cached fix', () {
    expect(fix(consent: false, age: 0).available, isFalse);
  });
  test('freshness boundary preserves provenance and accuracy', () {
    expect(fix(age: 120000).label, 'Recent GPS fix at submission (accuracy ±7 m)');
    expect(fix(age: 120001).label, contains('Last known location'));
    expect(fix(age: 120001).ageMs, 120001);
    expect(fix(age: 0, accuracy: 2000).label, contains('±2000 m'));
  });
  test('unknown and future timestamps cannot claim a current position', () {
    expect(fix().label, contains('age unknown'));
    expect(fix(age: -1).label, contains('age unknown'));
  });
  test('invalid and uninitialized coordinates are unavailable without inventing a pin', () {
    for (final item in [fix(lat: double.nan), fix(lng: 181), fix(lat: 0, lng: 0, accuracy: null)]) {
      expect(item.available, isFalse); expect(item.label, 'Location unavailable');
    }
    expect(fix(lat: 0, lng: 0).available, isTrue);
  });
}
