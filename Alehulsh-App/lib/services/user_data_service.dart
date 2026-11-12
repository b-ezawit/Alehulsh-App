import '../api/api_runtime.dart';
import 'package:flutter/material.dart';
import '../auth/identity_runtime.dart';
import '../api/account_api.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../models/user_profile_model.dart';
import 'profile_initialization.dart';
import 'account_scope.dart';
import 'location_service.dart';
import 'private_push_service.dart';

/// Central state manager for User Data Tracking & Firebase Synchronization.
class UserDataService {
  static final UserDataService _instance = UserDataService._internal();
  factory UserDataService() => _instance;
  UserDataService._internal();

  final AccountScope _scope = AccountScope();
  bool _syncInitialized = false;
  int _profileRevision = 0;
  FirebaseFirestore get _firestore => FirebaseFirestore.instance;

  /// Reactive notifier for the active profile state
  /// Starts empty for signed-in and signed-out users alike.
  ///
  /// This previously seeded a signed-in user with UserProfile.defaultProfile(),
  /// a mock record carrying the name 'Bezawit M.', an invented phone number and
  /// three invented emergency contacts. Between app start and the Firestore
  /// profile arriving, an SOS raised in that window went out with that mock
  /// data: real alert, fictional victim, fictional contacts.
  ///
  /// An empty profile has an empty uid, which every SOS path already checks.
  final ValueNotifier<UserProfile> profileNotifier =
      ValueNotifier<UserProfile>(UserProfile.guestProfile());
  final ValueNotifier<bool> isFirestoreConnected = ValueNotifier<bool>(false);
  final ValueNotifier<bool> notificationsEnabledNotifier = ValueNotifier<bool>(true);

  UserProfile get currentProfile => profileNotifier.value;
  AppIdentity? get currentUser => IdentityRuntime.current;
  bool get isLoggedIn => IdentityRuntime.current != null && currentProfile.uid.isNotEmpty && currentProfile.uid == IdentityRuntime.current!.uid;
  bool get areNotificationsEnabled => notificationsEnabledNotifier.value;

