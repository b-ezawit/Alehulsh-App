import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:geolocator/geolocator.dart';
import '../models/alert_model.dart';
import 'alert_service.dart';
import 'user_data_service.dart';
import 'location_service.dart';

/// Emergency Ping Notification Service
/// Utilizes Flutter Local Notifications + Real-Time Firestore Proximity Geofencing (500m Radius)
/// To dispatch instant high-priority Heads-Up Notification Pings to nearby users.
class EmergencyPingService {
  static final EmergencyPingService _instance = EmergencyPingService._internal();
  factory EmergencyPingService() => _instance;
  EmergencyPingService._internal();

  final FlutterLocalNotificationsPlugin _notificationsPlugin = FlutterLocalNotificationsPlugin();
  final LocationService _locationService = LocationService();
  final UserDataService _userDataService = UserDataService();
  final AlertService _alertService = AlertService();

  // Navigation and Highlight Notifiers triggered on notification clicks
  static final ValueNotifier<String?> targetHighlightAlertId = ValueNotifier<String?>(null);
  static final ValueNotifier<int> targetNavigationTab = ValueNotifier<int>(0);

  bool _isInitialized = false;
  StreamSubscription<List<EmergencyAlert>>? _alertsSubscription;
  final Set<String> _notifiedAlertIds = {};

  /// Initialize notification channel, icon, tap listener, and start background proximity stream monitor
  Future<void> initialize() async {
    if (_isInitialized) return;

    const AndroidInitializationSettings androidSettings =
        AndroidInitializationSettings('@mipmap/ic_launcher');

    const InitializationSettings initSettings = InitializationSettings(
      android: androidSettings,
    );

    await _notificationsPlugin.initialize(
      initSettings,
      onDidReceiveNotificationResponse: (NotificationResponse response) {
        debugPrint("[EmergencyPingService] Notification tapped! Payload: ${response.payload}");
        if (response.payload != null && response.payload!.isNotEmpty) {
          targetHighlightAlertId.value = response.payload;
          targetNavigationTab.value = 1; // Switch to Alerts tab (WomenForWomenScreen at Index 1)
        }
      },
    );

    // Check if app was opened via notification tap when closed
    final launchDetails = await _notificationsPlugin.getNotificationAppLaunchDetails();
    if (launchDetails != null && launchDetails.didNotificationLaunchApp) {
      final payload = launchDetails.notificationResponse?.payload;
      if (payload != null && payload.isNotEmpty) {
        targetHighlightAlertId.value = payload;
        targetNavigationTab.value = 1;
      }
    }

    // Request notification permissions for Android 13+ (API 33+)
    final androidImplementation =
        _notificationsPlugin.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
    if (androidImplementation != null) {
      await androidImplementation.requestNotificationsPermission();
    }

    // Listen for high-priority FCM emergency messages dispatched by Cloud Functions
    try {
      FirebaseMessaging.onMessage.listen((RemoteMessage message) {
        debugPrint("[EmergencyPingService] FCM Emergency broadcast received: ${message.data}");
        final alertId = message.data['alertId']?.toString() ?? '';
        final userName = message.data['userName']?.toString() ?? 'Nearby Protector';
        final locationName = message.data['locationName']?.toString() ?? 'Emergency Location';
        final distStr = message.data['distStr']?.toString() ?? '500m SOS Radar Alert';

        if (alertId.isNotEmpty) {
          sendProximityPingNotification(
            alertId: alertId,
            userName: userName,
            distanceText: distStr,
            locationName: locationName,
          );
        }
      });
    } catch (e) {
      debugPrint("[EmergencyPingService] Note initializing FCM listener: $e");
    }

    _isInitialized = true;
    debugPrint("[EmergencyPingService] Initialized successfully with Cloud Function FCM support.");

    // Start 500m Proximity Radar Monitor
    startProximityRadarMonitor();
  }

