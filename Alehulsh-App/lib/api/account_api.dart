import 'dart:math';
import '../models/user_profile_model.dart';
import 'migration_api_client.dart';

class AccountApi {
  AccountApi(this.client);
  final MigrationApiClient client;
  void _check(String owner, int epoch) {
    if (client.knownSubject() != owner || client.accountEpoch() != epoch)
      throw const ApiOperationException(401);
  }

  Future<UserProfile> load(String owner,
      {String email = '', UserProfile? previous}) async {
    final epoch = client.accountEpoch();
    _check(owner, epoch);
    final data = await Future.wait([
      client.authenticatedJson('GET', '/v1/me/profile'),
      client.authenticatedJson('GET', '/v1/me/contacts')
    ]);
    _check(owner, epoch);
    final p = data[0]['profile'];
    final contacts = data[1]['contacts'];
    if (p is! Map || contacts is! List) throw const ApiOperationException(502);
    final now = DateTime.now();
    return UserProfile(
        uid: owner,
        fullName: p['fullName'] as String? ?? '',
        email: email,
        phoneNumber: p['phoneNumber'] as String? ?? '',
        homeAddress: p['homeAddress'] as String? ?? '',
        keywordConfigured: p['safetyKeywordSet'] == true,
        catName: '',
        emergencyContacts: contacts.map((item) {
          final c = Map<String, dynamic>.from(item as Map);
          return EmergencyContact(
              id: c['id'] as String,
              name: c['name'] as String,
              phone: c['phone'] as String,
              email: c['email'] as String? ?? '',
              relationship: c['relationship'] as String? ?? '',
              isPrimary: c['isPrimary'] == true);
        }).toList(),
        isLocationSharingEnabled: p['locationSharingEnabled'] == true,
        isAutoAudioRecording: p['autoAudioRecording'] == true,
        isFakeCallEnabled: p['fakeCallEnabled'] == true,
        isCommunityAlertsEnabled: p['communityAlertsEnabled'] == true,
        activities: previous?.activities ?? [],
        createdAt: previous?.createdAt ?? now,
        lastActiveAt: now);
  }

  Future<void> updateProfile(UserProfile profile) async {
    final epoch = client.accountEpoch();
    _check(profile.uid, epoch);
    await client.authenticatedJson('PATCH', '/v1/me/profile', body: {
      'fullName': profile.fullName,
      'homeAddress': profile.homeAddress,
    });
    _check(profile.uid, epoch);
  }

  Future<void> updatePreference(String field, bool value) async {
    if (!const {
      'locationSharingEnabled',
      'autoAudioRecording',
      'fakeCallEnabled',
      'communityAlertsEnabled'
    }.contains(field)) throw ArgumentError('Unknown preference');
    await client
        .authenticatedJson('PATCH', '/v1/me/profile', body: {field: value});
  }

  Future<void> putContact(EmergencyContact contact) => client.authenticatedJson(
          'PUT', '/v1/me/contacts/${Uri.encodeComponent(contact.id)}',
          body: {
            'name': contact.name,
            'phone': contact.phone,
            'email': contact.email,
            'relationship': contact.relationship,
            'isPrimary': contact.isPrimary
          }).then((_) {});
  Future<void> removeContact(String id) => client
      .authenticatedJson('DELETE', '/v1/me/contacts/${Uri.encodeComponent(id)}')
      .then((_) {});
  Future<bool> provisioned() async =>
      (await client.authenticatedJson(
          'GET', '/v1/me/account'))['provisioned'] ==
      true;
  Future<void> provision(
          {required String name,
          required String homeAddress,
          required String keyword}) =>
      client.authenticatedJson('POST', '/v1/me/account', body: {
        'name': name,
        'homeAddress': homeAddress,
        'keyword': keyword
      }).then((_) {});
  static String newContactId() {
    final random = Random.secure();
    final bytes = List.generate(16, (_) => random.nextInt(256));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    final h = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}';
  }
}
