// The previous smoke test pumped AlehulshApp, which mounts
// MainNavigationScreen and reaches for Firebase. It has never passed outside a
// device. Widget-level tests need Firebase mocking, which is a separate piece
// of work.
//
// These cover GeohashUtil instead: pure Dart, no plugins, and load-bearing —
// the geohash decides which responders a fan-out selects.

import 'package:flutter_test/flutter_test.dart';
import 'package:alehulsh_app/utils/geohash_util.dart';

void main() {
  group('GeohashUtil.encode', () {
    test('matches the standard reference value', () {
      expect(GeohashUtil.encode(57.64911, 10.40744, precision: 11), 'u4pruydqqvj');
    });

    test('agrees with the API implementation for Addis Ababa', () {
      // Must equal encodeGeohash() in Alehulsh-App/api/src/geo.ts. If these two
      // ever diverge, the client and the server disagree about who is nearby.
      expect(GeohashUtil.encode(9.0125, 38.7636, precision: 9), 'scee60dv9');
    });

    test('honours the requested precision', () {
      expect(GeohashUtil.encode(9.0125, 38.7636, precision: 5).length, 5);
      expect(GeohashUtil.encode(9.0125, 38.7636).length, 9);
    });

    test('nearby points share a prefix', () {
      final a = GeohashUtil.encode(9.0125, 38.7636);
      final b = GeohashUtil.encode(9.0126, 38.7637);
      expect(a.substring(0, 5), b.substring(0, 5));
    });

    test('distant points do not', () {
      final addis = GeohashUtil.encode(9.0125, 38.7636);
      final sydney = GeohashUtil.encode(-33.8688, 151.2093);
      expect(addis[0], isNot(equals(sydney[0])));
    });
  });

  group('GeohashUtil query helpers', () {
    test('the FCM topic prefix is 5 characters', () {
      expect(GeohashUtil.getFCMTopicGeohash(9.0125, 38.7636).length, 5);
    });

    test('the range bounds bracket the prefix', () {
      final range = GeohashUtil.getGeohashQueryRange('scee6');
      expect(range[0], 'scee6');
      expect(range[1].startsWith('scee6'), isTrue);
      expect(range[1].compareTo(range[0]), greaterThan(0));
    });

    test('surrounding prefixes cover the centre and its neighbours', () {
      // alert_service.dart:86-94 queries a single prefix, so a responder near a
      // cell boundary misses an alert metres away on the other side (SCALE-06).
      // This helper is the fix and is currently never called.
      final around = GeohashUtil.getSurroundingGeohashPrefixes(9.0125, 38.7636);
      expect(around, contains(GeohashUtil.encode(9.0125, 38.7636, precision: 5)));
      expect(around.length, greaterThan(1));
    });
  });
}
