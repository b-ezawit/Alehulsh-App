import 'dart:async';
import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:alehulsh_app/auth/supabase_identity_provider.dart';
import 'package:alehulsh_app/auth/secure_session_store.dart';
import 'package:alehulsh_app/api/migration_api_client.dart';

const alice = '11111111-1111-4111-8111-111111111111',
    bob = '22222222-2222-4222-8222-222222222222';
String jwt(String uid, {int? expiry}) {
  String encode(Object value) =>
      base64Url.encode(utf8.encode(jsonEncode(value))).replaceAll('=', '');
  return '${encode({'alg': 'ES256'})}.${encode({
        'sub': uid,
        'role': 'authenticated',
        'session_id': '33333333-3333-4333-8333-333333333333',
        'exp': expiry ?? DateTime.now().millisecondsSinceEpoch ~/ 1000 + 3600
      })}.synthetic';
}

Map<String, dynamic> session(String uid,
        {int? expiry, String refresh = 'synthetic-refresh'}) =>
    {
      'access_token': jwt(uid, expiry: expiry),
      'refresh_token': refresh,
      'token_type': 'bearer',
      'expires_in': 3600,
      'user': {
        'id': uid,
        'aud': 'authenticated',
        'role': 'authenticated',
        'created_at': '2026-11-11T00:00:00Z',
        'email': 'synthetic@example.invalid',
        'app_metadata': {},
        'user_metadata': {'unsafe-extra': 'must-not-persist'}
      }
    };

class MemorySessionStore implements SecureSessionStore {
  String? value;
  @override
  Future<String?> read() async => value;
  @override
  Future<void> write(String session) async {
    value = session;
  }

  @override
  Future<void> remove() async {
    value = null;
  }
}

class FailingRemovalStore extends MemorySessionStore {
  bool fail = false;
  @override
  Future<void> remove() async {
    if (fail) throw StateError('synthetic storage failure');
    await super.remove();
  }
}

