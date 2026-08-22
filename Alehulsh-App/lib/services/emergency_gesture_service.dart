import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:geolocator/geolocator.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'alert_service.dart';
import 'user_data_service.dart';
import 'location_service.dart';
import 'localization_service.dart';
import '../models/user_profile_model.dart';

/// Emergency Hardware SOS Service
/// Listens to: 5x Physical Power Button Press & Android OS Emergency SOS
/// Shaking is completely disabled.
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
  DateTime? _lastCancellationTime;

  /// Notify native layer and dart layer that user cancelled SOS.
  /// Prevents any triggers for the next 20 seconds.
  Future<void> recordCancellation() async {
    _lastCancellationTime = DateTime.now();
    _lastTriggerTime = _lastCancellationTime;
    try {
      await _platformChannel.invokeMethod('recordCancellation');
    } catch (_) {}
    debugPrint("[EmergencyGestureService] SOS cancelled. Hardware triggers locked for 20s.");
  }

  /// Start monitoring physical power button SOS callbacks
  void startListening() {
    if (_isListening) return;

    // Listen for Native Android Service Callbacks (5x Power Button / OS Emergency)
    _platformChannel.setMethodCallHandler((call) async {
      if (call.method == 'onHardwareSOS') {
        final source = call.arguments is Map ? call.arguments['source'] : '5x Power Button Gesture';
        debugPrint("[EmergencyGestureService] 🚨 Native $source received!");
        triggerHardwareSOS(triggerSource: source?.toString() ?? "5x Power Button Gesture");
      }
    });

    _isListening = true;
    debugPrint("[EmergencyGestureService] 5x Power Button SOS listener active.");
  }

  /// Trigger emergency SOS broadcast from 5x Power Button
  Future<void> triggerHardwareSOS({String triggerSource = "5x Power Button Gesture"}) async {
    final now = DateTime.now();

    // Check cancellation cooldown (20s)
    if (_lastCancellationTime != null && now.difference(_lastCancellationTime!).inSeconds < 20) {
      debugPrint("[EmergencyGestureService] Ignoring trigger: user recently cancelled SOS.");
      return;
    }

    // Debounce to prevent multiple triggers within 20 seconds
    if (_lastTriggerTime != null && now.difference(_lastTriggerTime!).inSeconds < 20) {
      debugPrint("[EmergencyGestureService] Debounced trigger from $triggerSource.");
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
  }
}
