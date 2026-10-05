import 'dart:math';
import 'package:cloud_firestore/cloud_firestore.dart';
import '../utils/geohash_util.dart';

class VoiceNoteItem {
  final String id;
  final String title;
  final String duration;
  final DateTime timestamp;
  final String audioUrl; // Can be a local/network URI or mock stream

  VoiceNoteItem({
    required this.id,
    required this.title,
    required this.duration,
    required this.timestamp,
    this.audioUrl = '',
  });

  Map<String, dynamic> toMap() {
    return {
      'id': id,
      'title': title,
      'duration': duration,
      'timestamp': timestamp.toIso8601String(),
      'audioUrl': audioUrl,
    };
  }

  factory VoiceNoteItem.fromMap(Map<String, dynamic> map) {
    return VoiceNoteItem(
      id: map['id'] ?? '',
      title: map['title'] ?? 'Voice Note',
      duration: map['duration'] ?? '0:05',
      timestamp: map['timestamp'] != null ? DateTime.parse(map['timestamp']) : DateTime.now(),
      audioUrl: map['audioUrl'] ?? '',
    );
  }
}

class EmergencyAlert {
  final String id;
  final String userId;
  final String userName;
  final String userAvatar;
  final String alerterPhone;
  final String alerterEmail;
  /// Where she is, or null when the device could not determine it.
  ///
  /// Nullable on purpose. A fabricated coordinate is worse than no coordinate:
  /// it sends responders confidently to the wrong place. Absent location must
  /// stay visibly absent all the way to the screen.
  final double? latitude;
  final double? longitude;

  /// True when both coordinates are present and a pin may be drawn.
  bool get hasLocation => latitude != null && longitude != null;
  final String locationName;
  final DateTime timestamp;
  final DateTime expiresAt; // 2-Hour TTL Safety Net
  final String geohash; // Spatial partitioning for 500m geofencing
  final String category;
  final String message; // Optional user note
  final bool isUrgent;
  final String status; // 'active' or 'safe'
  final DateTime? safeTimestamp;
  final List<VoiceNoteItem> voiceNotes;
  final List<String> responders; // List of responder user IDs
  final List<String> emergencyContactEmails;
  final List<String> emergencyContactPhones;
  final List<String> emergencyContactNames;
  final List<String> emergencyContactUids;

  EmergencyAlert({
    required this.id,
    required this.userId,
    required this.userName,
    this.userAvatar = 'U',
    this.alerterPhone = '',
    this.alerterEmail = '',
    required this.latitude,
    required this.longitude,
    required this.locationName,
    required this.timestamp,
    DateTime? expiresAt,
    String? geohash,
    this.category = 'Emergency SOS Alert',
    this.message = '',
    this.isUrgent = false,
    this.status = 'active',
    this.safeTimestamp,
    this.voiceNotes = const [],
    this.responders = const [],
    this.emergencyContactEmails = const [],
    this.emergencyContactPhones = const [],
    this.emergencyContactNames = const [],
    this.emergencyContactUids = const [],
  })  : expiresAt = expiresAt ?? timestamp.add(const Duration(hours: 2)),
        // No coordinates means no geohash, so this alert is never matched by
        // proximity. That is correct: we cannot claim she is near anyone. Her
        // emergency contacts are notified by explicit link, not by distance,
        // so they are still reached.
        geohash = geohash ??
            (latitude != null && longitude != null
                ? GeohashUtil.encode(latitude, longitude)
                : '');

  /// Check if the 2-hour TTL has expired
  bool get isExpired => DateTime.now().isAfter(expiresAt);

  /// Haversine distance in km, or null when this alert has no location.
  ///
  /// Returns null rather than a sentinel such as 0 or 999: a caller that
  /// forgets to check would otherwise sort an unlocatable alert to the top of
  /// a nearby list, or to the bottom and out of sight.
  double? calculateDistanceKm(double? userLat, double? userLng) {
    final alertLat = latitude;
    final alertLng = longitude;
    // Either side missing means there is no distance to report: we need to know
    // where BOTH the alert and the viewer are.
    if (alertLat == null || alertLng == null) return null;
    if (userLat == null || userLng == null) return null;

    const double earthRadiusKm = 6371.0;

    double dLat = _degreesToRadians(alertLat - userLat);
    double dLon = _degreesToRadians(alertLng - userLng);

    double lat1Rad = _degreesToRadians(userLat);
    double lat2Rad = _degreesToRadians(alertLat);

    double a = sin(dLat / 2) * sin(dLat / 2) +
        sin(dLon / 2) * sin(dLon / 2) * cos(lat1Rad) * cos(lat2Rad);
    double c = 2 * atan2(sqrt(a), sqrt(1 - a));

    return earthRadiusKm * c;
  }

  /// Formatted distance, or an explicit unknown when either location is absent.
  String distanceLabel(double? userLat, double? userLng) {
    final distKm = calculateDistanceKm(userLat, userLng);
    // Covers both "the alert has no location" and "we do not know where the
    // viewer is". Saying so is correct; inventing a distance is not.
    if (distKm == null) return "Distance unknown";
    if (distKm < 0.3) {
      int meters = (distKm * 1000).round();
      return "$meters m away";
    } else {
      return "${distKm.toStringAsFixed(1)} km away";
    }
  }

