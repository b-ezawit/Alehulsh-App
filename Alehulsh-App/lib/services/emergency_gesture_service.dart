import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'user_data_service.dart';
import 'emergency_ping_service.dart';
import 'alert_service.dart';
import 'location_service.dart';
import '../models/user_profile_model.dart';

/// Emergency Hardware SOS Service
/// Listens to: 5x Physical Power Button Press only
class EmergencyGestureService {
  static final EmergencyGestureService _instance = EmergencyGestureService._internal();
  factory EmergencyGestureService() => _instance;
  EmergencyGestureService._internal();

  static const MethodChannel _platformChannel =
      MethodChannel('com.example.alehulsh_app/hardware_sos');

  final UserDataService _userDataService = UserDataService();
  final AlertService _alertService = AlertService();
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

    _platformChannel.setMethodCallHandler((call) async {
      if (call.method == 'onHardwareSOS') {
        final source = call.arguments is Map ? call.arguments['source'] : '5x Power Button Gesture';
        debugPrint("[EmergencyGestureService] 🚨 Native $source received!");
        await triggerHardwareSOS(triggerSource: source?.toString() ?? "5x Power Button Gesture");
      }
    });

    _isListening = true;
    debugPrint("[EmergencyGestureService] 5x Power Button SOS listener active.");
  }

  /// Full SOS trigger via 5x Power Button — writes Firestore, shows notification, opens Emergency tab
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

    // Check if an SOS is already active — do not double-write
    final isAlreadyActive = await _userDataService.isSOSActiveLocally();
    if (isAlreadyActive) {
      debugPrint("[EmergencyGestureService] SOS already active; navigating to Emergency tab.");
      EmergencyPingService.targetNavigationTab.value = 0;
      return;
    }

    var profile = _userDataService.currentProfile;
    if (profile.uid.isEmpty) {
      final authUid = FirebaseAuth.instance.currentUser?.uid ?? '';
      if (authUid.isNotEmpty) {
        profile = profile.copyWith(
          uid: authUid,
          fullName: profile.fullName.isNotEmpty
              ? profile.fullName
              : (FirebaseAuth.instance.currentUser?.displayName ?? 'Alehulsh User'),
        );
      } else {
        profile = UserProfile.defaultProfile();
      }
    }

    try {
      // Get live location
      final pos = await _locationService.getCurrentLocation();
      final lat = pos?.latitude ?? _locationService.currentPosition?.latitude ?? 9.0125;
      final lng = pos?.longitude ?? _locationService.currentPosition?.longitude ?? 38.7636;

      // Write SOS alert to Firestore — the EmergencyScreen Firestore stream will pick this up
      final alertId = await _alertService.createSOSAlert(
        profile: profile,
        latitude: lat,
        longitude: lng,
        locationName: "Live GPS",
        message: "🚨 EMERGENCY DISTRESS TRIGGERED! Please send help immediately!",
        isUrgent: true,
      );

      // Persist locally so the app restores state after reopen
      await _userDataService.setSOSActiveLocally(true, alertId);
      _userDataService.recordSOSTriggered();

      // Show high-priority confirmation notification
      const androidDetails = AndroidNotificationDetails(
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
      await _notificationsPlugin.show(
        71002,
        "🚨 Your Alert has been sent.",
        "Emergency SOS broadcast sent via $triggerSource! Help is on the way.",
        const NotificationDetails(android: androidDetails),
      );

      debugPrint("[EmergencyGestureService] ✅ SOS fully triggered via $triggerSource! Alert: $alertId");
    } catch (e) {
      debugPrint("[EmergencyGestureService] Error triggering SOS: $e");
    }

    // Navigate to Emergency tab to show active SOS
    EmergencyPingService.targetNavigationTab.value = 0;
  }

  void stopListening() {
    _isListening = false;
  }
}
