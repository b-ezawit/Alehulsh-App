import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:alehulsh_app/api/migration_api_client.dart';
import 'package:alehulsh_app/api/account_api.dart';
import 'migration_api_client_test.dart' show MemoryOutbox;

void main() {
  MigrationApiClient client(
          Future<http.Response> Function(http.Request) send) =>
      MigrationApiClient(
          baseUri: Uri.parse('https://synthetic.invalid'),
          knownSubject: () => 'alice',
          session: () async => const ApiSession('alice', 'synthetic'),
          outbox: MemoryOutbox(),
          httpClient: MockClient(send));
  test(
      'profile and contacts are API-owned and never hydrate plaintext keyword fields',
      () async {
    final api = AccountApi(client((request) async => http.Response(
        jsonEncode(request.url.path.endsWith('/profile')
            ? {
                'profile': {
                  'fullName': 'Alice',
                  'safetyKeywordSet': true,
                  'locationSharingEnabled': false,
                  'catName': 'must-never-hydrate'
                }
              }
            : {
                'contacts': [
                  {
                    'id': 'synthetic-contact',
                    'name': 'Contact',
                    'phone': '+251911234567',
                    'email': '',
                    'relationship': 'Friend',
                    'isPrimary': true
                  }
                ]
              }),
        200)));
    final profile = await api.load('alice');
    expect(profile.uid, 'alice');
    expect(profile.catName, '');
    expect(profile.hasSafetyKeyword, isTrue);
    expect(profile.emergencyContacts.single.phone, '+251911234567');
    expect(profile.isLocationSharingEnabled, isFalse);
    await expectLater(api.load('bob'), throwsA(isA<ApiOperationException>()));
  });
  test(
      'metadata updates cannot overwrite a newer location opt-out or send protected fields',
      () async {
    final api = AccountApi(client((request) async {
      final data = jsonDecode(request.body) as Map;
      expect(data.containsKey('catName'), isFalse);
      expect(data.containsKey('keywordConfigured'), isFalse);
      expect(data.containsKey('emergencyContacts'), isFalse);
      expect(data.containsKey('locationSharingEnabled'), isFalse);
      return http.Response('{"profile":{}}', 200);
    }));
    final profile = await AccountApi(client(
            (_) async => http.Response('{"profile":{},"contacts":[]}', 200)))
        .load('alice');
    await api.updateProfile(profile.copyWith(catName: 'do-not-send'));
  });
  test(
      'a preference update patches only the explicitly selected setting, preserving a false value',
      () async {
    final api = AccountApi(client((r) async {
      expect(jsonDecode(r.body), {'locationSharingEnabled': false});
      return http.Response('{}', 200);
    }));
    await api.updatePreference('locationSharingEnabled', false);
    await expectLater(
        api.updatePreference('phoneVerified', true), throwsArgumentError);
  });
}
