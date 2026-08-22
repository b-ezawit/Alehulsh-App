import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'user_data_service.dart';
import 'emergency_ping_service.dart';

/// Emergency Hardware SOS Service
/// Listens to: 5x Physical Power Button Press only
class EmergencyGestureService {
  static final EmergencyGestureService _instance = EmergencyGestureService._internal();
  factory EmergencyGestureService() => _instance;
  EmergencyGestureService._internal();

  static const MethodChannel _platformChannel =
      MethodChannel('com.example.alehulsh_app/hardware_sos');

  final UserDataService _userDataService = UserDataService();

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
        handleNativeSosTrigger(triggerSource: source?.toString() ?? "5x Power Button Gesture");
      }
    });

    _isListening = true;
    debugPrint("[EmergencyGestureService] 5x Power Button SOS listener active.");
  }

  /// Handle native SOS trigger: sync state and bring emergency tab to view
  Future<void> handleNativeSosTrigger({String triggerSource = "5x Power Button Gesture"}) async {
    final now = DateTime.now();

    // Check cancellation cooldown (20s)
    if (_lastCancellationTime != null && now.difference(_lastCancellationTime!).inSeconds < 20) {
      debugPrint("[EmergencyGestureService] Ignoring trigger: user recently cancelled SOS.");
      return;
    }

    // Debounce
    if (_lastTriggerTime != null && now.difference(_lastTriggerTime!).inSeconds < 20) {
      debugPrint("[EmergencyGestureService] Debounced trigger from $triggerSource.");
      return;
    }
    _lastTriggerTime = now;

    final uid = _userDataService.currentProfile.uid.isNotEmpty
        ? _userDataService.currentProfile.uid
        : (FirebaseAuth.instance.currentUser?.uid ?? '');

    if (uid.isNotEmpty) {
      await _userDataService.setSOSActiveLocally(true, uid);
      _userDataService.recordSOSTriggered();
    }

    // Automatically focus the Emergency tab
    EmergencyPingService.targetNavigationTab.value = 0;
  }

  void stopListening() {
    _isListening = false;
  }
}
