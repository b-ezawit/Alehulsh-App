import 'dart:convert';

class EmergencyContact {
  final String id;
  final String name;
  final String email;
  final String phone;
  final String relationship;
  final bool isPrimary;

  EmergencyContact({
    required this.id,
    required this.name,
    this.email = '',
    required this.phone,
    required this.relationship,
    this.isPrimary = false,
  });

  EmergencyContact copyWith({
    String? id,
    String? name,
    String? email,
    String? phone,
    String? relationship,
    bool? isPrimary,
  }) {
    return EmergencyContact(
      id: id ?? this.id,
      name: name ?? this.name,
      email: email ?? this.email,
      phone: phone ?? this.phone,
      relationship: relationship ?? this.relationship,
      isPrimary: isPrimary ?? this.isPrimary,
    );
  }

  Map<String, dynamic> toMap() {
    return {
      'id': id,
      'name': name,
      'email': email,
      'phone': phone,
      'relationship': relationship,
      'isPrimary': isPrimary,
    };
  }

  factory EmergencyContact.fromMap(Map<String, dynamic> map) {
    return EmergencyContact(
      id: map['id'] ?? '',
      name: map['name'] ?? '',
      email: map['email'] ?? '',
      phone: map['phone'] ?? '',
      relationship: map['relationship'] ?? '',
      isPrimary: map['isPrimary'] ?? false,
    );
  }

  String toJson() => json.encode(toMap());
  factory EmergencyContact.fromJson(String source) => EmergencyContact.fromMap(json.decode(source));
}

class UserActivityLog {
  final String id;
  final String title;
  final String description;
  final DateTime timestamp;
  final String type; // 'sos', 'escort', 'contact_added', 'profile_updated', 'settings_change'

  UserActivityLog({
    required this.id,
    required this.title,
    required this.description,
    required this.timestamp,
    required this.type,
  });

  Map<String, dynamic> toMap() {
    return {
      'id': id,
      'title': title,
      'description': description,
      'timestamp': timestamp.toIso8601String(),
      'type': type,
    };
  }

  factory UserActivityLog.fromMap(Map<String, dynamic> map) {
    return UserActivityLog(
      id: map['id'] ?? '',
      title: map['title'] ?? '',
      description: map['description'] ?? '',
      timestamp: map['timestamp'] != null ? DateTime.parse(map['timestamp']) : DateTime.now(),
      type: map['type'] ?? 'general',
    );
  }
}

class UserProfile {
  final String uid;
  final String fullName;
  final String email;
  final String phoneNumber;
  final String avatarUrl;
  final String bloodType;
  final String medicalNotes;
  final String homeAddress;
  final String catName; // Security verification answer for SOS cancellation
  final List<EmergencyContact> emergencyContacts;
  final int safetyScore; // 0 to 100
  final int alertsTriggeredCount;
  final int alertsRespondedCount;
  final bool isLocationSharingEnabled;
  final bool isAutoAudioRecording;
  final bool isFakeCallEnabled;
  final bool isCommunityAlertsEnabled;
  final List<UserActivityLog> activities;
  final DateTime createdAt;
  final DateTime lastActiveAt;

  UserProfile({
    required this.uid,
    required this.fullName,
    required this.email,
    required this.phoneNumber,
    this.avatarUrl = '',
    this.bloodType = 'O+',
    this.medicalNotes = 'None',
    this.homeAddress = 'Bole Sub-city, Addis Ababa',
    this.catName = 'Milo',
    required this.emergencyContacts,
    this.safetyScore = 92,
    this.alertsTriggeredCount = 0,
    this.alertsRespondedCount = 0,
    this.isLocationSharingEnabled = true,
    this.isAutoAudioRecording = true,
    this.isFakeCallEnabled = true,
    this.isCommunityAlertsEnabled = true,
    required this.activities,
    required this.createdAt,
    required this.lastActiveAt,
  });

  UserProfile copyWith({
    String? uid,
    String? fullName,
    String? email,
    String? phoneNumber,
    String? avatarUrl,
    String? bloodType,
    String? medicalNotes,
    String? homeAddress,
    String? catName,
    List<EmergencyContact>? emergencyContacts,
    int? safetyScore,
    int? alertsTriggeredCount,
    int? alertsRespondedCount,
    bool? isLocationSharingEnabled,
    bool? isAutoAudioRecording,
    bool? isFakeCallEnabled,
    bool? isCommunityAlertsEnabled,
    List<UserActivityLog>? activities,
    DateTime? createdAt,
    DateTime? lastActiveAt,
  }) {
    return UserProfile(
      uid: uid ?? this.uid,
      fullName: fullName ?? this.fullName,
      email: email ?? this.email,
      phoneNumber: phoneNumber ?? this.phoneNumber,
      avatarUrl: avatarUrl ?? this.avatarUrl,
      bloodType: bloodType ?? this.bloodType,
      medicalNotes: medicalNotes ?? this.medicalNotes,
      homeAddress: homeAddress ?? this.homeAddress,
      catName: catName ?? this.catName,
      emergencyContacts: emergencyContacts ?? this.emergencyContacts,
      safetyScore: safetyScore ?? this.safetyScore,
      alertsTriggeredCount: alertsTriggeredCount ?? this.alertsTriggeredCount,
      alertsRespondedCount: alertsRespondedCount ?? this.alertsRespondedCount,
      isLocationSharingEnabled: isLocationSharingEnabled ?? this.isLocationSharingEnabled,
      isAutoAudioRecording: isAutoAudioRecording ?? this.isAutoAudioRecording,
      isFakeCallEnabled: isFakeCallEnabled ?? this.isFakeCallEnabled,
      isCommunityAlertsEnabled: isCommunityAlertsEnabled ?? this.isCommunityAlertsEnabled,
      activities: activities ?? this.activities,
      createdAt: createdAt ?? this.createdAt,
      lastActiveAt: lastActiveAt ?? this.lastActiveAt,
    );
  }

