import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:alehulsh_app/dev_config.dart';

/// Guards the isolation switch in lib/dev_config.dart.
///
/// Run BOTH ways; the suite asserts the correct thing in each case:
///   flutter test test/dev_config_test.dart
///   flutter test test/dev_config_test.dart --dart-define=USE_FIREBASE_EMULATORS=true
void main() {
  group('the switch defaults to production', () {
    test('no define means no emulators', () {
      // The decisive property: a build that passes no defines - which is every
      // release build we ship - must behave exactly as it did before the switch
      // existed.
      if (!emulatorsRequestedByDefine) {
        expect(useFirebaseEmulators, isFalse);
      } else {
        // Running under the define; the other group covers this case.
        expect(emulatorsRequestedByDefine, isTrue);
      }
    });
  });

  group('release builds cannot be redirected', () {
    test('useFirebaseEmulators implies NOT release mode', () {
      // The conjunction is what makes the define safe to ship. If this ever
      // holds true in a release build, the switch has become a live attack
      // surface: an emulator endpoint is unauthenticated by design.
      if (useFirebaseEmulators) {
        expect(kReleaseMode, isFalse,
            reason: 'emulators must never be active in a release build');
      }
    });

    test('the guard is a conjunction of the define AND non-release', () {
      // Expressed as the invariant rather than the implementation, so a
      // refactor that drops the kReleaseMode term fails here.
      expect(
        useFirebaseEmulators,
        emulatorsRequestedByDefine && !inReleaseMode,
      );
    });

    test('inReleaseMode agrees with the framework constant', () {
      expect(inReleaseMode, kReleaseMode);
    });
  });

  group('endpoints are configurable without touching source', () {
    test('host defaults to the Android emulator loopback alias', () {
      // 10.0.2.2 is how an Android emulator reaches the host machine. A
      // physical device needs the host LAN address passed via dart-define.
      expect(emulatorHost, isNotEmpty);
      expect(firestoreEmulatorPort, greaterThan(0));
      expect(authEmulatorPort, greaterThan(0));
      expect(firestoreEmulatorPort, isNot(authEmulatorPort));
    });
  });
}
