import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import '../api/api_runtime.dart';
import '../firebase_env.dart';
import 'private_notification_settings.dart';

/// Background/terminated wakeup displays no emergency metadata and performs
/// no privileged operation. Opening always requires current API authorization.
/// A background OS hint is not a verified receipt or human acknowledgment.
@pragma('vm:entry-point')
Future<void> privatePushBackground(RemoteMessage message) async {
  if (!ApiRuntime.requested) return;
  if (!await privateNotificationsAllowed(requireConsent: true)) return;
  final id = message.data['deliveryId'];
  if (id is! String || !RegExp(r'^[0-9a-fA-F-]{36}$').hasMatch(id)) return;
  try {
    if (Firebase.apps.isEmpty) {
      await Firebase.initializeApp(options: optionsForSelectedEnv());
    }
    final notifications = FlutterLocalNotificationsPlugin();
    await notifications.initialize(const InitializationSettings(
        android: AndroidInitializationSettings('@mipmap/ic_launcher')));
    await notifications.show(
        0,
        'Alehulsh',
        'Open the app to check for an update.',
        NotificationDetails(
            android: AndroidNotificationDetails(
                'alehulsh_private_updates_v1', 'Private updates',
                importance: Importance.high,
                priority: Priority.high,
                visibility: NotificationVisibility.private,
                tag: 'delivery:$id')),
        payload: 'private:$id');
  } catch (_) {
    /* OS delivery/display cannot be guaranteed; foreground inbox recovers. */
  }
}
