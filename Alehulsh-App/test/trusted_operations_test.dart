import 'dart:async';
import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:alehulsh_app/api/migration_api_client.dart';
import 'migration_api_client_test.dart' show MemoryOutbox;

void main() {
  test('keyword recovery uses only scoped APIs and preserves the exact keyword without a client-side eligibility bypass',()async{
    final requests=<http.Request>[];
    final api=MigrationApiClient(baseUri:Uri.parse('https://synthetic.invalid'),knownSubject:()=> 'alice',session:()async=>const ApiSession('alice','synthetic'),
      outbox:MemoryOutbox(),httpClient:MockClient((r)async{requests.add(r);return http.Response('{"pending":true,"eligibleAt":"2026-12-01T00:00:00Z"}',200);}));
    await api.keywordRecovery();await api.requestKeywordRecovery();await api.confirmKeywordRecovery(' Exact synthetic keyword ');await api.cancelKeywordRecovery();
    expect(requests.map((r)=>r.method),['GET','POST','POST','DELETE']);
    expect(jsonDecode(requests[2].body),{'keyword':' Exact synthetic keyword '});
    expect(requests.every((r)=>!r.followRedirects&&r.url.path.startsWith('/v1/me/keyword/reset')),isTrue);
  });
  test('keyword and resolution use trusted authenticated operations only', () async {
    final requests = <http.Request>[];
    final api = MigrationApiClient(
      baseUri: Uri.parse('https://synthetic.invalid'), knownSubject: () => 'owner',
      session: () async => const ApiSession('owner', 'synthetic-token'),
      outbox: MemoryOutbox(), httpClient: MockClient((r) async {
        requests.add(r); return http.Response('{"acknowledged":true}', 200);
      }),
    );
    await api.setKeyword('synthetic-word');
    await api.requestResolution('incident', 'synthetic-word');
    expect(requests.map((r) => r.url.path), ['/v1/me/keyword', '/v1/alerts/incident/resolve']);
    expect(requests.every((r) => !r.followRedirects), isTrue);
    expect(requests.every((r) => r.headers['authorization'] == 'Bearer synthetic-token'), isTrue);
    expect(jsonDecode(requests.last.body), {'keyword': 'synthetic-word'});
  });
  test('account switch during response cannot return another account inbox', () async {
    var owner = 'alice';
    final pending = Completer<http.Response>();
    final api = MigrationApiClient(baseUri: Uri.parse('https://synthetic.invalid'),
      knownSubject: () => owner, session: () async => const ApiSession('alice', 'synthetic'),
      outbox: MemoryOutbox(), httpClient: MockClient((_) => pending.future));
    final call = api.inbox();
    await Future<void>.delayed(Duration.zero);
    owner = 'bob'; pending.complete(http.Response('{"items":[{"alertId":"private"}]}', 200));
    await expectLater(call, throwsA(isA<ApiOperationException>()));
  });
  test('redirect and foreign origin never receive a forwarded bearer', () async {
    var calls = 0;
    final api = MigrationApiClient(baseUri: Uri.parse('https://synthetic.invalid'),
      knownSubject: () => 'owner', session: () async => const ApiSession('owner', 'synthetic'),
      outbox: MemoryOutbox(), httpClient: MockClient((_) async {
        calls++; return http.Response('', 302, headers: {'location': 'https://other.invalid'});
      }));
    await expectLater(api.inbox(), throwsA(isA<ApiOperationException>()));
    await expectLater(api.authenticatedJson('GET', 'https://other.invalid/v1/me/inbox'), throwsArgumentError);
    expect(calls, 1);
  });
  test('unverified backend errors never become successful resolution', () async {
    final api = MigrationApiClient(baseUri: Uri.parse('https://synthetic.invalid'),
      knownSubject: () => 'owner', session: () async => const ApiSession('owner', 'synthetic'),
      outbox: MemoryOutbox(), httpClient: MockClient((_) async => http.Response('secret provider detail', 503)));
    await expectLater(api.requestResolution('incident', 'word'), throwsA(isA<ApiOperationException>()));
  });
}
