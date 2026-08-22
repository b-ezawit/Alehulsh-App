import 'package:flutter/material.dart';
import 'package:firebase_core/firebase_core.dart';
import 'firebase_options.dart';
import 'theme/app_theme.dart';
import 'screens/main_navigation_screen.dart';
import 'services/user_data_service.dart';
import 'services/emergency_ping_service.dart';
import 'services/emergency_gesture_service.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  try {
    await Firebase.initializeApp(
      options: DefaultFirebaseOptions.currentPlatform,
    );
    debugPrint("[Firebase] App initialized successfully!");
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
