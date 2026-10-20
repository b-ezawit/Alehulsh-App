/// Development-only switches, resolved at COMPILE time.
///
/// Every value here comes from `--dart-define` and defaults to the production
/// behaviour, so a build that passes no defines - which is every release build -
/// behaves exactly as before. There is no runtime toggle and no stored
/// preference, because a switch that can be flipped on a shipped build is a
/// switch an attacker can flip.
library;

import 'package:flutter/foundation.dart';

/// Point Firebase at local emulators instead of the live project.
///
/// Exists because the app otherwise talks to the production project on every
/// run, so there was no way to exercise sign-in, a profile load or an SOS
/// without writing test data into real users' data. Enable with:
///
///   flutter run --dart-define=USE_FIREBASE_EMULATORS=true
///
/// Ignored entirely in release builds: see [useFirebaseEmulators].
const bool _emulatorsRequested =
    bool.fromEnvironment('USE_FIREBASE_EMULATORS', defaultValue: false);

/// Host the emulators are reachable on from the device under test.
///
/// Defaults to the Android emulator's alias for the host machine's loopback.
/// A physical phone on the same network needs the host's LAN address instead.
const String emulatorHost =
    String.fromEnvironment('FIREBASE_EMULATOR_HOST', defaultValue: '10.0.2.2');

const int firestoreEmulatorPort =
    int.fromEnvironment('FIRESTORE_EMULATOR_PORT', defaultValue: 8080);

const int authEmulatorPort =
    int.fromEnvironment('AUTH_EMULATOR_PORT', defaultValue: 9099);

/// Whether to actually redirect Firebase to the emulators.
///
/// Belt and braces: the define must be set AND the build must not be a release
/// build. kReleaseMode is a compile-time constant, so in a release build this
/// folds to `false` and the emulator wiring is tree-shaken out of the binary
/// rather than merely skipped.
bool get useFirebaseEmulators => _emulatorsRequested && !kReleaseMode;

/// Whether the define asked for emulators, regardless of whether the build
/// honours it. Exposed only so startup logging can explain WHY emulators are
/// off in a release build that was given the define.
bool get emulatorsRequestedByDefine => _emulatorsRequested;

/// Exposed for the same reason. kReleaseMode is a compile-time constant.
bool get inReleaseMode => kReleaseMode;
