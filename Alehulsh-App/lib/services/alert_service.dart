import 'package:flutter/material.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import '../models/alert_model.dart';
import '../models/user_profile_model.dart';
import '../utils/geohash_util.dart';

class CancelSOSResult {
  final bool isSuccess;
  final String? errorMessage;
  final bool isSecurityMismatch;

  const CancelSOSResult({
    required this.isSuccess,
    this.errorMessage,
    this.isSecurityMismatch = false,
  });

  static const CancelSOSResult success = CancelSOSResult(isSuccess: true);
}

class AlertService {
  static final AlertService _instance = AlertService._internal();
  factory AlertService() => _instance;
  AlertService._internal();

  final FirebaseFirestore _firestore = FirebaseFirestore.instance;

  /// Optimized Real-time stream of active alerts with 2-hour TTL filtering
  Stream<List<EmergencyAlert>> get alertsStream {
    final now = DateTime.now();
    return _firestore
        .collection('active_alerts')
        .where('status', isEqualTo: 'active')
        .limit(60)
        .snapshots()
        .map((snapshot) {
      final List<EmergencyAlert> allDocs = [];
      for (var doc in snapshot.docs) {
        try {
          final data = doc.data();
          if (data.isNotEmpty) {
            final alert = EmergencyAlert.fromMap(data, docId: doc.id);
            // 2-Hour TTL Safety Net: Drop any expired alerts immediately
            if (!alert.isExpired) {
              allDocs.add(alert);
            }
          }
        } catch (e) {
          debugPrint("[AlertService] Note parsing doc ${doc.id}: $e");
        }
      }

      // Deduplicate strictly by userId so each user has ONLY 1 card (the most recent active alert)
      final Map<String, EmergencyAlert> uniqueByUser = {};

      for (var alert in allDocs) {
        if (alert.status != 'active' || alert.isExpired) continue;
        final uid = alert.userId.isNotEmpty ? alert.userId : alert.id;
        
        if (!uniqueByUser.containsKey(uid)) {
          uniqueByUser[uid] = alert;
        } else {
          // Keep the newer one
          if (alert.timestamp.isAfter(uniqueByUser[uid]!.timestamp)) {
            uniqueByUser[uid] = alert;
          }
        }
      }

      final List<EmergencyAlert> list = uniqueByUser.values.toList();
      list.sort((a, b) => b.timestamp.compareTo(a.timestamp));
      return list;
    }).handleError((error) {
      debugPrint("[AlertService] alertsStream error handled: $error");
      return <EmergencyAlert>[];
    });
  }

  /// Spatial Geohash 500m Radar Stream: Reads only alerts in the user's localized geohash cluster
  Stream<List<EmergencyAlert>> getNearbyAlertsStream({
    required double userLat,
    required double userLng,
    double radiusInKm = 0.5,
  }) {
    // 5-character Geohash covers ~2.4km surrounding grid (encompassing 500m radar)
    final geohashPrefix = GeohashUtil.getFCMTopicGeohash(userLat, userLng);
    final queryRange = GeohashUtil.getGeohashQueryRange(geohashPrefix);

    return _firestore
        .collection('active_alerts')
        .where('status', isEqualTo: 'active')
        .where('geohash', isGreaterThanOrEqualTo: queryRange[0])
        .where('geohash', isLessThanOrEqualTo: queryRange[1])
        .limit(30)
        .snapshots()
        .map((snapshot) {
      final List<EmergencyAlert> nearby = [];
      for (var doc in snapshot.docs) {
        try {
          final alert = EmergencyAlert.fromMap(doc.data(), docId: doc.id);
          if (alert.status == 'active' && !alert.isExpired) {
            final distKm = alert.calculateDistanceKm(userLat, userLng);
            if (distKm <= radiusInKm) {
              nearby.add(alert);
            }
          }
        } catch (_) {}
      }
      nearby.sort((a, b) => a.calculateDistanceKm(userLat, userLng).compareTo(b.calculateDistanceKm(userLat, userLng)));
      return nearby;
    }).handleError((error) {
      debugPrint("[AlertService] Geohash query error handled (fallback to global): $error");
      return <EmergencyAlert>[];
    });
  }

