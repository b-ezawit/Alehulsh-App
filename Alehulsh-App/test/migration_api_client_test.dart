import 'dart:async';
import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:alehulsh_app/api/migration_api_client.dart';

class MemoryOutbox implements SosOutbox {
  MemoryOutbox([Map<String, PendingSos>? values]) : values = values ?? {};
  final Map<String, PendingSos> values;
  bool failWrite = false, failAck = false;
  @override
  Future<PendingSos> enqueue(PendingSos item) async {
    if (failWrite) throw StateError('storage unavailable');
    return values.putIfAbsent(item.ownerSubject,
        () => PendingSos.fromMap(jsonDecode(jsonEncode(item.toMap()))));
  }

  @override
  Future<List<PendingSos>> pending(String ownerSubject) async =>
      values[ownerSubject] == null ? [] : [values[ownerSubject]!];
  @override
  Future<void> acknowledge(String ownerSubject, String requestId) async {
    if (failAck) throw StateError('commit unavailable');
    if (values[ownerSubject]?.requestId == requestId) {
      values.remove(ownerSubject);
    }
  }
}

http.Response receipt([int status = 201]) => http.Response(
    jsonEncode({
      'alert': {
        'id': '00000000-0000-4000-8000-000000000001',
        'status': 'active',
        'createdAt': '2026-10-25T10:00:00.000Z',
        'expiresAt': '2026-10-25T12:00:00.000Z',
      }
    }),
    status);
