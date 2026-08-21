import 'package:flutter/material.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../models/user_profile_model.dart';

/// Central state manager for User Data Tracking & Firebase Synchronization.
class UserDataService {
  static final UserDataService _instance = UserDataService._internal();
  factory UserDataService() => _instance;
  UserDataService._internal();

  final FirebaseAuth _auth = FirebaseAuth.instance;
  final FirebaseFirestore _firestore = FirebaseFirestore.instance;

  /// Reactive notifier for the active profile state
  final ValueNotifier<UserProfile> profileNotifier = ValueNotifier<UserProfile>(
    FirebaseAuth.instance.currentUser != null
        ? UserProfile.defaultProfile()
        : UserProfile.guestProfile(),
  );
  final ValueNotifier<bool> isFirestoreConnected = ValueNotifier<bool>(false);

  UserProfile get currentProfile => profileNotifier.value;
  User? get currentUser => _auth.currentUser;
  bool get isLoggedIn => _auth.currentUser != null && currentProfile.uid.isNotEmpty;

  /// Check if SOS was active prior to app exit
  Future<bool> isSOSActiveLocally() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      return prefs.getBool('is_sos_active') ?? false;
    } catch (_) {
      return false;
    }
  }

  /// Get active SOS alert ID stored locally
  Future<String?> getActiveSOSAlertIdLocally() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      return prefs.getString('active_alert_id');
    } catch (_) {
      return null;
    }
  }

  /// Set or clear active SOS state locally
  Future<void> setSOSActiveLocally(bool active, [String? alertId]) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setBool('is_sos_active', active);
      if (active && alertId != null) {
        await prefs.setString('active_alert_id', alertId);
      } else if (!active) {
        await prefs.remove('active_alert_id');
      }
    } catch (e) {
      debugPrint("[UserDataService] Error saving SOS state: $e");
    }
  }

  /// Initialize Firebase Auth listener & fetch active user profile from Firestore
  void initializeSync() async {
    // 1. Immediately restore locally cached profile & UID for zero startup lag
    try {
      final prefs = await SharedPreferences.getInstance();
      final localJson = prefs.getString('cached_user_profile');
      if (localJson != null && localJson.isNotEmpty) {
        profileNotifier.value = UserProfile.fromJson(localJson);
        debugPrint("[UserDataService] Restored cached profile: ${profileNotifier.value.fullName} (UID: ${profileNotifier.value.uid})");
      }
    } catch (e) {
      debugPrint("[UserDataService] Error reading cached profile: $e");
    }

    _auth.authStateChanges().listen((User? user) {
      if (user != null) {
        debugPrint("[UserDataService] User logged in: ${user.uid}");
        loadProfileFromFirestore(user.uid);
      } else {
        debugPrint("[UserDataService] No active Firebase Auth user, in Guest Mode");
        if (profileNotifier.value.uid.isEmpty) {
          profileNotifier.value = UserProfile.guestProfile();
        }
      }
    });

    // Initial load if already signed in
    if (_auth.currentUser != null) {
      loadProfileFromFirestore(_auth.currentUser!.uid);
    }
  }

  /// Update personal details
  void updatePersonalInfo({
    required String fullName,
    required String email,
    required String phoneNumber,
    required String homeAddress,
  }) {
    final updated = currentProfile.copyWith(
      fullName: fullName,
      email: email,
      phoneNumber: phoneNumber,
      homeAddress: homeAddress,
      lastActiveAt: DateTime.now(),
    );
    profileNotifier.value = updated;
    logActivity(
      title: "Profile Updated",
      description: "Updated personal contact details & home address.",
      type: "profile_updated",
    );
    syncToFirestore();
  }

  /// Update medical & health info
  void updateMedicalInfo({
    required String bloodType,
    required String medicalNotes,
  }) {
    final updated = currentProfile.copyWith(
      bloodType: bloodType,
      medicalNotes: medicalNotes,
      lastActiveAt: DateTime.now(),
    );
    profileNotifier.value = updated;
    logActivity(
      title: "Medical Data Updated",
      description: "Updated emergency blood group ($bloodType) and health notes.",
      type: "profile_updated",
    );
    syncToFirestore();
  }

  /// Add emergency contact
  void addEmergencyContact(EmergencyContact contact) {
    final updatedContacts = List<EmergencyContact>.from(currentProfile.emergencyContacts);
    if (contact.isPrimary) {
      // Unmark other primary contacts
      for (int i = 0; i < updatedContacts.length; i++) {
        updatedContacts[i] = updatedContacts[i].copyWith(isPrimary: false);
      }
    }
    updatedContacts.add(contact);

    // Recalculate safety score
    int newScore = (currentProfile.safetyScore + 3).clamp(0, 100);

    final updated = currentProfile.copyWith(
      emergencyContacts: updatedContacts,
      safetyScore: newScore,
      lastActiveAt: DateTime.now(),
    );
    profileNotifier.value = updated;

    logActivity(
      title: "Emergency Contact Added",
      description: "Added ${contact.name} (${contact.relationship}) to alert network.",
      type: "contact_added",
    );
    syncToFirestore();
  }

  /// Remove emergency contact
  void removeEmergencyContact(String id) {
    final updatedContacts = List<EmergencyContact>.from(currentProfile.emergencyContacts);
    updatedContacts.removeWhere((c) => c.id == id);

    final updated = currentProfile.copyWith(
      emergencyContacts: updatedContacts,
      lastActiveAt: DateTime.now(),
    );
    profileNotifier.value = updated;

    logActivity(
      title: "Emergency Contact Removed",
      description: "Removed emergency contact entry.",
      type: "contact_removed",
    );
    syncToFirestore();
  }

  /// Toggle safety preferences
  void toggleSafetySetting(String settingKey, bool value) {
    UserProfile updated;
    switch (settingKey) {
      case 'locationSharing':
        updated = currentProfile.copyWith(isLocationSharingEnabled: value);
        break;
      case 'autoAudioRecording':
        updated = currentProfile.copyWith(isAutoAudioRecording: value);
        break;
      case 'fakeCall':
        updated = currentProfile.copyWith(isFakeCallEnabled: value);
        break;
      case 'communityAlerts':
        updated = currentProfile.copyWith(isCommunityAlertsEnabled: value);
        break;
      default:
        return;
    }
    profileNotifier.value = updated;

    logActivity(
      title: "Safety Setting Changed",
      description: "Set $settingKey to ${value ? 'ON' : 'OFF'}.",
      type: "settings_change",
    );
    syncToFirestore();
  }

  /// Record user activities & emergency triggers for tracking
  void logActivity({
    required String title,
    required String description,
    required String type,
  }) {
    final newActivity = UserActivityLog(
      id: "act_${DateTime.now().millisecondsSinceEpoch}",
      title: title,
      description: description,
      timestamp: DateTime.now(),
      type: type,
    );

    final updatedActivities = List<UserActivityLog>.from(currentProfile.activities);
    updatedActivities.insert(0, newActivity);

    // Keep max 50 recent activities
    if (updatedActivities.length > 50) {
      updatedActivities.removeLast();
    }

    profileNotifier.value = currentProfile.copyWith(
      activities: updatedActivities,
      lastActiveAt: DateTime.now(),
    );
  }

  /// Log emergency SOS trigger count
  void recordSOSTriggered() {
    final updated = currentProfile.copyWith(
      alertsTriggeredCount: currentProfile.alertsTriggeredCount + 1,
      lastActiveAt: DateTime.now(),
    );
    profileNotifier.value = updated;
    logActivity(
      title: "EMERGENCY SOS Triggered!",
      description: "High priority emergency broadcast dispatched to network.",
      type: "sos",
    );
    syncToFirestore();
  }

  /// Log response to community alert
  void recordAlertResponded() {
    final updated = currentProfile.copyWith(
      alertsRespondedCount: currentProfile.alertsRespondedCount + 1,
      safetyScore: (currentProfile.safetyScore + 2).clamp(0, 100),
      lastActiveAt: DateTime.now(),
    );
    profileNotifier.value = updated;
    logActivity(
      title: "Community Responder Action",
      description: "Responded to distress signal in your area.",
      type: "sos_response",
    );
    syncToFirestore();
  }

  /// Save active user profile directly to Firebase Firestore
  Future<void> syncToFirestore() async {
    try {
      final targetUid = _auth.currentUser?.uid ?? currentProfile.uid;
      // Also cache locally in SharedPreferences for instant app startup & native Kotlin services
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('cached_user_profile', currentProfile.toJson());
      await prefs.setString('active_user_uid', targetUid);

      await _firestore.collection('users').doc(targetUid).set(
            currentProfile.toMap(),
            SetOptions(merge: true),
          );
      isFirestoreConnected.value = true;
      debugPrint("[UserDataService] Successfully synced profile to Firestore for UID: $targetUid");
    } catch (e) {
      debugPrint("[UserDataService] Error syncing to Firestore: $e");
    }
  }

  /// Fetch user profile document from Firebase Firestore
  Future<void> loadProfileFromFirestore(String uid) async {
    try {
      final doc = await _firestore.collection('users').doc(uid).get();
      if (doc.exists && doc.data() != null) {
        profileNotifier.value = UserProfile.fromMap(doc.data()!);
        isFirestoreConnected.value = true;
        // Cache to local SharedPreferences
        final prefs = await SharedPreferences.getInstance();
        await prefs.setString('cached_user_profile', profileNotifier.value.toJson());
        await prefs.setString('active_user_uid', uid);
        debugPrint("[UserDataService] Loaded profile from Firestore for UID: $uid");
      } else {
        // Document doesn't exist yet, save current profile as initial document
        await syncToFirestore();
      }
    } catch (e) {
      debugPrint("[UserDataService] Error loading from Firestore: $e");
    }
  }
}
