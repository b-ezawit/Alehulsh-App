import 'package:flutter_test/flutter_test.dart';
import 'package:alehulsh_app/models/alert_model.dart';

EmergencyAlert alertAt({double? lat, double? lng}) => EmergencyAlert(
      id: 'a1',
      userId: 'u1',
      userName: 'Test',
      latitude: lat,
      longitude: lng,
      locationName: 'x',
      timestamp: DateTime(2026, 1, 1),
    );

void main() {
  group('absent location stays absent', () {
    // The regression: fromMap defaulted missing coordinates to
    // (9.0125, 38.7636) - Addis Ababa city centre - so an alert with no
    // location rendered as a confident pin in Bole and responders would be
    // dispatched to the wrong place.
    test('fromMap does not invent Addis Ababa', () {
      final alert = EmergencyAlert.fromMap({
        'userId': 'u1',
        'userName': 'Test',
        'timestamp': DateTime(2026, 1, 1).toIso8601String(),
      }, docId: 'a1');

      expect(alert.latitude, isNull);
      expect(alert.longitude, isNull);
      expect(alert.hasLocation, isFalse);
    });

    test('fromMap preserves a real location', () {
      final alert = EmergencyAlert.fromMap({
        'userId': 'u1',
        'userName': 'Test',
        'latitude': 8.9806,
        'longitude': 38.7578,
        'timestamp': DateTime(2026, 1, 1).toIso8601String(),
      }, docId: 'a1');

      expect(alert.latitude, 8.9806);
      expect(alert.longitude, 38.7578);
      expect(alert.hasLocation, isTrue);
    });

    test('a partial coordinate is not a location', () {
      // Half a coordinate is meaningless and must not be treated as a fix.
      expect(alertAt(lat: 9.0, lng: null).hasLocation, isFalse);
      expect(alertAt(lat: null, lng: 38.7).hasLocation, isFalse);
    });
  });

  group('no location means no proximity matching', () {
    test('geohash is empty without coordinates', () {
      // An empty geohash falls outside every geohash range query, so an
      // unlocatable alert is never matched to a nearby responder. It still
      // reaches emergency contacts, who are matched by explicit link.
      expect(alertAt().geohash, isEmpty);
    });

    test('geohash is computed when coordinates exist', () {
      expect(alertAt(lat: 9.0, lng: 38.7).geohash, isNotEmpty);
    });

    test('toMap omits the geo field entirely without coordinates', () {
      // Writing a placeholder GeoPoint would make the alert queryable by
      // proximity at a place she is not.
      expect(alertAt().toMap().containsKey('geo'), isFalse);
      expect(alertAt().toMap()['latitude'], isNull);
      expect(alertAt().toMap()['longitude'], isNull);
    });

    test('toMap includes geo when coordinates exist', () {
      expect(alertAt(lat: 9.0, lng: 38.7).toMap().containsKey('geo'), isTrue);
    });
  });

  group('distance is never fabricated', () {
    test('null when the alert has no location', () {
      expect(alertAt().calculateDistanceKm(9.0, 38.7), isNull);
    });

    test('null when the viewer has no location', () {
      // Previously the viewer fell back to Addis centre, so a user without GPS
      // was shown confident distances measured from a place she was not in.
      expect(alertAt(lat: 9.0, lng: 38.7).calculateDistanceKm(null, null), isNull);
    });

    test('computed when both are known', () {
      final d = alertAt(lat: 9.0, lng: 38.7).calculateDistanceKm(9.01, 38.7);
      expect(d, isNotNull);
      expect(d!, greaterThan(0));
      expect(d, lessThan(2));
    });

    test('label says unknown rather than guessing', () {
      expect(alertAt().distanceLabel(9.0, 38.7), 'Distance unknown');
      expect(alertAt(lat: 9.0, lng: 38.7).distanceLabel(null, null), 'Distance unknown');
    });

    test('label reports metres when close', () {
      expect(alertAt(lat: 9.0, lng: 38.7).distanceLabel(9.0, 38.7), contains('m away'));
    });
  });

  // -------------------------------------------------------------------------
  // The no-location document contract.
  //
  // Two independent writers produce alert documents: AlertService on the Dart
  // side and AlehulshSosDispatcher.writeFirestoreAlert in native Kotlin. The
  // native path previously fabricated (9.0125, 38.7636) when GPS was
  // unavailable; it now writes the shape asserted here.
  //
  // These tests pin the shape so neither writer can drift back to inventing a
  // position. They exercise the Dart side; the Kotlin writer is held to the
  // same contract by review, not by this suite - see the reported gap.
  // -------------------------------------------------------------------------
  group('no-location alert document contract (Dart and native must agree)', () {
    test('absent coordinates are written as null, not as a stand-in', () {
      final m = alertAt().toMap();
      expect(m['latitude'], isNull);
      expect(m['longitude'], isNull);
      // 0.0 is a real place in the Gulf of Guinea, not "unknown".
      expect(m['latitude'], isNot(0.0));
      expect(m['longitude'], isNot(0.0));
    });

    test('geohash is the empty string, which no range query matches', () {
      expect(alertAt().toMap()['geohash'], '');
    });

    test('the geo field is omitted entirely, never a placeholder GeoPoint', () {
      // A placeholder would make an unlocatable alert proximity-queryable at
      // a place she is not.
      expect(alertAt().toMap().containsKey('geo'), isFalse);
    });

    test('a located alert still carries all four location fields', () {
      final m = alertAt(lat: 8.9956, lng: 38.7897).toMap();
      expect(m['latitude'], 8.9956);
      expect(m['longitude'], 38.7897);
      expect(m['geohash'], isNotEmpty);
      expect(m.containsKey('geo'), isTrue);
    });

    test('a round trip through Firestore preserves "unknown"', () {
      // The reader must not resurrect a coordinate the writer refused to
      // invent - fromMap once defaulted to Addis Ababa here.
      final restored = EmergencyAlert.fromMap(alertAt().toMap(), docId: 'a1');
      expect(restored.hasLocation, isFalse);
      expect(restored.latitude, isNull);
      expect(restored.longitude, isNull);
      expect(restored.geohash, '');
    });

    test('an unlocatable alert is never matched by proximity', () {
      final restored = EmergencyAlert.fromMap(alertAt().toMap(), docId: 'a1');
      expect(restored.calculateDistanceKm(8.9956, 38.7897), isNull);
      expect(restored.distanceLabel(8.9956, 38.7897), 'Distance unknown');
    });
  });
}