  /// Real-time stream of active alert for a specific user by UID (Guarantees persistence across pages)
  Stream<EmergencyAlert?> getUserActiveAlertStream(String userId) {
    if (userId.isEmpty) {
      return Stream.value(null);
    }
    return _firestore
        .collection('active_alerts')
        .doc(userId)
        .snapshots()
        .map((doc) {
      try {
        if (doc.exists && doc.data() != null) {
          final alert = EmergencyAlert.fromMap(doc.data()!, docId: doc.id);
          if (alert.status == 'active' && !alert.isExpired) {
            return alert;
          }
        }
      } catch (e) {
        debugPrint("[AlertService] Error reading active user alert: $e");
      }
      return null;
    }).handleError((error) {
      debugPrint("[AlertService] getUserActiveAlertStream error handled: $error");
      return null;
    });
  }

  /// Create or Update the user's single SOS alert document in Firestore using doc(profile.uid)
  Future<String> createSOSAlert({
    required UserProfile profile,
    required double latitude,
    required double longitude,
    required String locationName,
    String message = '',
    bool isUrgent = false,
  }) async {
    try {
      // Document ID is strictly profile.uid to guarantee 1 alert per user
      final docRef = _firestore.collection('active_alerts').doc(profile.uid);

      final emergencyEmails = profile.emergencyContacts
          .map((e) => e.email.trim().toLowerCase())
          .where((e) => e.isNotEmpty)
          .toList();
      final emergencyPhones = profile.emergencyContacts
          .map((e) => e.phone.trim().replaceAll(' ', '').replaceAll('-', ''))
          .where((e) => e.isNotEmpty)
          .toList();
      final emergencyNames = profile.emergencyContacts
          .map((e) => e.name.trim().toLowerCase())
          .where((e) => e.isNotEmpty)
          .toList();
      final emergencyUids = profile.emergencyContacts
          .map((e) => e.id.trim())
          .where((e) => e.isNotEmpty)
          .toList();

      // Check if alert document already exists to preserve existing voice notes & responders
      List<VoiceNoteItem> currentVoiceNotes = [];
      List<String> currentResponders = [];

      try {
        final existingDoc = await docRef.get();
        if (existingDoc.exists && existingDoc.data() != null) {
          final existingAlert = EmergencyAlert.fromMap(existingDoc.data()!, docId: existingDoc.id);
          if (existingAlert.status == 'active' && !existingAlert.isExpired) {
            currentVoiceNotes = existingAlert.voiceNotes;
            currentResponders = existingAlert.responders;
          }
        }
      } catch (e) {
        debugPrint("[AlertService] Note fetching existing alert: $e");
      }

      final now = DateTime.now();
      final newAlert = EmergencyAlert(
        id: docRef.id,
        userId: profile.uid,
        userName: profile.fullName.isNotEmpty ? profile.fullName : "User",
        userAvatar: profile.fullName.isNotEmpty ? profile.fullName.trim()[0].toUpperCase() : 'U',
        alerterPhone: profile.phoneNumber,
        alerterEmail: profile.email,
        latitude: latitude,
        longitude: longitude,
        locationName: locationName,
        timestamp: now,
        expiresAt: now.add(const Duration(hours: 2)), // 2-Hour TTL Safety Net
        geohash: GeohashUtil.encode(latitude, longitude),
        category: isUrgent ? 'Urgent Distress Alert' : 'Emergency SOS Alert',
        message: message,
        isUrgent: isUrgent,
        status: 'active',
        voiceNotes: currentVoiceNotes,
        responders: currentResponders,
        emergencyContactEmails: emergencyEmails,
        emergencyContactPhones: emergencyPhones,
        emergencyContactNames: emergencyNames,
        emergencyContactUids: emergencyUids,
      );

      // Single atomic write to Firestore - resilient on low bandwidth networks
      await docRef.set(newAlert.toMap());
      debugPrint("[AlertService] Single active SOS Alert saved with 2h TTL & Geohash to doc(${profile.uid})");

      // Cleanup any stray old duplicate documents for this user in background
      _cleanupDuplicateUserDocs(profile.uid);

      return docRef.id;
    } catch (e) {
      debugPrint("[AlertService] Error creating SOS alert: $e");
      rethrow;
    }
  }

  /// Clean up any duplicate legacy documents for a user in active_alerts collection
  Future<void> _cleanupDuplicateUserDocs(String userId) async {
    try {
      final query = await _firestore
          .collection('active_alerts')
          .where('userId', isEqualTo: userId)
          .get();

      for (var doc in query.docs) {
        if (doc.id != userId) {
          await doc.reference.delete();
          debugPrint("[AlertService] Cleaned up legacy duplicate alert doc: ${doc.id}");
        }
      }
    } catch (e) {
      debugPrint("[AlertService] Note cleaning duplicates: $e");
    }
  }