  /// Real-time Proximity Radar Monitor
  /// Continuously checks all active alerts in Firestore against live device GPS
  /// If an alert is detected within 500m (0.5 km) radius OR from a designated Emergency Contact, fires an instant Emergency Ping Notification!
  void startProximityRadarMonitor() {
    _alertsSubscription?.cancel();

    _alertsSubscription = _alertService.alertsStream.listen((alerts) async {
      final currentProfile = _userDataService.currentProfile;
      final currentAuthUid = FirebaseAuth.instance.currentUser?.uid ?? '';
      final profileUid = currentProfile.uid.trim();
      final profileName = currentProfile.fullName.trim().toLowerCase();
      final currentUserEmail = currentProfile.email.trim().toLowerCase();
      final currentUserPhoneClean = currentProfile.phoneNumber.trim().replaceAll(' ', '').replaceAll('-', '');

      final contactEmails = currentProfile.emergencyContacts
          .map((c) => c.email.trim().toLowerCase())
          .where((e) => e.isNotEmpty)
          .toSet();
      final contactNames = currentProfile.emergencyContacts
          .map((c) => c.name.trim().toLowerCase())
          .where((n) => n.isNotEmpty)
          .toSet();
      final contactPhones = currentProfile.emergencyContacts
          .map((c) => c.phone.trim().replaceAll(' ', '').replaceAll('-', ''))
          .where((p) => p.isNotEmpty)
          .toSet();
      final contactUids = currentProfile.emergencyContacts
          .map((c) => c.id.trim())
          .where((id) => id.isNotEmpty)
          .toSet();

      // Use cached GPS position first (non-blocking) to avoid stalling notification dispatch
      double? myLat = _locationService.currentPosition?.latitude;
      double? myLng = _locationService.currentPosition?.longitude;
      if (myLat == null || myLng == null) {
        final Position? currentPos = await _locationService.getCurrentLocation();
        myLat = currentPos?.latitude;
        myLng = currentPos?.longitude;
      }

      // 1. STRICT RULE: NEVER ALERT THE SENDER WHEN THEY REQUEST FOR HELP!
      final cachedAlertId = await _userDataService.getActiveSOSAlertIdLocally();

      for (var alert in alerts) {
        if (alert.status != 'active') continue;

        if (currentAuthUid.isNotEmpty && alert.userId == currentAuthUid) continue;
        if (profileUid.isNotEmpty && alert.userId == profileUid) continue;
        if (profileUid.isNotEmpty && alert.id == profileUid) continue;
        if (cachedAlertId != null && (alert.id == cachedAlertId || alert.userId == cachedAlertId)) continue;
        if (profileName.isNotEmpty && alert.userName.trim().toLowerCase() == profileName) continue;

        // Key to deduplicate notification pings per alert event
        String pingKey = "${alert.id}_${alert.timestamp.millisecondsSinceEpoch}";
        if (_notifiedAlertIds.contains(pingKey)) continue;

        // Check if viewer is an emergency contact of alerter or vice-versa
        bool isEmergencyContact = false;

        if (contactEmails.contains(alert.alerterEmail.toLowerCase()) || contactEmails.contains(alert.userId.toLowerCase())) isEmergencyContact = true;
        if (contactNames.contains(alert.userName.trim().toLowerCase())) isEmergencyContact = true;
        if (contactUids.contains(alert.userId)) isEmergencyContact = true;
        if (alert.alerterPhone.isNotEmpty) {
          final cleanAlerterPhone = alert.alerterPhone.replaceAll(' ', '').replaceAll('-', '');
          if (contactPhones.contains(cleanAlerterPhone)) isEmergencyContact = true;
        }

        if (currentUserEmail.isNotEmpty && alert.emergencyContactEmails.any((e) => e.toLowerCase() == currentUserEmail)) {
          isEmergencyContact = true;
        }
        if (currentUserPhoneClean.isNotEmpty && alert.emergencyContactPhones.any((p) => p == currentUserPhoneClean || currentUserPhoneClean.endsWith(p) || p.endsWith(currentUserPhoneClean))) {
          isEmergencyContact = true;
        }
        if (profileUid.isNotEmpty && alert.emergencyContactUids.contains(profileUid)) {
          isEmergencyContact = true;
        }
        if (profileName.isNotEmpty && alert.emergencyContactNames.any((n) => n.toLowerCase() == profileName)) {
          isEmergencyContact = true;
        }

        double distanceMeters = 0.0;
        bool isWithin500m = false;

        if (myLat != null && myLng != null) {
          distanceMeters = Geolocator.distanceBetween(
            myLat,
            myLng,
            alert.latitude,
            alert.longitude,
          );
          isWithin500m = distanceMeters <= 500.0;
        }

        // Rule: Dispatch Ping if within 500m radius OR if user is a designated Emergency Contact!
        if (isEmergencyContact || isWithin500m) {
          _notifiedAlertIds.add(pingKey);
          int metersRounded = distanceMeters.round();
          String distStr = isEmergencyContact
              ? (myLat != null ? "Emergency Contact • ${metersRounded}m away" : "Emergency Contact Alert")
              : "$metersRounded meters away";

          await sendProximityPingNotification(
            alertId: alert.id.isNotEmpty ? alert.id : alert.userId,
            userName: alert.userName,
            distanceText: distStr,
            locationName: alert.locationName,
            isUrgent: alert.isUrgent || isEmergencyContact,
          );
        }
      }
    });
  }

  /// Dispatch high-priority Heads-Up Notification Ping with sound, vibration, and exact person title
  Future<void> sendProximityPingNotification({
    required String alertId,
    required String userName,
    required String distanceText,
    required String locationName,
    bool isUrgent = false,
  }) async {
    if (!UserDataService().areNotificationsEnabled) {
      debugPrint("[EmergencyPingService] Notifications disabled in Settings. Suppressing ping.");
      return;
    }
    const AndroidNotificationDetails androidDetails = AndroidNotificationDetails(
      'emergency_ping_channel',
      'Emergency Proximity Pings',
      channelDescription: 'Instant high-priority alerts when someone triggers SOS within 500 meters.',
      importance: Importance.max,
      priority: Priority.high,
      enableLights: true,
      enableVibration: true,
      playSound: true,
      color: Color(0xFFE91E63),
      ledColor: Color(0xFFFF0055),
      ledOnMs: 1000,
      ledOffMs: 500,
      fullScreenIntent: true,
      visibility: NotificationVisibility.public,
      category: AndroidNotificationCategory.alarm,
    );

    const NotificationDetails notificationDetails = NotificationDetails(
      android: androidDetails,
    );

    int notificationId = alertId.hashCode;

    // Requirement: Show exactly "[Name] is requesting for help!!" for receivers
    String title = "🚨 $userName is requesting for help!!";
    String body = "$userName is in danger ($distanceText) near $locationName. Tap to help!";

    await _notificationsPlugin.show(
      notificationId,
      title,
      body,
      notificationDetails,
      payload: alertId,
    );

    debugPrint("[EmergencyPingService] 🚨 Dispatched notification: '$title' to nearby responder!");
  }

  void dispose() {
    _alertsSubscription?.cancel();
  }
}
