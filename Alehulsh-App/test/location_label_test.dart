import 'package:flutter_test/flutter_test.dart';
import 'package:alehulsh_app/models/alert_model.dart';
import 'package:alehulsh_app/services/emergency_ping_service.dart';

Map<String, dynamic> docWith(Map<String, dynamic> extra) => {
      'userId': 'u1',
      'userName': 'Test User',
      'timestamp': DateTime(2026, 1, 1).toIso8601String(),
      ...extra,
    };

void main() {
  group('locationName is never defaulted to a live-fix claim', () {
    test('a missing label reads as unavailable, not "Live GPS"', () {
      // The reader's half of the fabrication: legacy documents written before
      // the writers were fixed have no label at all.
      final a = EmergencyAlert.fromMap(docWith({}), docId: 'a1');
      expect(a.locationName, 'Location unavailable');
      expect(a.locationName, isNot('Live GPS'));
    });

    test('an explicit null reads as unavailable', () {
      final a = EmergencyAlert.fromMap(docWith({'locationName': null}), docId: 'a1');
      expect(a.locationName, 'Location unavailable');
    });

    test('a blank or whitespace-only label reads as unavailable', () {
      for (final blank in ['', '   ', '\t', '\n  ']) {
        final a = EmergencyAlert.fromMap(docWith({'locationName': blank}), docId: 'a1');
        expect(a.locationName, 'Location unavailable', reason: 'input was ${blank.runes.toList()}');
      }
    });

    test('an explicitly stored label is preserved exactly', () {
      for (final stored in [
        'Live GPS',
        'Last known location (45 min old)',
        'Bole, Addis Ababa',
      ]) {
        final a = EmergencyAlert.fromMap(docWith({'locationName': stored}), docId: 'a1');
        expect(a.locationName, stored);
      }
    });

    test('coordinates alone do not imply the location is current', () {
      // Having lat/lng says where, never when. A document with real
      // coordinates but no label must still not claim a live fix.
      final a = EmergencyAlert.fromMap(
        docWith({'latitude': 8.9956, 'longitude': 38.7897}),
        docId: 'a1',
      );
      expect(a.hasLocation, isTrue);
      expect(a.locationName, 'Location unavailable');
    });

    test('the fallback string matches what the writers emit', () {
      // AlertService and the native SosLocationDecision both write this exact
      // string; a drift here would break the agreement silently.
      expect(EmergencyAlert.locationUnavailable, 'Location unavailable');
    });
  });

  group('ping notification never implies proximity it cannot assert', () {
    test('a real place is named', () {
      expect(
        composePingBody(
          userName: 'Tigist', distanceText: '350 meters away', locationName: 'Bole',
        ),
        'Tigist is in danger (350 meters away) near Bole. Tap to help!',
      );
    });

    test('an unavailable location drops the "near" clause', () {
      final body = composePingBody(
        userName: 'Tigist',
        distanceText: 'Distance unknown',
        locationName: 'Location unavailable',
      );
      expect(body, isNot(contains('near Location unavailable')));
      expect(body, isNot(contains(' near ')));
      expect(body, contains('Her location is unavailable'));
    });

    test('a blank label is treated the same way', () {
      for (final blank in ['', '   ']) {
        final body = composePingBody(
          userName: 'Tigist', distanceText: 'Distance unknown', locationName: blank,
        );
        expect(body, isNot(contains(' near ')));
        expect(body, contains('Her location is unavailable'));
      }
    });

    test('a stale-but-real label is still named', () {
      // A last-known position is a real place worth telling a responder about.
      final body = composePingBody(
        userName: 'Tigist',
        distanceText: 'Emergency Contact Alert',
        locationName: 'Last known location (45 min old)',
      );
      expect(body, contains('near Last known location (45 min old)'));
    });

    test('existing behaviour for located alerts is unchanged', () {
      expect(
        composePingBody(
          userName: 'Tigist', distanceText: 'Emergency Contact • 120m away',
          locationName: 'Live GPS',
        ),
        'Tigist is in danger (Emergency Contact • 120m away) near Live GPS. Tap to help!',
      );
    });
  });
}