void main() {
  MigrationApiClient client(SosOutbox store, http.Client httpClient,
          {Future<ApiSession?> Function()? session}) =>
      MigrationApiClient(
        baseUri: Uri.parse('https://api.example.invalid'),
        knownSubject: () => 'alice',
        outbox: store,
        httpClient: httpClient,
        session:
            session ?? () async => const ApiSession('alice', 'fresh-token'),
      );
  test('only an explicit HTTPS origin is accepted', () {
    for (final origin in [
      'http://remote.invalid',
      'https://user:password@host.invalid',
      'https://host.invalid/?token=bad'
    ]) {
      expect(
          () => MigrationApiClient(
              baseUri: Uri.parse(origin),
              knownSubject: () => null,
              session: () async => null,
              outbox: MemoryOutbox(),
              httpClient: MockClient((_) async => receipt())),
          throwsArgumentError);
    }
  });
  test(
      'durability precedes delivery and persistence never includes the bearer token',
      () async {
    final store = MemoryOutbox();
    var sends = 0;
    final api = client(store, MockClient((_) async {
      sends++;
      return receipt();
    }));
    final pending = await api.enqueueSos();
    expect(sends, 0);
    expect(store.values['alice']?.requestId, pending.requestId);
    expect(pending.payload['latitude'], isNull);
    expect(pending.payload['longitude'], isNull);
    expect(DateTime.parse(pending.payload['occurredAt']).isUtc, isTrue);
    expect(jsonEncode(pending.toMap()), isNot(contains('fresh-token')));
  });
  test('storage failure cannot be reported as queued', () async {
    final store = MemoryOutbox()..failWrite = true;
    expect(client(store, MockClient((_) async => receipt())).enqueueSos(),
        throwsStateError);
    expect(store.values, isEmpty);
  });
  test(
      'process reconstruction retries the exact request after an ambiguous network failure',
      () async {
    final store = MemoryOutbox();
    final ids = <String>[];
    final offline = client(store, MockClient((request) async {
      ids.add(jsonDecode(request.body)['requestId']);
      throw http.ClientException('response lost');
    }));
    final item = await offline.enqueueSos(latitude: 9.01, longitude: 38.76);
    expect((await offline.flush()).delivery, SosDelivery.queued);
    final recreated =
        client(MemoryOutbox(store.values), MockClient((request) async {
      ids.add(jsonDecode(request.body)['requestId']);
      expect(request.followRedirects, isFalse);
      expect(request.headers['authorization'], 'Bearer refreshed');
      return receipt(200);
    }), session: () async => const ApiSession('alice', 'refreshed'));
    expect((await recreated.flush()).delivery, SosDelivery.sent);
    expect(ids, [item.requestId, item.requestId]);
    expect(store.values, isEmpty);
  });
  test(
      'pending SOS belongs to its original account and cannot leak on account switch',
      () async {
    final store = MemoryOutbox();
    var sends = 0;
    await client(store, MockClient((_) async => receipt())).enqueueSos();
    final other = client(store, MockClient((_) async {
      sends++;
      return receipt();
    }), session: () async => const ApiSession('bob', 'other-token'));
    expect((await other.flush()).delivery, SosDelivery.queued);
    expect(sends, 0);
    expect(store.values.containsKey('alice'), isTrue);
  });
  test(
      'authentication failures, provider outages and redirects preserve pending work',
      () async {
    for (final status in [401, 429, 503, 302]) {
      final store = MemoryOutbox();
      final api =
          client(store, MockClient((_) async => http.Response('', status)));
      await api.enqueueSos();
      final result = await api.flush();
      expect(
          result.delivery,
          status == 401
              ? SosDelivery.authenticationRequired
              : status == 302
                  ? SosDelivery.reviewRequired
                  : SosDelivery.queued);
      expect(store.values, isNotEmpty);
    }
  });
  test('an HTTP 200 without a valid receipt never removes an SOS', () async {
    for (final body in [
      'not json',
      '{}',
      '{"alert":{"id":"x","status":"active"}}'
    ]) {
      final store = MemoryOutbox();
      final api =
          client(store, MockClient((_) async => http.Response(body, 200)));
      await api.enqueueSos();
      expect((await api.flush()).delivery, SosDelivery.reviewRequired);
      expect(store.values, isNotEmpty);
    }
  });
  test(
      'concurrent flush calls coalesce and acknowledge only after the server responds',
      () async {
    final store = MemoryOutbox(), response = Completer<http.Response>();
    var sends = 0;
    final api = client(store, MockClient((_) {
      sends++;
      return response.future;
    }));
    await api.enqueueSos();
    final one = api.flush(), two = api.flush();
    await Future<void>.delayed(Duration.zero);
    expect(sends, 1);
    expect(store.values, isNotEmpty);
    response.complete(receipt());
    expect((await one).delivery, SosDelivery.sent);
    expect((await two).delivery, SosDelivery.sent);
    expect(store.values, isEmpty);
  });
  test('lost local acknowledgment leaves the same request available for retry',
      () async {
    final store = MemoryOutbox()..failAck = true;
    final api = client(store, MockClient((_) async => receipt()));
    final pending = await api.enqueueSos();
    await expectLater(api.flush(), throwsStateError);
    expect(store.values['alice']?.requestId, pending.requestId);
    store.failAck = false;
    expect((await api.flush()).delivery, SosDelivery.sent);
  });
  test(
      'a stalled response times out, cancels its body and preserves the request',
      () async {
    final store = MemoryOutbox();
    var cancelled = false;
    final stream = StreamController<List<int>>(onCancel: () {
      cancelled = true;
    });
    final api = MigrationApiClient(
        baseUri: Uri.parse('https://api.invalid'),
        knownSubject: () => 'alice',
        session: () async => const ApiSession('alice', 'temporary-token'),
        outbox: store,
        timeout: const Duration(milliseconds: 20),
        httpClient: MockClient.streaming(
            (_, __) async => http.StreamedResponse(stream.stream, 201)));
    final pending = await api.enqueueSos();
    expect((await api.flush()).delivery, SosDelivery.queued);
    expect(cancelled, true);
    expect(store.values['alice']?.requestId, pending.requestId);
    await stream.close();
  });
  test('an impossible expiry cannot acknowledge and discard a queued SOS',
      () async {
    final store = MemoryOutbox();
    final api = client(
        store,
        MockClient((_) async => http.Response(
            jsonEncode({
              'alert': {
                'id': 'incident',
                'status': 'active',
                'createdAt': '2026-10-25T12:00:00Z',
                'expiresAt': '2026-10-25T11:00:00Z'
              }
            }),
            201)));
    await api.enqueueSos();
    expect((await api.flush()).delivery, SosDelivery.reviewRequired);
    expect(store.values, isNotEmpty);
  });
  test('offline token refresh never prevents durable local SOS submission',
      () async {
    final store = MemoryOutbox();
    var refreshes = 0;
    final api = client(
        store, MockClient((_) async => throw StateError('must not send')),
        session: () async {
      refreshes++;
      throw ApiSessionUnavailable();
    });
    final item = await api.enqueueSos();
    expect(refreshes, 0);
    expect(store.values['alice']?.requestId, item.requestId);
    expect((await api.flush()).delivery, SosDelivery.queued);
    expect(refreshes, 1);
    expect(store.values['alice']?.requestId, item.requestId);
  });
  test('unknown local account cannot persist anonymous location', () async {
    final store = MemoryOutbox();
    final api = MigrationApiClient(
        baseUri: Uri.parse('https://api.invalid'),
        knownSubject: () => null,
        session: () async => null,
        outbox: store,
        httpClient: MockClient((_) async => receipt()));
    await expectLater(api.enqueueSos(), throwsStateError);
    expect(store.values, isEmpty);
  });
}
