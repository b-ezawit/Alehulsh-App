import 'package:flutter/material.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_core/firebase_core.dart';
import 'dev_config.dart';
import 'firebase_env.dart';
import 'theme/app_theme.dart';
import 'screens/main_navigation_screen.dart';
import 'services/user_data_service.dart';
import 'services/emergency_ping_service.dart';
import 'services/emergency_gesture_service.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  try {
    // Throws when no environment was named, or when dev was asked for before
    // its options exist. Never falls back to production.
    final firebaseApp = await Firebase.initializeApp(
      options: optionsForSelectedEnv(),
    );

    // The project we CONFIGURED and the project that is actually in use are
    // different questions - on Android google-services.json wins over these
    // options. Verify them against each other before anything reads or writes.
    assertResolvedProject(firebaseApp);

    // Redirect to local emulators BEFORE anything reads or writes, so no call
    // can reach the live project first. Every service that holds a
    // FirebaseFirestore or FirebaseAuth field is a lazy `static final`
    // singleton, and none is constructed until after this block, so the
    // redirection is in place before the first operation either way.
    //
    // No-op unless the dart-define is set, and compiled out of release builds
    // entirely - see dev_config.dart.
    if (useFirebaseEmulators) {
      FirebaseFirestore.instance.useFirestoreEmulator(
        emulatorHost,
        firestoreEmulatorPort,
      );
      await FirebaseAuth.instance.useAuthEmulator(
        emulatorHost,
        authEmulatorPort,
      );
    }

    // Say plainly which backend this process is attached to. Without it the
    // only way to know whether a test run reached the live project was to go
    // and look for the damage afterwards.
    //
    // The project id is not a secret - it ships inside the APK in
    // google-services.json - and nothing below logs a key, a token or any
    // user data.
    // The RESOLVED project, not the intended one. The previous line reported
    // what Dart asked for, which under two projects could confidently name the
    // wrong one.
    final projectId = firebaseApp.options.projectId;
    final envName = selectedEnv.defineValue;
    if (useFirebaseEmulators) {
      debugPrint(
        "[Firebase] TARGET=EMULATORS env=$envName project=$projectId "
        "firestore=$emulatorHost:$firestoreEmulatorPort "
        "auth=$emulatorHost:$authEmulatorPort "
        "(no traffic reaches the live project)",
      );
    } else {
      debugPrint(
        "[Firebase] TARGET=LIVE env=$envName project=$projectId "
        "(emulatorsRequested=$emulatorsRequestedByDefine releaseMode=$inReleaseMode)",
      );
    }

    UserDataService().initializeSync();
    await UserDataService().initNotificationSetting();
    await EmergencyPingService().initialize();
    EmergencyGestureService().startListening();
  } catch (e) {
    debugPrint("[Firebase] Initialization error: $e");
  }
  runApp(const AlehulshApp());
}

final ValueNotifier<ThemeMode> themeModeNotifier = ValueNotifier<ThemeMode>(ThemeMode.dark);

class AlehulshApp extends StatelessWidget {
  const AlehulshApp({super.key});

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<ThemeMode>(
      valueListenable: themeModeNotifier,
      builder: (context, currentMode, child) {
        return MaterialApp(
          title: 'Alehulsh - Women Emergency Network',
          debugShowCheckedModeBanner: false,
          theme: AppTheme.lightTheme,
          darkTheme: AppTheme.darkTheme,
          themeMode: currentMode,
          home: const MainNavigationScreen(),
        );
      },
    );
  }
}
