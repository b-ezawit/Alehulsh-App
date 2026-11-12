import 'package:flutter_test/flutter_test.dart';
import 'package:alehulsh_app/api/trusted_hardware_trigger.dart';
import 'package:alehulsh_app/api/migration_api_client.dart';
import 'package:http/testing.dart';
import 'package:http/http.dart' as http;
import 'migration_api_client_test.dart' show MemoryOutbox;

void main() {
  test(
      'native callback cannot create an SOS for a replacement or signed-out account',
      () {
    final native = {
      'ownerSubject': 'alice',
      'requestId': 'opaque-native-request'
    };
    expect(trustedHardwareRequest(native, 'alice'), 'opaque-native-request');
    expect(trustedHardwareRequest(native, 'bob'), isNull);
    expect(trustedHardwareRequest(native, null), isNull);
    expect(
        trustedHardwareRequest({'requestId': 'opaque-native-request'}, 'alice'),
        isNull);
  });
  test(
      'Flutter retains the native request identity even after native acknowledgment cleared the shared outbox',
      () async {
    final box = MemoryOutbox();
    final client = MigrationApiClient(
        baseUri: Uri.parse('https://api.invalid'),
        knownSubject: () => 'alice',
        session: () async => const ApiSession('alice', 'synthetic'),
        outbox: box,
        httpClient: MockClient((_) async => http.Response('{}', 503)));
    final first = await client.enqueueSos(requestId: 'opaque-native-request');
    await box.acknowledge('alice', first.requestId);
    final resumed = await client.enqueueSos(requestId: 'opaque-native-request');
    expect(resumed.requestId, first.requestId);
  });
}
