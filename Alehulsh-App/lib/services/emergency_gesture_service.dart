import 'dart:async';
import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:geolocator/geolocator.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:sensors_plus/sensors_plus.dart';
import 'alert_service.dart';
import 'user_data_service.dart';
import 'location_service.dart';
import 'localization_service.dart';
import '../models/user_profile_model.dart';

/// Emergency Gesture & Hardware SOS Service
/// Listens to: Native Android Power Button (5 rapid presses / screen toggles) & Emergency Phone Shake
class EmergencyGestureService {
  static final EmergencyGestureService _instance = EmergencyGestureService._internal();
  factory EmergencyGestureService() => _instance;
  EmergencyGestureService._internal();

  static const MethodChannel _platformChannel =
      MethodChannel('com.example.alehulsh_app/hardware_sos');

  final AlertService _alertService = AlertService();
  final UserDataService _userDataService = UserDataService();
  final LocationService _locationService = LocationService();
  final FlutterLocalNotificationsPlugin _notificationsPlugin = FlutterLocalNotificationsPlugin();

  bool _isListening = false;
  DateTime? _lastTriggerTime;
  DateTime? _firstShakeTimestamp;
  DateTime? _lastShakeTimestamp;
  int _shakeCounter = 0;
  StreamSubscription<AccelerometerEvent>? _accelSubscription;

  /// Start monitoring native Power button 5-press events and phone shake
  void startListening() {
    if (_isListening) return;

    // 1. Listen for Native Android Hardware Buttons (Power 5x, Volume 3x, OS SOS)
    _platformChannel.setMethodCallHandler((call) async {
      if (call.method == 'onHardwareSOS') {
        final source = call.arguments is Map ? call.arguments['source'] : 'Power Button 5-Click SOS';
        debugPrint("[EmergencyGestureService] 🚨 Native $source received!");
        triggerHardwareSOS(triggerSource: source?.toString() ?? "Power Button 5-Click SOS");
      }
    });

    // 2. Listen for Emergency Phone Shake Gesture via Accelerometer (3 deliberate vigorous shakes)
    try {
      _accelSubscription = accelerometerEventStream().listen((AccelerometerEvent event) {
        double gX = event.x / 9.80665;
        double gY = event.y / 9.80665;
        double gZ = event.z / 9.80665;
        double gForce = math.sqrt(gX * gX + gY * gY + gZ * gZ);

        // Require strong deliberate force (3.2g) to prevent false positives
        if (gForce > 3.2) {
          final now = DateTime.now();

          // Reset counter if too much time (3.5s) has passed since the last shake
          if (_lastShakeTimestamp != null && now.difference(_lastShakeTimestamp!).inMilliseconds > 3500) {
            _shakeCounter = 0;
            _firstShakeTimestamp = null;
          }

          // Enforce minimum 500ms spacing between distinct shakes
          if (_lastShakeTimestamp == null || now.difference(_lastShakeTimestamp!).inMilliseconds >= 500) {
            _lastShakeTimestamp = now;
            _firstShakeTimestamp ??= now;
            _shakeCounter++;

            debugPrint("[EmergencyGestureService] Deliberate shake $_shakeCounter/3 (gForce: ${gForce.toStringAsFixed(1)})");

            if (_shakeCounter >= 3) {
              _shakeCounter = 0;
              _firstShakeTimestamp = null;
              _lastShakeTimestamp = null;
              debugPrint("[EmergencyGestureService] 🚨 3x Deliberate Phone Shake SOS Gesture detected!");
              triggerHardwareSOS(triggerSource: "Emergency Shake Gesture (3x)");
            }
          }
        }
      });
    } catch (e) {
      debugPrint("[EmergencyGestureService] Accelerometer init error: $e");
    }

    _isListening = true;
    debugPrint("[EmergencyGestureService] Hardware Power Button & Shake SOS listeners active.");
  }

  /// Trigger emergency SOS broadcast from phone hardware power button or shake
  Future<void> triggerHardwareSOS({String triggerSource = "Power Button 5-Click SOS"}) async {
    // Debounce to prevent multiple triggers within 6 seconds
    final now = DateTime.now();
    if (_lastTriggerTime != null && now.difference(_lastTriggerTime!).inSeconds < 6) {
      return;
    }
    _lastTriggerTime = now;

    // Check if an SOS is already active - do not overwrite existing note or voice notes
    final isAlreadyActive = await _userDataService.isSOSActiveLocally();
    if (isAlreadyActive) {
      debugPrint("[EmergencyGestureService] SOS is already active on device; preserving existing alert card.");
      return;
    }

    var profile = _userDataService.currentProfile;
    if (profile.uid.isEmpty) {
      final currentAuthUid = FirebaseAuth.instance.currentUser?.uid ?? '';
      if (currentAuthUid.isNotEmpty) {
        profile = profile.copyWith(
          uid: currentAuthUid,
          fullName: profile.fullName.isNotEmpty
              ? profile.fullName
              : (FirebaseAuth.instance.currentUser?.displayName ?? 'Alehulsh User'),
        );
      } else {
        // Use default profile fallback if guest
        profile = UserProfile.defaultProfile();
      }
    }

    try {
      Position? currentPos = await _locationService.getCurrentLocation();
      double lat = currentPos?.latitude ?? _locationService.currentPosition?.latitude ?? 9.0125;
      double lng = currentPos?.longitude ?? _locationService.currentPosition?.longitude ?? 38.7636;

      String alertId = await _alertService.createSOSAlert(
        profile: profile,
        latitude: lat,
        longitude: lng,
        locationName: "Live GPS",
        message: "🚨 EMERGENCY DISTRESS TRIGGERED! Please send help immediately!",
        isUrgent: true,
      );

      // Lock SOS active state locally so app reopen restores it immediately
      await _userDataService.setSOSActiveLocally(true, alertId);
      _userDataService.recordSOSTriggered();

      // Show instant notification & vibration feedback
      const AndroidNotificationDetails androidDetails = AndroidNotificationDetails(
        'emergency_ping_channel',
        'Emergency Proximity Pings',
        channelDescription: 'Emergency trigger confirmation',
        importance: Importance.max,
        priority: Priority.high,
        enableVibration: true,
        playSound: true,
        color: Color(0xFFE91E63),
        fullScreenIntent: true,
      );

      final loc = LocalizationService();
      await _notificationsPlugin.show(
        71002,
        loc.isAmharic ? "🚨 ጥሪዎ ተልኳል!" : "🚨 Your Alert has been sent.",
        loc.isAmharic
            ? "የአደጋ ጊዜ ጥሪ ($triggerSource) ለአቅራቢያዎ ያሉ ሰዎች እና እውቂያዎች ተልኳል!"
            : "Emergency SOS broadcast sent to nearby network and contacts via $triggerSource!",
        const NotificationDetails(android: androidDetails),
      );

      debugPrint("[EmergencyGestureService] 🚨 Emergency SOS successfully triggered via $triggerSource! Alert ID: $alertId");
    } catch (e) {
      debugPrint("[EmergencyGestureService] Error triggering SOS: $e");
    }
  }

  void stopListening() {
    _isListening = false;
    _accelSubscription?.cancel();
    _accelSubscription = null;
  }
}
