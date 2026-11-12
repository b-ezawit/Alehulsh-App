import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import '../auth/identity_runtime.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:geolocator/geolocator.dart';
import '../models/alert_model.dart';
import 'alert_service.dart';
import 'user_data_service.dart';
import 'location_service.dart';
import 'private_push_service.dart';
import '../api/private_notification_api.dart';
import '../api/api_runtime.dart';
import 'private_notification_settings.dart';

/// Emergency Ping Notification Service
/// Utilizes Flutter Local Notifications + Real-Time Firestore Proximity Geofencing (500m Radius)
/// To dispatch instant high-priority Heads-Up Notification Pings to nearby users.
/// Build the proximity-ping notification body.
///
/// Top-level and pure so it can be unit tested without the notifications
/// plugin; see test/location_label_test.dart.
///
/// "near X" is dropped when there is no trustworthy place to name. The old
/// template interpolated unconditionally and produced
/// "... near Location unavailable", which both reads badly and implies a
/// proximity we cannot assert.
String composePingBody({
  required String userName,
  required String distanceText,
  required String locationName,
}) {
  final place = locationName.trim();
  final hasPlace = place.isNotEmpty && place != EmergencyAlert.locationUnavailable;

  if (hasPlace) {
    return "$userName is in danger ($distanceText) near $place. Tap to help!";
  }
  return "$userName is in danger ($distanceText). Her location is unavailable. Tap to help!";
}

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
  final Set<String> _privateNotificationTags={};

  Future<void> _privateHint(String deliveryId,bool opened) async {
    final client=ApiRuntime.client,owner=client.knownSubject(),epoch=client.accountEpoch();
    if(owner==null)return;
    try {
      if(!opened&&!await privateNotificationsAllowed(requireConsent:true))return;
      if(opened)await _notificationsPlugin.cancel(0,tag:'delivery:$deliveryId');
      final hint=await PrivateNotificationApi(client).receipt(deliveryId,opened:opened);
      if(client.knownSubject()!=owner||client.accountEpoch()!=epoch)return;
      startProximityRadarMonitor();
      if(!hint.active){
        await _notificationsPlugin.cancel(0,tag:hint.incidentId);
        _privateNotificationTags.remove(hint.incidentId);return;
      }
      if(opened){
        final inbox=await client.inbox();
        if(client.knownSubject()!=owner||client.accountEpoch()!=epoch)return;
        final items=inbox['items'];
        if(items is! List||!items.any((item)=>item is Map&&item['alertId']==hint.incidentId))return;
        targetHighlightAlertId.value=hint.incidentId;targetNavigationTab.value=1;
      }else{
        _privateNotificationTags.add(hint.incidentId);
        await _notificationsPlugin.show(0,'Alehulsh','Open the app to check for an update.',
          NotificationDetails(android:AndroidNotificationDetails('alehulsh_private_updates_v1','Private updates',
            importance:Importance.high,priority:Priority.high,visibility:NotificationVisibility.private,tag:hint.incidentId)),
          payload:'private:$deliveryId');
        if(client.knownSubject()!=owner||client.accountEpoch()!=epoch){
          await _notificationsPlugin.cancel(0,tag:hint.incidentId);
          _privateNotificationTags.remove(hint.incidentId);
        }
      }
    }catch(_){ /* Unauthenticated, expired and offline hints never authorize navigation. */ }
  }

  void _openPayload(String? payload){
    if(payload==null||payload.isEmpty)return;
    if(_alertService.usesTrustedApi){
      if(payload.startsWith('private:'))_privateHint(payload.substring(8),true);
      return;
    }
    targetHighlightAlertId.value=payload;targetNavigationTab.value=1;
  }

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
        debugPrint('[EmergencyPingService] Notification navigation requested');
        _openPayload(response.payload);
      },
    );

    // Check if app was opened via notification tap when closed
    final launchDetails = await _notificationsPlugin.getNotificationAppLaunchDetails();
    if (launchDetails != null && launchDetails.didNotificationLaunchApp) {
      final payload = launchDetails.notificationResponse?.payload;
      _openPayload(payload);
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
        if (_alertService.usesTrustedApi) {
          PrivatePushService.instance.handle(message);
          return;
        }
        debugPrint('[EmergencyPingService] Emergency refetch hint received');
        final alertId = message.data['alertId']?.toString() ?? '';
        final userName = message.data['userName']?.toString() ?? 'Nearby Protector';
        // A push that carries no label means nobody recorded where she was.
        // 'Emergency Location' implied there was one; this is the same string
        // every other reader and writer uses for "unknown".
        final locationName = message.data['locationName']?.toString().trim().isNotEmpty == true
            ? message.data['locationName'].toString().trim()
            : EmergencyAlert.locationUnavailable;
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
    if(_alertService.usesTrustedApi){
      var notificationOwner=ApiRuntime.client.knownSubject(),notificationEpoch=ApiRuntime.client.accountEpoch();
      IdentityRuntime.changes.listen((_){
        final owner=ApiRuntime.client.knownSubject(),epoch=ApiRuntime.client.accountEpoch();
        if(owner==notificationOwner&&epoch==notificationEpoch)return;
        notificationOwner=owner;notificationEpoch=epoch;
        for(final tag in _privateNotificationTags){_notificationsPlugin.cancel(0,tag:tag);}
        _privateNotificationTags.clear();_notifiedAlertIds.clear();
        targetHighlightAlertId.value=null;
      });
      try{await PrivatePushService.instance.initialize(_privateHint);}catch(_){/* Foreground inbox remains available. */}
    }
    debugPrint("[EmergencyPingService] Initialized successfully with Cloud Function FCM support.");

    // Start 500m Proximity Radar Monitor
    startProximityRadarMonitor();
  }

  /// Real-time Proximity Radar Monitor
  /// Continuously checks all active alerts in Firestore against live device GPS
  /// If an alert is detected within 500m (0.5 km) radius OR from a designated Emergency Contact, fires an instant Emergency Ping Notification!
  void startProximityRadarMonitor() {
    _alertsSubscription?.cancel();
    final trustedOwner=_alertService.usesTrustedApi?ApiRuntime.client.knownSubject():null;
    final trustedEpoch=_alertService.usesTrustedApi?ApiRuntime.client.accountEpoch():null;

    _alertsSubscription = _alertService.alertsStream.listen((alerts) async {
      if(_alertService.usesTrustedApi){
        if(ApiRuntime.client.knownSubject()!=trustedOwner||ApiRuntime.client.accountEpoch()!=trustedEpoch)return;
        // The authorized inbox is rendered in-app. Push receipt processing
        // supplies private notifications; never synthesize delivery facts or
        // publish a profile/location through a radar notification.
        final live=alerts.map((a)=>a.id).toSet();
        for(final tag in _privateNotificationTags.toList()){
          if(!live.contains(tag)){await _notificationsPlugin.cancel(0,tag:tag);_privateNotificationTags.remove(tag);}
        }
        return;
      }
      final currentProfile = _userDataService.currentProfile;
      final currentAuthUid = IdentityRuntime.current?.uid ?? '';
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
      if (IdentityRuntime.current?.uid != currentAuthUid) return;

      for (var alert in alerts) {
        if (!['active', 'escalated'].contains(alert.status) || alert.isExpired) continue;

        if (currentAuthUid.isNotEmpty && alert.userId == currentAuthUid) continue;
        if (profileUid.isNotEmpty && alert.userId == profileUid) continue;
        if (profileUid.isNotEmpty && alert.id == profileUid) continue;
        if (cachedAlertId != null && (alert.id == cachedAlertId || alert.userId == cachedAlertId)) continue;
        if (profileName.isNotEmpty && alert.userName.trim().toLowerCase() == profileName) continue;

        // Key to deduplicate notification pings per alert event
        String pingKey = "$currentAuthUid:${alert.incidentKey ?? alert.id}:${alert.timestamp.millisecondsSinceEpoch}";
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

        // Null until proven: a distance is only real when we know BOTH where
        // the responder is and where the alert is. Previously defaulted to 0.0,
        // which surfaced as "0 meters away" on an alert with no location.
        double? distanceMeters;
        bool isWithin500m = false;

        final alertLat = alert.latitude;
        final alertLng = alert.longitude;
        if (myLat != null && myLng != null && alertLat != null && alertLng != null) {
          distanceMeters = Geolocator.distanceBetween(
            myLat,
            myLng,
            alertLat,
            alertLng,
          );
          isWithin500m = distanceMeters <= 500.0;
        }

        // Rule: Dispatch Ping if within 500m radius OR if user is a designated Emergency Contact!
        if (IdentityRuntime.current?.uid != currentAuthUid) return;
        if (isEmergencyContact || isWithin500m || _alertService.usesTrustedApi) {
          _notifiedAlertIds.add(pingKey);
          // Say nothing about distance unless we have one. An emergency contact
          // is still pinged for an alert we cannot locate - she is the person
          // best placed to call and ask where her friend is - but she is told
          // the location is unknown rather than shown a fabricated distance.
          final String distStr;
          if (distanceMeters == null) {
            distStr = isEmergencyContact
                ? "Emergency Contact Alert"
                : "Distance unknown";
          } else {
            final metersRounded = distanceMeters.round();
            distStr = isEmergencyContact
                ? "Emergency Contact • ${metersRounded}m away"
                : "$metersRounded meters away";
          }

          await sendProximityPingNotification(
            alertId: alert.id.isNotEmpty ? alert.id : alert.userId,
            userName: alert.userName,
            distanceText: distStr,
            locationName: alert.locationName,
            isUrgent: alert.isUrgent || isEmergencyContact,
          );
        }
      }
    }, onError: (_) { debugPrint('[EmergencyPingService] Authorized inbox is unavailable'); });
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
      visibility: NotificationVisibility.private,
      category: AndroidNotificationCategory.alarm,
    );

    const NotificationDetails notificationDetails = NotificationDetails(
      android: androidDetails,
    );

    int notificationId = alertId.hashCode;

    // Requirement: Show exactly "[Name] is requesting for help!!" for receivers
    String title = "🚨 $userName is requesting for help!!";
    String body = composePingBody(
      userName: userName,
      distanceText: distanceText,
      locationName: locationName,
    );

    await _notificationsPlugin.show(
      notificationId,
      title,
      body,
      notificationDetails,
      payload: alertId,
    );

    debugPrint('[EmergencyPingService] Local notification posted');
  }

  void dispose() {
    _alertsSubscription?.cancel();
  }
}