  /// Toggle Urgent status for active alert
  Future<void> toggleUrgentStatus(String alertId, bool isUrgent) async {
    try {
      await _firestore.collection('active_alerts').doc(alertId).update({
        'isUrgent': isUrgent,
        'category': isUrgent ? 'Urgent Distress Alert' : 'Emergency SOS Alert',
      });
    } catch (e) {
      debugPrint("[AlertService] Error toggling urgent: $e");
    }
  }

  /// Update optional message note for active alert
  Future<void> updateMessageNote(String alertId, String message) async {
    try {
      await _firestore.collection('active_alerts').doc(alertId).update({
        'message': message.trim(),
      });
      debugPrint("[AlertService] Updated message note for $alertId");
    } catch (e) {
      debugPrint("[AlertService] Error updating message note: $e");
    }
  }

  /// Add a recorded voice note to an active alert (Appends seamlessly to the single active alert)
  Future<void> addVoiceNote(String alertId, VoiceNoteItem voiceNote) async {
    try {
      await _firestore.collection('active_alerts').doc(alertId).update({
        'voiceNotes': FieldValue.arrayUnion([voiceNote.toMap()]),
      });
      debugPrint("[AlertService] Voice note added to alert $alertId");
    } catch (e) {
      debugPrint("[AlertService] Error adding voice note: $e");
    }
  }

  /// Cancel SOS alert and remove it from Firestore (verifies cat's name security code)
  Future<CancelSOSResult> cancelSOSAlert({
    required String alertId,
    required String userCatName,
    required String inputCatName,
  }) async {
    final expected = userCatName.trim().toLowerCase();
    final input = inputCatName.trim().toLowerCase();

    // Security verification: compare normalized inputs.
    // If expected is empty or not configured, allow 'milo' (default fallback) or non-empty match.
    bool matched = false;
    if (expected.isNotEmpty) {
      matched = (expected == input);
    } else {
      matched = (input == 'milo' || input.isNotEmpty);
    }

    if (!matched) {
      debugPrint("[AlertService] Cancellation rejected: Security cat name mismatch! Expected: '$expected', Entered: '$input'");
      return const CancelSOSResult(
        isSuccess: false,
        isSecurityMismatch: true,
        errorMessage: "Security verification code mismatch.",
      );
    }

    try {
      await _firestore.collection('active_alerts').doc(alertId).delete();
      debugPrint("[AlertService] Alert $alertId cancelled and permanently removed from Firestore.");
      return CancelSOSResult.success;
    } catch (e) {
      debugPrint("[AlertService] Error cancelling alert from Firestore: $e");
      return CancelSOSResult(
        isSuccess: false,
        isSecurityMismatch: false,
        errorMessage: e.toString(),
      );
    }
  }

  /// Accept an alert as a responder (increments responder count in real time)
  Future<void> acceptAlert(String alertId, String responderUserId) async {
    try {
      await _firestore.collection('active_alerts').doc(alertId).update({
        'responders': FieldValue.arrayUnion([responderUserId]),
      });
      debugPrint("[AlertService] User $responderUserId accepted alert $alertId");
    } catch (e) {
      debugPrint("[AlertService] Error accepting alert: $e");
    }
  }

  /// Cancel response to an alert (decrements responder count in real time)
  Future<void> unacceptAlert(String alertId, String responderUserId) async {
    try {
      await _firestore.collection('active_alerts').doc(alertId).update({
        'responders': FieldValue.arrayRemove([responderUserId]),
      });
      debugPrint("[AlertService] User $responderUserId cancelled response to alert $alertId");
    } catch (e) {
      debugPrint("[AlertService] Error cancelling alert response: $e");
    }
  }

  /// Delete ALL alerts from Firestore active_alerts collection
  Future<void> deleteAllAlerts() async {
    try {
      final snapshot = await _firestore.collection('active_alerts').get();
      final batch = _firestore.batch();
      for (var doc in snapshot.docs) {
        batch.delete(doc.reference);
      }
      await batch.commit();
      debugPrint("[AlertService] Successfully cleared all alerts from Firestore (${snapshot.docs.length} docs).");
    } catch (e) {
      debugPrint("[AlertService] Error clearing alerts: $e");
    }
  }
}
