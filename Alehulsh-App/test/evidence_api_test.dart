import 'dart:async';
import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:alehulsh_app/api/migration_api_client.dart';
import 'package:alehulsh_app/api/evidence_api.dart';
import 'migration_api_client_test.dart' show MemoryOutbox;

const id = '11111111-1111-4111-8111-111111111111';
void main() {
  late String owner;
  late int completes, puts;
  late http.Client storage;
  late MigrationApiClient client;
  Map<String, dynamic> ticket({String origin = 'https://storage.invalid'}) => {
        'evidenceId': id,
        'upload': {
          'url': '$origin/private/object?signature=synthetic',
          'method': 'PUT',
          'expiresAt': DateTime.now()
              .toUtc()
              .add(const Duration(minutes: 5))
              .toIso8601String(),
          'headers': {'content-type': 'audio/mp4'}
        }
      };
  void setup({Map<String, dynamic>? response, bool stored = false}) {
    owner = 'alice';
    completes = 0;
    puts = 0;
    client = MigrationApiClient(
        baseUri: Uri.parse('https://api.invalid'),
        session: () async => ApiSession(owner, 'synthetic'),
        knownSubject: () => owner,
        outbox: MemoryOutbox(),
        httpClient: MockClient((r) async {
          if (r.url.path.endsWith('/complete')) {
            completes++;
            return completes == 1 && !stored
                ? http.Response('{}', 404)
                : http.Response(
                    jsonEncode({
                      'evidence': {'id': id, 'uploaded': true}
                    }),
                    200);
          }
          expect(jsonDecode(r.body)['evidenceId'], id);
          expect(jsonDecode(r.body)['incidentKey'], 'immutable-incident');
          return http.Response(jsonEncode(response ?? ticket()), 201);
        }));
    storage = MockClient((r) async {
      puts++;
      expect(r.headers.containsKey('authorization'), isFalse);
      expect(r.followRedirects, isFalse);
      expect(r.bodyBytes, [1, 2]);
      return http.Response('', 200);
    });
  }

  Future<void> save() => EvidenceApi(client,
          storageOrigin: Uri.parse('https://storage.invalid'),
          uploadClient: () => storage)
      .save(
          owner: 'alice',
          alertId: 'immutable-incident',
          incidentKey: 'immutable-incident',
          evidenceId: id,
          length: 2,
          bytes: () => Stream.value([1, 2]),
          durationMs: 1000);
  test(
      'signed PUT carries bytes only and saving requires authoritative immutable finalization',
      () async {
    setup();
    await save();
    expect(completes, 2);
    expect(puts, 1);
  });
  test('lost finalization response resumes the same ID without uploading again',
      () async {
    setup(stored: true);
    await save();
    expect(completes, 1);
    expect(puts, 0);
  });
  test(
      'foreign storage origins and expired tickets are rejected before bytes leave the device',
      () async {
    setup(response: ticket(origin: 'https://foreign.invalid'));
    await expectLater(save(), throwsA(isA<ApiOperationException>()));
    expect(puts, 0);
    final expired = ticket();
    expired['upload']['expiresAt'] = '2000-01-01T00:00:00Z';
    setup(response: expired);
    await expectLater(save(), throwsA(isA<ApiOperationException>()));
    expect(puts, 0);
  });
  test('upload redirects never forward bytes or trigger finalization',
      () async {
    setup();
    storage = MockClient((r) async {
      puts++;
      expect(r.followRedirects, isFalse);
      return http.Response('', 307,
          headers: {'location': 'https://foreign.invalid'});
    });
    await expectLater(save(), throwsA(isA<ApiOperationException>()));
    expect(puts, 1);
    expect(completes, 1);
  });
  test(
      'account switch during PUT cannot finalize evidence under a new identity',
      () async {
    setup();
    final pending = Completer<http.Response>();
    storage = MockClient((r) => pending.future);
    final call = save(),
        check = expectLater(call, throwsA(isA<ApiOperationException>()));
    await Future<void>.delayed(const Duration(milliseconds: 20));
    owner = 'bob';
    pending.complete(http.Response('', 200));
    await check;
    expect(completes, 1);
  });
  test('a false success or changed byte count never becomes a saved recording',
      () async {
    setup();
    client = MigrationApiClient(
        baseUri: Uri.parse('https://api.invalid'),
        session: () async => const ApiSession('alice', 'synthetic'),
        knownSubject: () => owner,
        outbox: MemoryOutbox(),
        httpClient: MockClient((_) async => http.Response('{}', 200)));
    await expectLater(save(), throwsA(isA<ApiOperationException>()));
    expect(puts, 0);
  });
}