  double _degreesToRadians(double degrees) {
    return degrees * pi / 180.0;
  }

  Map<String, dynamic> toMap() {
    final validExpiresAt = expiresAt;
    return {
      'id': id,
      'userId': userId,
      'userName': userName,
      'userAvatar': userAvatar,
      'alerterPhone': alerterPhone,
      'alerterEmail': alerterEmail,
      'latitude': latitude,
      'longitude': longitude,
      'locationName': locationName,
      'timestamp': timestamp.toIso8601String(),
      'expiresAt': validExpiresAt.toIso8601String(),
      'expiresAtTimestamp': Timestamp.fromDate(validExpiresAt), // For Firestore native TTL / indexing
      'ttlHours': 2,
      'geohash': geohash,
      // Omit 'geo' entirely without coordinates. Writing a placeholder GeoPoint
      // would make an unlocatable alert queryable by proximity at the wrong
      // place, which is the exact failure this nullability exists to prevent.
      if (latitude != null && longitude != null)
        'geo': {
          'geohash': geohash,
          'geopoint': GeoPoint(latitude!, longitude!),
        },
      'category': category,
      'message': message,
      'isUrgent': isUrgent,
      'status': status,
      'safeTimestamp': safeTimestamp?.toIso8601String(),
      'voiceNotes': voiceNotes.map((x) => x.toMap()).toList(),
      'responders': responders,
      'emergencyContactEmails': emergencyContactEmails,
      'emergencyContactPhones': emergencyContactPhones,
      'emergencyContactNames': emergencyContactNames,
      'emergencyContactUids': emergencyContactUids,
    };
  }

  factory EmergencyAlert.fromMap(Map<String, dynamic> map, {String? docId}) {
    DateTime parsedTimestamp = DateTime.now();
    try {
      if (map['timestamp'] != null) {
        parsedTimestamp = DateTime.parse(map['timestamp'].toString());
      }
    } catch (_) {}

    DateTime parsedExpiresAt = parsedTimestamp.add(const Duration(hours: 2));
    try {
      if (map['expiresAt'] != null) {
        parsedExpiresAt = DateTime.parse(map['expiresAt'].toString());
      } else if (map['expiresAtTimestamp'] is Timestamp) {
        parsedExpiresAt = (map['expiresAtTimestamp'] as Timestamp).toDate();
      }
    } catch (_) {}

    DateTime? parsedSafeTimestamp;
    try {
      if (map['safeTimestamp'] != null) {
        parsedSafeTimestamp = DateTime.parse(map['safeTimestamp'].toString());
      }
    } catch (_) {}

    List<VoiceNoteItem> parsedVoiceNotes = [];
    if (map['voiceNotes'] is List) {
      for (var vn in (map['voiceNotes'] as List)) {
        try {
          if (vn is Map) {
            parsedVoiceNotes.add(VoiceNoteItem.fromMap(Map<String, dynamic>.from(vn)));
          }
        } catch (_) {}
      }
    }

    List<String> parseStringList(dynamic val) {
      if (val is List) {
        return val.map((e) => e?.toString().trim() ?? '').where((s) => s.isNotEmpty).toList();
      }
      return [];
    }

    // Previously defaulted to Addis Ababa city centre (9.0125, 38.7636), so an
    // alert with no location rendered as a confident pin in Bole. Absence now
    // survives the round trip.
    final lat = (map['latitude'] as num?)?.toDouble();
    final lng = (map['longitude'] as num?)?.toDouble();
    final extractedGeohash = map['geohash']?.toString() ??
        (map['geo'] is Map ? (map['geo']['geohash']?.toString()) : null) ??
        (lat != null && lng != null ? GeohashUtil.encode(lat, lng) : '');

    return EmergencyAlert(
      id: docId ?? map['id']?.toString() ?? '',
      userId: map['userId']?.toString() ?? '',
      userName: map['userName']?.toString().isNotEmpty == true ? map['userName'].toString() : 'Alehulsh User',
      userAvatar: map['userAvatar']?.toString() ?? 'U',
      alerterPhone: map['alerterPhone']?.toString() ?? '',
      alerterEmail: map['alerterEmail']?.toString() ?? '',
      latitude: lat,
      longitude: lng,
      locationName: map['locationName']?.toString() ?? 'Live GPS',
      timestamp: parsedTimestamp,
      expiresAt: parsedExpiresAt,
      geohash: extractedGeohash,
      category: map['category']?.toString() ?? 'Emergency SOS Alert',
      message: map['message']?.toString() ?? '',
      isUrgent: map['isUrgent'] == true,
      status: map['status']?.toString() ?? 'active',
      safeTimestamp: parsedSafeTimestamp,
      voiceNotes: parsedVoiceNotes,
      responders: parseStringList(map['responders']),
      emergencyContactEmails: parseStringList(map['emergencyContactEmails']),
      emergencyContactPhones: parseStringList(map['emergencyContactPhones']),
      emergencyContactNames: parseStringList(map['emergencyContactNames']),
      emergencyContactUids: parseStringList(map['emergencyContactUids']),
    );
  }
}
