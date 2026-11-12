import 'dart:async';
import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/services.dart';
import 'package:alehulsh_app/auth/secure_session_store.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:alehulsh_app/api/migration_api_client.dart';
import 'package:alehulsh_app/api/private_notification_api.dart';
import 'migration_api_client_test.dart' show MemoryOutbox;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const id = '11111111-1111-4111-8111-111111111111';
  test(
      'registration and opt-out carry their durable revision, including a lost registration response',
      () async {
    final calls = <Map<String, dynamic>>[];
    final client = MigrationApiClient(
        baseUri: Uri.parse('https://api.invalid'),
        knownSubject: () => 'recipient',
        session: () async => const ApiSession('recipient', 'synthetic'),
        outbox: MemoryOutbox(),
        httpClient: MockClient((r) async {
          calls.add(jsonDecode(r.body));
          return http.Response(
              r.method == 'PUT'
                  ? ' {"generation":"synthetic-generation"}'
                  : '{}',
              200);
        }));
    final api = PrivateNotificationApi(client);
    await api.register(id, 'synthetic-device-token', 'review-v1', 41);
    await api.disable(id, null, 42);
    expect(calls, [
      {
        'token': 'synthetic-device-token',
        'consentVersion': 'review-v1',
        'revision': 41
      },
      {'generation': null, 'revision': 42}
    ]);
  });
  test(
      'native revision counter is scoped to API origin, owner and device and refuses corrupt results',
      () async {
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    var result = 5;
    messenger.setMockMethodCallHandler(NativeSessionStore.channel,
        (call) async {
      expect(call.method, 'nextPushRevision');
      expect(call.arguments, {
        'namespace': 'https://api.invalid',
        'owner': 'recipient',
        'deviceId': id
      });
      return result;
    });
    addTearDown(() =>
        messenger.setMockMethodCallHandler(NativeSessionStore.channel, null));
    const revisions = NativePushRevision('https://api.invalid');
    expect(await revisions.next('recipient', id), 5);
    result = 0;
    await expectLater(revisions.next('recipient', id), throwsStateError);
    result = 9007199254740992;
    await expectLater(revisions.next('recipient', id), throwsStateError);
    messenger.setMockMethodCallHandler(NativeSessionStore.channel,
        (_) async => throw PlatformException(code: 'storage-unavailable'));
    await expectLater(
        revisions.next('recipient', id), throwsA(isA<PlatformException>()));
  });
  test(
      'opaque hints resolve through the authenticated recipient API and preserve old incident identity',
      () async {
    final client = MigrationApiClient(
        baseUri: Uri.parse('https://api.invalid'),
        knownSubject: () => 'recipient',
        session: () async => const ApiSession('recipient', 'synthetic'),
        outbox: MemoryOutbox(),
        httpClient: MockClient((r) async {
          expect(r.url.path, '/v1/me/deliveries/$id/receipt');
          expect(jsonDecode(r.body), {'stage': 'opened'});
          return http.Response(
              '{"incidentId":"old-immutable-incident","active":false}', 200);
        }));
    final hint = await PrivateNotificationApi(client).receipt(id, opened: true);
    expect(hint.active, isFalse);
    expect(hint.incidentId, 'old-immutable-incident');
  });
  test('a delayed notification read cannot navigate the next account',
      () async {
    var owner = 'alice';
    final response = Completer<http.Response>();
    final client = MigrationApiClient(
        baseUri: Uri.parse('https://api.invalid'),
        knownSubject: () => owner,
        session: () async => const ApiSession('alice', 'synthetic'),
        outbox: MemoryOutbox(),
        httpClient: MockClient((_) => response.future));
    final call = PrivateNotificationApi(client).receipt(id, opened: true);
    final rejected = expectLater(call, throwsA(isA<ApiOperationException>()));
    await Future<void>.delayed(Duration.zero);
    owner = 'bob';
    response.complete(http.Response(
        '{"incidentId":"private-alice-incident","active":true}', 200));
    await rejected;
  });
  test('missing reviewed consent does not register a device', () async {
    var registrations = 0;
    final client = MigrationApiClient(
        baseUri: Uri.parse('https://api.invalid'),
        knownSubject: () => 'recipient',
        session: () async => const ApiSession('recipient', 'synthetic'),
        outbox: MemoryOutbox(),
        httpClient: MockClient((r) async {
          if (r.method == 'PUT') registrations++;
          return http.Response('{}', 503);
        }));
    await expectLater(PrivateNotificationApi(client).policy(),
        throwsA(isA<ApiOperationException>()));
    expect(registrations, 0);
  });
}