  Map<String, dynamic> toMap() {
    return {
      'uid': uid,
      'fullName': fullName,
      'email': email,
      'phoneNumber': phoneNumber,
      'avatarUrl': avatarUrl,
      'bloodType': bloodType,
      'medicalNotes': medicalNotes,
      'homeAddress': homeAddress,
      'catName': catName,
      'emergencyContacts': emergencyContacts.map((x) => x.toMap()).toList(),
      'safetyScore': safetyScore,
      'alertsTriggeredCount': alertsTriggeredCount,
      'alertsRespondedCount': alertsRespondedCount,
      'isLocationSharingEnabled': isLocationSharingEnabled,
      'isAutoAudioRecording': isAutoAudioRecording,
      'isFakeCallEnabled': isFakeCallEnabled,
      'isCommunityAlertsEnabled': isCommunityAlertsEnabled,
      'activities': activities.map((x) => x.toMap()).toList(),
      'createdAt': createdAt.toIso8601String(),
      'lastActiveAt': lastActiveAt.toIso8601String(),
    };
  }

  factory UserProfile.fromMap(Map<String, dynamic> map) {
    return UserProfile(
      uid: map['uid'] ?? '',
      fullName: map['fullName'] ?? '',
      email: map['email'] ?? '',
      phoneNumber: map['phoneNumber'] ?? '',
      avatarUrl: map['avatarUrl'] ?? '',
      bloodType: map['bloodType'] ?? 'O+',
      medicalNotes: map['medicalNotes'] ?? 'None',
      homeAddress: map['homeAddress'] ?? '',
      catName: map['catName'] ?? 'Milo',
      emergencyContacts: map['emergencyContacts'] != null
          ? List<EmergencyContact>.from((map['emergencyContacts'] as List).map((x) => EmergencyContact.fromMap(x)))
          : [],
      safetyScore: map['safetyScore']?.toInt() ?? 90,
      alertsTriggeredCount: map['alertsTriggeredCount']?.toInt() ?? 0,
      alertsRespondedCount: map['alertsRespondedCount']?.toInt() ?? 0,
      isLocationSharingEnabled: map['isLocationSharingEnabled'] ?? true,
      isAutoAudioRecording: map['isAutoAudioRecording'] ?? true,
      isFakeCallEnabled: map['isFakeCallEnabled'] ?? true,
      isCommunityAlertsEnabled: map['isCommunityAlertsEnabled'] ?? true,
      activities: map['activities'] != null
          ? List<UserActivityLog>.from((map['activities'] as List).map((x) => UserActivityLog.fromMap(x)))
          : [],
      createdAt: map['createdAt'] != null ? DateTime.parse(map['createdAt']) : DateTime.now(),
      lastActiveAt: map['lastActiveAt'] != null ? DateTime.parse(map['lastActiveAt']) : DateTime.now(),
    );
  }

  String toJson() => json.encode(toMap());
  factory UserProfile.fromJson(String source) => UserProfile.fromMap(json.decode(source));

  static UserProfile guestProfile() {
    return UserProfile(
      uid: "",
      fullName: "",
      email: "",
      phoneNumber: "",
      avatarUrl: "",
      bloodType: "",
      medicalNotes: "",
      homeAddress: "",
      catName: "",
      emergencyContacts: [],
      safetyScore: 0,
      alertsTriggeredCount: 0,
      alertsRespondedCount: 0,
      isLocationSharingEnabled: false,
      isAutoAudioRecording: false,
      isFakeCallEnabled: false,
      isCommunityAlertsEnabled: true,
      activities: [],
      createdAt: DateTime.now(),
      lastActiveAt: DateTime.now(),
    );
  }

  static UserProfile defaultProfile() {
    return UserProfile(
      uid: "demo_user_001",
      fullName: "Bezawit M.",
      email: "bezawit@example.com",
      phoneNumber: "+251 91 123 4567",
      avatarUrl: "",
      bloodType: "O+",
      medicalNotes: "Asthma. Uses inhaler.",
      homeAddress: "Bole Atlas, Addis Ababa",
      catName: "Milo",
      emergencyContacts: [
        EmergencyContact(
          id: "c1",
          name: "Saba M.",
          email: "saba@example.com",
          phone: "+251 91 888 7766",
          relationship: "Sister",
          isPrimary: true,
        ),
      ],
      safetyScore: 95,
      alertsTriggeredCount: 0,
      alertsRespondedCount: 0,
      activities: [],
      createdAt: DateTime.now(),
      lastActiveAt: DateTime.now(),
    );
  }
}