  Future<void> initNotificationSetting() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      notificationsEnabledNotifier.value = prefs.getBool('notifications_enabled') ?? true;
    } catch (_) {}
  }

  Future<void> setNotificationsEnabled(bool enabled) async {
    notificationsEnabledNotifier.value = enabled;
      final prefs = await SharedPreferences.getInstance();
      if(!await prefs.setBool('notifications_enabled', enabled))throw StateError('Notification preference was not persisted');
      if(ApiRuntime.enabled&&!enabled)await PrivatePushService.instance.disable();
  }

  String? get _owner => IdentityRuntime.current?.uid;
  String _cacheKey(String owner) => 'cached_user_profile:$owner';

  Future<bool> isSOSActiveLocally() async {
    final owner = _owner;
    if (owner == null) return false;
    final prefs = await SharedPreferences.getInstance();
    if (_owner != owner) return false;
    if (prefs.getString('active_alert_id') == owner && prefs.getBool('is_sos_active') == true) {
      await prefs.setBool('is_sos_active:$owner', true);
      await prefs.setString('active_alert_id:$owner', owner);
    }
    return _owner == owner && (prefs.getBool('is_sos_active:$owner') ?? false);
  }

  Future<String?> getActiveSOSAlertIdLocally() async {
    final owner = _owner;
    if (owner == null) return null;
    final prefs = await SharedPreferences.getInstance();
    return _owner == owner ? prefs.getString('active_alert_id:$owner') : null;
  }

  Future<void> setSOSActiveLocally(bool active, [String? alertId]) async {
    final owner = _owner;
    if (owner == null) return;
    final ticket = _scope.capture(owner);
    if (ticket == null) return;
    final prefs = await _scope.read(ticket, SharedPreferences.getInstance);
    if (prefs == null || _owner != owner) return;
    await prefs.setBool('is_sos_active:$owner', active);
    if (!_scope.owns(ticket) || _owner != owner) return;
    if (active && alertId != null) {
      await prefs.setString('active_alert_id:$owner', alertId);
    } else {
      await prefs.remove('active_alert_id:$owner');
      if (prefs.getString('active_alert_id') == owner) {
        await prefs.remove('active_alert_id');
        await prefs.remove('is_sos_active');
      }
    }
  }

  /// Initialize Firebase Auth listener & fetch active user profile from Firestore
  void initializeSync() async {
    if (_syncInitialized) return;
    _syncInitialized = true;
    final initialOwner = _owner;
    final initialRevision = _profileRevision;
    _scope.bind(initialOwner);
    if(ApiRuntime.enabled&&initialOwner!=null)profileNotifier.value=trustedOfflineProfile(initialOwner,email:currentUser?.email??'');
    final initialTicket = initialOwner == null ? null : _scope.capture(initialOwner);
    IdentityRuntime.changes.listen((AppIdentity? user) {
      _scope.bind(user?.uid);
      if (user == null) {
        clearOnSignOut();
      } else {
        if(ApiRuntime.enabled&&currentProfile.uid!=user.uid)profileNotifier.value=trustedOfflineProfile(user.uid,email:user.email??'');
        loadProfileFromFirestore(user.uid);
      }
    });
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = initialOwner == null ? null :
          prefs.getString(_cacheKey(initialOwner)) ?? prefs.getString('cached_user_profile');
      if (raw != null && _owner == initialOwner && initialTicket != null && _scope.owns(initialTicket) && _profileRevision == initialRevision) {
        final cached = ApiRuntime.enabled?trustedCachedProfile(raw,pendingLocationOptOut:prefs.getBool('pending_location_opt_out:$initialOwner')??false):UserProfile.fromJson(raw);
        if (cached.uid == initialOwner) {
          if(ApiRuntime.enabled)await prefs.setString(_cacheKey(initialOwner!),cached.toJson());
          if(_owner!=initialOwner||!_scope.owns(initialTicket))return;
          profileNotifier.value = cached;
          LocationService().configure(owner: initialOwner, enabled: cached.isLocationSharingEnabled);
        }
      }
      // Purge the old global cache, which may contain a plaintext keyword.
      await prefs.remove('cached_user_profile');
    } catch (_) {
      debugPrint('[UserDataService] Cached profile unavailable');
    }
    if(ApiRuntime.enabled&&initialOwner!=null&&_owner==initialOwner&&initialTicket!=null&&_scope.owns(initialTicket))await loadProfileFromFirestore(initialOwner);
  }

  /// Update personal details
  Future<void> updatePersonalInfo({
    required String fullName,
    required String email,
    required String phoneNumber,
    required String homeAddress,
  }) async {
    final updated = currentProfile.copyWith(
      fullName: fullName,
      email: email,
      phoneNumber: phoneNumber,
      homeAddress: homeAddress,
      lastActiveAt: DateTime.now(),
    );
    if(ApiRuntime.enabled){
      final owner=_owner;if(owner==null||updated.uid!=owner)throw StateError('Sign in required');
      final ticket=_scope.capture(owner);if(ticket==null)return;
      await ApiRuntime.account.updateProfile(updated);
      if(_scope.owns(ticket)&&_owner==owner)await loadProfileFromFirestore(owner);
      return;
    }
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
  Future<void> addEmergencyContact(EmergencyContact contact) async {
    if(ApiRuntime.enabled) {
      final owner=_owner;if(owner==null)throw StateError('Sign in required');
      final id=RegExp(r'^[0-9a-f-]{36}$',caseSensitive:false).hasMatch(contact.id)?contact.id:AccountApi.newContactId();
      await ApiRuntime.account.putContact(contact.copyWith(id:id));
      await loadProfileFromFirestore(owner);return;
    }
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
  Future<void> removeEmergencyContact(String id) async {
    if(ApiRuntime.enabled) {
      final owner=_owner;if(owner==null)throw StateError('Sign in required');
      await ApiRuntime.account.removeContact(id);
      await loadProfileFromFirestore(owner);return;
    }
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

  /// Update existing emergency contact
  Future<void> updateEmergencyContact(EmergencyContact contact) async {
    if(ApiRuntime.enabled) {
      final owner=_owner;if(owner==null)throw StateError('Sign in required');
      await ApiRuntime.account.putContact(contact);
      await loadProfileFromFirestore(owner);return;
    }
    final updatedContacts = List<EmergencyContact>.from(currentProfile.emergencyContacts);
    final index = updatedContacts.indexWhere((c) => c.id == contact.id);
    if (index != -1) {
      if (contact.isPrimary) {
        for (int i = 0; i < updatedContacts.length; i++) {
          updatedContacts[i] = updatedContacts[i].copyWith(isPrimary: false);
        }
      }
      updatedContacts[index] = contact;
      final updated = currentProfile.copyWith(
        emergencyContacts: updatedContacts,
        lastActiveAt: DateTime.now(),
      );
      profileNotifier.value = updated;
      logActivity(
        title: "Emergency Contact Updated",
        description: "Updated ${contact.name} (${contact.relationship}) in alert network.",
        type: "contact_updated",
      );
      syncToFirestore();
    }
  }

  /// Immediately clear cached profile & UID for instantaneous logout response
  Future<void> clearOnSignOut() async {
    final owner = currentProfile.uid;
    _scope.bind(null);
    // Invalidates collection synchronously before waiting for preferences.
    final locationCleanup = LocationService().configure(owner: null, enabled: false);
    _profileRevision++;
    profileNotifier.value = UserProfile.guestProfile();
    isFirestoreConnected.value = false;
    await locationCleanup;
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.remove('cached_user_profile');
      if (owner.isNotEmpty) {
        await prefs.remove(_cacheKey(owner));
        await prefs.remove('is_sos_active:$owner');
        await prefs.remove('active_alert_id:$owner');
      }
      if (prefs.getString('active_user_uid') == owner) {
        await prefs.remove('active_user_uid');
      }
      if (prefs.getString('active_alert_id') == owner) {
        await prefs.remove('active_alert_id');
        await prefs.remove('is_sos_active');
      }
    } catch (_) {
      debugPrint('[UserDataService] Local sign-out cleanup failed');
    }
  }

  /// Toggle safety preferences
  Future<void> toggleSafetySetting(String settingKey, bool value) async {
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
    if(ApiRuntime.enabled) {
      final owner=_owner;if(owner==null||updated.uid!=owner)throw StateError('Sign in required');
      final ticket=_scope.capture(owner);if(ticket==null)return;
      // Stop this device immediately on opt-out, even during a network outage.
      if(settingKey=='locationSharing'&&!value) {
        profileNotifier.value=updated;
        await LocationService().configure(owner:owner,enabled:false);
        final prefs=await SharedPreferences.getInstance();await prefs.setBool('pending_location_opt_out:$owner',true);
      }
      const fields={'locationSharing':'locationSharingEnabled','autoAudioRecording':'autoAudioRecording','fakeCall':'fakeCallEnabled','communityAlerts':'communityAlertsEnabled'};
      await ApiRuntime.account.updatePreference(fields[settingKey]!,value);
      if(!_scope.owns(ticket)||_owner!=owner)return;
      if(settingKey=='locationSharing') {
        final prefs=await SharedPreferences.getInstance();await prefs.remove('pending_location_opt_out:$owner');
      }
      await loadProfileFromFirestore(owner);return;
    }
    profileNotifier.value = updated;
    if (settingKey == 'locationSharing') {
      LocationService().configure(owner: _owner, enabled: value);
    }

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
      description: "Emergency submission recorded locally. Delivery is unconfirmed.",
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
    final owner = _owner;
    final profile = currentProfile;
    if (owner == null || profile.uid != owner) return;
    final ticket = _scope.capture(owner);
    if (ticket == null) return;
    try {
      final prefs = await _scope.read(ticket, SharedPreferences.getInstance);
      if (prefs == null || _owner != owner) return;
      await prefs.setString(_cacheKey(owner), profile.toJson());
      if (!_scope.owns(ticket) || _owner != owner) {
        await prefs.remove(_cacheKey(owner));
        return;
      }
      if(ApiRuntime.enabled) {
        // Cache/activity persistence must not replay stale server metadata or
        // consent. Explicit account controls own authenticated PATCH requests.
        return;
      }
      final data = profile.toMap();
      await _firestore.collection('users').doc(owner).set(data, SetOptions(merge: true));
      if (_scope.owns(ticket) && _owner == owner) isFirestoreConnected.value = true;
    } catch (_) {
      if (_scope.owns(ticket) && _owner == owner) isFirestoreConnected.value = false;
      debugPrint('[UserDataService] Profile update could not be confirmed');
    }
  }

  /// Fetch, or initialise, the signed-in user's profile document.
  ///
  /// The missing-document branch used to call syncToFirestore(), which writes
  /// whatever is in memory - at first launch that is the GUEST profile, whose
  /// uid is empty. The document then disagreed with its own id, isLoggedIn
  /// stayed false, and the SOS button refused a genuinely signed-in woman with
  /// "Login Required". resolveProfileOnAuth decides instead, from the
  /// authenticated uid alone.
  Future<void> loadProfileFromFirestore(String uid) async {
    if (_owner != uid) return;
    final ticket = _scope.capture(uid);
    if (ticket == null) return;
    try {
      if(ApiRuntime.enabled) {
        final profile=await ApiRuntime.account.load(uid,email:currentUser?.email??'',previous:currentProfile.uid==uid?currentProfile:null);
        final prefs=await _scope.read(ticket,SharedPreferences.getInstance);
        if(prefs==null||_owner!=uid)return;
        final effective=(prefs.getBool('pending_location_opt_out:$uid')??false)?profile.copyWith(isLocationSharingEnabled:false):profile;
        await prefs.setString(_cacheKey(uid),effective.toJson());
        if(!_scope.owns(ticket)||_owner!=uid)return;
        _profileRevision++;profileNotifier.value=effective;isFirestoreConnected.value=true;
        await LocationService().configure(owner:uid,enabled:effective.isLocationSharingEnabled);return;
      }
      final doc = await _scope.read(ticket, () => _firestore.collection('users').doc(uid).get());
      if (doc == null || _owner != uid) return;
      final resolution = resolveProfileOnAuth(
        authUid: uid, documentUid: uid,
        existingDoc: doc.exists ? doc.data() : null,
        currentProfile: currentProfile,
        authEmail: IdentityRuntime.current?.email,
        authDisplayName: IdentityRuntime.current?.displayName,
      );
      if (!_scope.owns(ticket) || _owner != uid) return;
      if (resolution.needsWrite) {
        final data = resolution.profile.toMap();
        if (ApiRuntime.enabled) data.remove('catName');
        await _firestore.collection('users').doc(uid).set(data, SetOptions(merge: true));
      }
      if (!_scope.owns(ticket) || _owner != uid) return;
      final prefs = await _scope.read(ticket, SharedPreferences.getInstance);
      if (prefs == null || _owner != uid) return;
      await prefs.setString(_cacheKey(uid), resolution.profile.toJson());
      if (!_scope.owns(ticket) || _owner != uid) {
        await prefs.remove(_cacheKey(uid));
        return;
      }
      _profileRevision++;
      profileNotifier.value = resolution.profile;
      LocationService().configure(owner: uid, enabled: resolution.profile.isLocationSharingEnabled);
      isFirestoreConnected.value = true;
    } catch (_) {
      if (_scope.owns(ticket) && _owner == uid) isFirestoreConnected.value = false;
      debugPrint('[UserDataService] Profile load could not be confirmed');
    }
  }
}
