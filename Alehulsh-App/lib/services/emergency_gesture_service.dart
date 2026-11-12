import 'location_evidence.dart';
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../auth/identity_runtime.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'user_data_service.dart';
import 'emergency_ping_service.dart';
import 'alert_service.dart';
import 'location_service.dart';
import '../api/api_runtime.dart';
import '../api/trusted_hardware_trigger.dart';
import '../api/migration_api_client.dart';

/// Emergency Hardware SOS Service
/// Listens to: 5x Physical Power Button Press only
class EmergencyGestureService {
  static final EmergencyGestureService _instance = EmergencyGestureService._internal();
  factory EmergencyGestureService() => _instance;
  EmergencyGestureService._internal();

  static const MethodChannel _platformChannel =
      MethodChannel('com.example.alehulsh_app/hardware_sos');

  /// How long to wait for the server to acknowledge the alert before telling
  /// her it is only queued.
  ///
  /// A compromise, not a measured value. Too short and a slow-but-working
  /// Ethiopian mobile connection gets reported as undelivered; too long and she
  /// stands there with no feedback. NEEDS MEASUREMENT on a real network.
  static const Duration _serverAckTimeout = Duration(seconds: 10);

  /// Tell her what actually happened, whatever happened.
  ///
  /// The screen may be off and the phone in her pocket, so the notification is
  /// the only channel she has. Every path through the trigger posts exactly one
  /// of these, including the failure paths, which previously posted nothing.
  ///
  /// Reuses notification id 71002 so an outcome replaces an earlier one rather
  /// than stacking contradictory messages.
  Future<void> _notifyTriggerOutcome({
    required String title,
    required String body,
  }) async {
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
      // Not VISIBILITY_PUBLIC. On a locked phone this text is readable by
      // whoever is holding it, including the person she is escaping.
      visibility: NotificationVisibility.private,
    );
    try {
      await _notificationsPlugin.show(
        71002,
        title,
        body,
        const NotificationDetails(android: androidDetails),
      );
    } catch (e) {
      // Never let a notification failure swallow the SOS outcome.
      debugPrint("[EmergencyGestureService] Could not post outcome notification: $e");
    }
  }

  final UserDataService _userDataService = UserDataService();
  final AlertService _alertService = AlertService();
  final LocationService _locationService = LocationService();
  final FlutterLocalNotificationsPlugin _notificationsPlugin = FlutterLocalNotificationsPlugin();

  bool _isListening = false;
  DateTime? _lastTriggerTime;
  String? _lastTriggerOwner;

  /// Notify native layer and dart layer that user cancelled SOS.
  /// Re-arms a new emergency immediately.
  Future<void> recordCancellation() async {
    _lastTriggerTime = null;
    try {
      await _platformChannel.invokeMethod('recordCancellation');
    } catch (_) {}

  }

  /// Start monitoring physical power button SOS callbacks
  void startListening() {
    if (_isListening) return;

    _platformChannel.setMethodCallHandler((call) async {
      if (call.method == 'onNotificationOpen') {
        final id = call.arguments is Map ? call.arguments['alertId'] : null;
        EmergencyPingService.targetHighlightAlertId.value = id is String && id.isNotEmpty ? id : null;
        EmergencyPingService.targetNavigationTab.value = 1;
        return; // Navigation alone cannot create an emergency.
      }
      if (call.method == 'onHardwareSOS') {
        final trustedRequest=ApiRuntime.enabled?trustedHardwareRequest(call.arguments,IdentityRuntime.current?.uid):null;
        if(ApiRuntime.enabled&&trustedRequest==null){
          await _notifyTriggerOutcome(title:'SOS not confirmed',body:'Open Alehulsh to check pending alerts or request help.');return;
        }
        final source = call.arguments is Map ? call.arguments['source'] : '5x Power Button Gesture';
        debugPrint("[EmergencyGestureService] 🚨 Native $source received!");
        await triggerHardwareSOS(triggerSource: source?.toString() ?? "5x Power Button Gesture",requestId:trustedRequest);
      }
    });

    _isListening = true;
    debugPrint("[EmergencyGestureService] 5x Power Button SOS listener active.");
  }

  /// Full SOS trigger via 5x Power Button — writes Firestore, shows notification, opens Emergency tab
  Future<void> triggerHardwareSOS({String triggerSource = "5x Power Button Gesture",String? requestId}) async {
    final now = DateTime.now();
    final triggerOwner=IdentityRuntime.current?.uid,epoch=ApiRuntime.enabled?ApiRuntime.client.accountEpoch():null;
    bool sameAccount()=>IdentityRuntime.current?.uid==triggerOwner&&(!ApiRuntime.enabled||ApiRuntime.client.accountEpoch()==epoch);

    // Debounce to prevent multiple triggers within 20 seconds
    if (_lastTriggerOwner==triggerOwner&&_lastTriggerTime != null && now.difference(_lastTriggerTime!).inSeconds < 20) {
      debugPrint("[EmergencyGestureService] Debounced trigger from $triggerSource.");
      return;
    }
    _lastTriggerTime = now;
    _lastTriggerOwner=triggerOwner;

    // Check if an SOS is already active — do not double-write
    final isAlreadyActive = await _userDataService.isSOSActiveLocally();
    if(!sameAccount())return;
    if (isAlreadyActive) {
      debugPrint("[EmergencyGestureService] SOS already active; navigating to Emergency tab.");
      EmergencyPingService.targetNavigationTab.value = 0;
      return;
    }

    final profile = _userDataService.currentProfile;
    final authUid = IdentityRuntime.current?.uid;
    if (authUid == null || profile.uid != authUid) {
      await _notifyTriggerOutcome(title: 'SOS not sent',
        body: 'Open Alehulsh and sign in to confirm your account. Call for help directly if needed.');
      return;
    }

    // Mark intent before attempting the write, so a crash between the button
    // press and the server acknowledgement is recoverable on next launch.
    await _userDataService.setSOSActiveLocally(true, profile.uid);

    try {
      // No fallback coordinate. This previously defaulted to (9.0125, 38.7636),
      // Addis Ababa city centre, so an SOS raised without GPS asserted she was
      // downtown. Responders would be dispatched to the wrong place while the
      // alert looked complete. Absent location is sent as absent.
      final pos = await _locationService.getCurrentLocation();
      final position = pos ?? _locationService.currentPosition;
      final fix = LocationEvidence.decide(consent: profile.isLocationSharingEnabled,
        latitude: position?.latitude, longitude: position?.longitude,
        accuracyMeters: position?.accuracy, measuredAt: position?.timestamp, now: DateTime.now());
      final lat = fix.latitude;
      final lng = fix.longitude;
      if (IdentityRuntime.current?.uid != profile.uid) return;

      // Firestore resolves set() on SERVER acknowledgement, so offline this
      // never completes and never throws. Without a timeout the trigger would
      // hang here silently and she would get no feedback whatsoever.
      final creation = _alertService
          .createSOSAlert(
            profile: profile,
            latitude: lat,
            longitude: lng,
            locationName: fix.label,
            accuracyMeters: fix.accuracyMeters, locationAgeMs: fix.ageMs,
            message: "EMERGENCY DISTRESS TRIGGERED",
            isUrgent: true,
            requestId:requestId,
          );
      final alertId=await (_alertService.usesTrustedApi?creation:creation.timeout(_serverAckTimeout));
      if(!sameAccount())return;

      // Confirmed accepted by the server.
      await _userDataService.setSOSActiveLocally(true, alertId);
      _userDataService.recordSOSTriggered();

      await _notifyTriggerOutcome(
        title: "SOS received by backend",
        body: "Delivery and a response are not yet confirmed. Check Alehulsh for updates.",
      );
      debugPrint("[EmergencyGestureService] SOS acknowledged by server via $triggerSource: $alertId");
    } on TimeoutException {
      if(!sameAccount())return;
      // The write is still queued in Firestore's local cache and will be sent
      // when connectivity returns. It has NOT reached anyone yet, and we must
      // not imply that it has.
      await _userDataService.setSOSActiveLocally(true, profile.uid);
      _userDataService.recordSOSTriggered();

      await _notifyTriggerOutcome(
        title: "Alert NOT yet delivered",
        body: "Saved on your phone and will send when you have signal. Call for help directly if you can.",
      );
      debugPrint("[EmergencyGestureService] SOS queued locally, no server ack within $_serverAckTimeout.");
    } catch (e) {
      if(!sameAccount())return;
      if(e is PendingSosNeedsAction){
        await _userDataService.setSOSActiveLocally(true,profile.uid);
        if(sameAccount())await _notifyTriggerOutcome(title:'SOS pending',body:'Saved on this device. Sign-in or review is required; delivery is unconfirmed.');
        return;
      }
      // Terminal failure: withdraw the intent so the next launch does not
      // restore an alert that was never accepted.
      await _userDataService.setSOSActiveLocally(false);

      // A failed SOS must be loud. Silence here is indistinguishable from
      // success to someone who cannot look at the screen.
      await _notifyTriggerOutcome(
        title: "SOS FAILED to send",
        body: "Your alert could not be sent. Open Alehulsh and try again, or call for help directly.",
      );
      debugPrint("[EmergencyGestureService] Error triggering SOS: $e");
    }

    // Navigate to Emergency tab to show active SOS
    EmergencyPingService.targetNavigationTab.value = 0;
  }

  void stopListening() {
    _isListening = false;
  }
}