void main() {
  late MemorySessionStore store;
  late SupabaseIdentityProvider provider;
  SupabaseIdentityProvider make(
          Future<http.Response> Function(http.Request) send) =>
      SupabaseIdentityProvider(
          origin: Uri.parse('https://synthetic.invalid'),
          publishableKey: 'sb_publishable_synthetic',
          store: store,
          httpClient: () => MockClient(send));
  setUp(() {
    store = MemorySessionStore();
  });
  tearDown(() async {
    await provider.dispose();
  });
  test(
      'official SDK sends passwords verbatim and persists only minimized session fields',
      () async {
    provider = make((request) async {
      expect(request.url.path, '/auth/v1/token');
      expect(request.followRedirects, isFalse);
      expect(jsonDecode(request.body)['password'], '  synthetic password  ');
      return http.Response(jsonEncode(session(alice)), 200);
    });
    await provider.signIn(
        'synthetic@example.invalid', '  synthetic password  ');
    expect(provider.current?.uid, alice);
    expect((await provider.session())?.subject, alice);
    expect(store.value, isNot(contains('must-not-persist')));
    expect(store.value, isNot(contains('synthetic password')));
  });
  test(
      'expired stored sessions restore offline for durable enqueue without a provider request',
      () async {
    store.value = jsonEncode(session(alice, expiry: 1));
    var sends = 0;
    provider = make((_) async {
      sends++;
      throw http.ClientException('offline');
    });
    await provider.initialize();
    expect(provider.current?.uid, alice);
    expect(sends, 0);
    await expectLater(
        provider.session(), throwsA(isA<ApiSessionUnavailable>()));
    expect(provider.current?.uid, alice);
    expect(store.value, isNotNull);
  });
  test(
      'concurrent expiry refresh uses official SDK single flight and persists rotated refresh token',
      () async {
    store.value = jsonEncode(session(alice, expiry: 1));
    var refreshes = 0;
    provider = make((request) async {
      refreshes++;
      expect(request.url.queryParameters['grant_type'], 'refresh_token');
      await Future<void>.delayed(const Duration(milliseconds: 5));
      return http.Response(
          jsonEncode(session(alice, refresh: 'rotated-synthetic')), 200);
    });
    await provider.initialize();
    final values = await Future.wait([provider.session(), provider.session()]);
    expect(refreshes, 1);
    expect(values.every((v) => v?.subject == alice), isTrue);
    expect(store.value, contains('rotated-synthetic'));
  });
  test(
      'late sign-in cannot resurrect the previous account after logout and another login',
      () async {
    final old = Completer<http.Response>();
    var count = 0;
    provider = make((request) async {
      if (request.url.path.endsWith('/logout')) return http.Response('', 204);
      count++;
      if (count == 1) return await old.future;
      return http.Response(jsonEncode(session(bob)), 200);
    });
    final pending = provider.signIn('alice@example.invalid', 'synthetic');
    final rejected = expectLater(pending, throwsA(isA<AuthFlowException>()));
    await Future<void>.delayed(Duration.zero);
    await provider.signOut();
    await provider.signIn('bob@example.invalid', 'synthetic');
    old.complete(http.Response(jsonEncode(session(alice)), 200));
    await rejected;
    expect(provider.current?.uid, bob);
    expect(jsonDecode(store.value!)['user']['id'], bob);
  });
  test('redirects cannot forward authentication secrets', () async {
    var count = 0;
    provider = make((request) async {
      count++;
      return http.Response('', 307,
          headers: {'location': 'https://foreign.invalid'});
    });
    await expectLater(provider.signIn('synthetic@example.invalid', 'synthetic'),
        throwsA(isA<AuthFlowException>()));
    expect(count, 1);
    expect(store.value, isNull);
  });
  test(
      'email confirmation does not fabricate a signed-in session or save a keyword',
      () async {
    provider = make(
        (_) async => http.Response(jsonEncode(session(alice)['user']), 200));
    expect(await provider.signUp('synthetic@example.invalid', 'synthetic'),
        isFalse);
    expect(provider.current, isNull);
    expect(store.value, isNull);
  });
  test(
      'offline sign-out clears local credentials and never reports confirmed remote revocation',
      () async {
    store.value = jsonEncode(session(alice));
    provider = make((_) async {
      throw http.ClientException('offline');
    });
    await provider.initialize();
    final result = await provider.signOut();
    expect(result, isFalse);
    expect(provider.current, isNull);
    expect(store.value, isNull);
  });
  test(
      'starting a new login removes the previous durable native session before the provider request',
      () async {
    store.value = jsonEncode(session(alice));
    provider = make((_) async {
      expect(store.value, isNull);
      throw http.ClientException('offline');
    });
    await provider.initialize();
    await expectLater(provider.signIn('bob@example.invalid', 'synthetic'),
        throwsA(isA<AuthFlowException>()));
    expect(provider.current, isNull);
    expect(store.value, isNull);
  });
  test(
      'confirmed API logout remains confirmed even when provider logout is offline',
      () async {
    store.value = jsonEncode(session(alice));
    provider = make((_) async {
      throw http.ClientException('offline');
    });
    await provider.initialize();
    var revoked = false;
    final result = await provider.signOut(revoke: (token) async {
      expect(provider.current, isNull);
      expect(store.value, isNull);
      revoked = true;
      return true;
    });
    expect(revoked, isTrue);
    expect(result, isTrue);
    expect(provider.current, isNull);
  });
  test(
      'a secure-storage failure is reported while server revocation is still attempted and identity stays unavailable',
      () async {
    final failing = FailingRemovalStore()..value = jsonEncode(session(alice));
    store = failing;
    provider = make((_) async => http.Response('', 204));
    await provider.initialize();
    failing.fail = true;
    var revoked = false;
    await expectLater(provider.signOut(revoke: (_) async {
      revoked = true;
      return true;
    }), throwsA(isA<AuthFlowException>()));
    expect(revoked, isTrue);
    expect(provider.current, isNull);
    expect(await provider.session(), isNull);
    expect(store.value, isNotNull);
  });
}
