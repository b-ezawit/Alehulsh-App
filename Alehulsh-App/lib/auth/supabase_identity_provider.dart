import 'dart:async';
import 'dart:convert';
import 'package:gotrue/gotrue.dart' as auth;
import 'package:http/http.dart' as http;
import '../api/migration_api_client.dart';
import 'identity_runtime.dart';
import 'origin_locked_client.dart';
import 'secure_session_store.dart';

class AuthFlowException implements Exception {
  const AuthFlowException(
      [this.message = 'Authentication could not be completed. Please retry.']);
  final String message;
  @override
  String toString() => message;
}

/// Official Supabase Auth client only: no database, storage or PostgREST SDK.
/// Client generation isolates late login/refresh work from a later account.
class SupabaseIdentityProvider implements TrustedIdentityProvider {
  SupabaseIdentityProvider(
      {required this.origin,
      required this.publishableKey,
      required this.store,
      SecureSessionStore? proofStore,
      http.Client Function()? httpClient})
      : proofStore = proofStore ?? _MemoryProofStore(),
        _httpClient = httpClient ?? (() => http.Client()) {
    if (origin.scheme != 'https' ||
        origin.host.isEmpty ||
        origin.userInfo.isNotEmpty ||
        origin.hasQuery ||
        origin.hasFragment ||
        !(origin.path.isEmpty || origin.path == '/'))
      throw ArgumentError('Explicit HTTPS Auth origin required');
    if (publishableKey.isEmpty || publishableKey.startsWith('sb_secret_'))
      throw ArgumentError('Public Auth configuration required');
    // Legacy service_role JWTs must never be embedded in a mobile build.
    if (publishableKey.split('.').length == 3) {
      try {
        final claim = jsonDecode(utf8.decode(base64Url
            .decode(base64Url.normalize(publishableKey.split('.')[1]))));
        if (claim['role'] != 'anon')
          throw ArgumentError('Only a public Auth key is allowed');
      } on FormatException {
        throw ArgumentError('Public Auth configuration required');
      }
    } else if (!publishableKey.startsWith('sb_publishable_'))
      throw ArgumentError('Public Auth configuration required');
    _replace();
  }
  final Uri origin;
  final String publishableKey;
  final SecureSessionStore store;
  final SecureSessionStore proofStore;
  final http.Client Function() _httpClient;
  final _changes = StreamController<AppIdentity?>.broadcast(sync: true);
  auth.GoTrueClient? _client;
  StreamSubscription<auth.AuthState>? _subscription;
  Future<void> _writes = Future.value();
  int _generation = 0;
  AppIdentity? _current;
  String? _lastPersisted;
  @override
  AppIdentity? get current => _current;
  @override
  int get generation => _generation;
  @override
  Stream<AppIdentity?> get changes => _changes.stream;

  auth.GoTrueClient _replace() {
    _generation++;
    _subscription?.cancel();
    _client?.dispose();
    final client = auth.GoTrueClient(
        url: origin.resolve('/auth/v1').toString(),
        headers: {'apikey': publishableKey},
        autoRefreshToken: false,
        httpClient: OriginLockedClient(origin, _httpClient()),
        asyncStorage: _ProofStorage(proofStore));
    _client = client;
    _current = null;
    _subscription = client.onAuthStateChange.listen((state) {
      if (!identical(client, _client)) return;
      if (state.event == auth.AuthChangeEvent.signedOut) _generation++;
      final user = state.session?.user;
      _current = user == null ? null : AppIdentity(user.id, email: user.email);
      _changes.add(_current);
      _persist(client, generation).catchError((_) {
        /* Report only through operations, never SDK diagnostic text. */
      });
    }, onError: (_) {
      /* Request adapters classify session outages without logging tokens. */
    });
    return client;
  }

  Future<void> _persist(auth.GoTrueClient client, int epoch) {
    final session = client.currentSession;
    final record = session == null
        ? null
        : jsonEncode({
            'access_token': session.accessToken,
            'refresh_token': session.refreshToken,
            'token_type': session.tokenType,
            'expires_in': session.expiresIn,
            'user': {
              'id': session.user.id,
              'aud': session.user.aud,
              'role': session.user.role,
              'created_at': session.user.createdAt,
              'email': session.user.email,
              'app_metadata': <String, dynamic>{},
              'user_metadata': <String, dynamic>{}
            },
          });
    final next = _writes.catchError((_) {}).then((_) async {
      if (!identical(_client, client) || epoch != generation) return;
      if (record == _lastPersisted) return;
      if (record == null)
        await store.remove();
      else
        await store.write(record);
      _lastPersisted = record;
    });
    _writes = next;
    return next;
  }

  Future<void> initialize() async {
    final client = _client!, epoch = generation;
    final raw = await store.read();
    if (epoch != generation || raw == null) return;
    _lastPersisted = raw;
    try {
      // Restore without requiring connectivity. A cached identity may enqueue
      // an SOS; only the server can authenticate an attempted transmission.
      await client.setInitialSession(raw);
      if (epoch != generation) return;
    } catch (_) {
      throw const AuthFlowException(
          'Secure session could not be restored. Sign in again.');
    }
  }

  Future<bool> signUp(String email, String password) async {
    final client = _replace(), epoch = generation;
    _changes.add(null);
    try {
      await _forgetPrevious(client, epoch);
      final result =
          await client.signUp(email: email.trim(), password: password);
      if (epoch != generation || !identical(client, _client))
        throw const AuthFlowException();
      await _persist(client, epoch);
      return result.session != null;
    } catch (_) {
      throw const AuthFlowException();
    }
  }

  Future<void> signIn(String email, String password) async {
    final client = _replace(), epoch = generation;
    _changes.add(null);
    try {
      await _forgetPrevious(client, epoch);
      await client.signInWithPassword(email: email.trim(), password: password);
      if (epoch != generation || !identical(client, _client))
        throw const AuthFlowException();
      await _persist(client, epoch);
    } catch (_) {
      throw const AuthFlowException();
    }
  }

  Future<void> _forgetPrevious(auth.GoTrueClient client, int epoch) async {
    final removal = _writes.catchError((_) {}).then((_) async {
      if (epoch != generation || !identical(client, _client))
        throw const AuthFlowException();
      await store.remove();
      _lastPersisted = null;
    });
    _writes = removal;
    await removal;
    if (epoch != generation || !identical(client, _client))
      throw const AuthFlowException();
  }

  @override
  Future<ApiSession?> session() async {
    final client = _client, epoch = generation, owner = current?.uid;
    if (owner == null || client == null) return null;
    try {
      final session = await client.getSession();
      if (epoch != generation ||
          !identical(client, _client) ||
          current?.uid != owner) return null;
      if (session == null) return null;
      // Auto-refresh timers are off; the official SDK refreshes on demand and
      // coalesces concurrent refreshes. Persist rotated tokens before return.
      await _persist(client, epoch);
      return ApiSession(owner, session.accessToken);
    } catch (_) {
      if (current == null) return null;
      throw ApiSessionUnavailable();
    }
  }

  Future<bool> signOut({Future<bool> Function(String token)? revoke}) async {
    final old = _client;
    if (old == null) return false;
    final token = old.currentSession?.accessToken;
    final epoch = ++_generation;
    final subscription = _subscription;
    _subscription = null;
    _client = null;
    _current = null;
    _changes.add(null);
    final removal = _writes.catchError((_) {}).then((_) async {
      await store.remove();
      _lastPersisted = null;
    });
    _writes = removal;
    await subscription?.cancel();
    var localCleared = true;
    try {
      await removal;
    } catch (_) {
      localCleared = false;
    }
    var confirmed = false;
    try {
      if (token != null && revoke != null) confirmed = await revoke(token);
      await old.signOut(scope: auth.SignOutScope.local);
    } catch (_) {
      /* API revocation and provider logout are separate facts. */
    } finally {
      old.dispose();
      if (localCleared && generation == epoch && _client == null) _replace();
    }
    if (!localCleared)
      throw const AuthFlowException(
          'Secure logout could not be completed. Reopen the app and sign out again.');
    return confirmed;
  }

  Future<void> dispose() async {
    await _subscription?.cancel();
    _client?.dispose();
    await _writes.catchError((_) {});
    await _changes.close();
  }
}

class _ProofStorage extends auth.GotrueAsyncStorage {
  _ProofStorage(this.store);
  final SecureSessionStore store;
  @override
  Future<String?> getItem({required String key}) async {
    final value = await store.read();
    return value == null ? null : jsonDecode(value)[key] as String?;
  }

  @override
  Future<void> setItem({required String key, required String value}) =>
      store.write(jsonEncode({key: value}));
  @override
  Future<void> removeItem({required String key}) => store.remove();
}

class _MemoryProofStore implements SecureSessionStore {
  String? _value;
  @override
  Future<String?> read() async => _value;
  @override
  Future<void> write(String session) async {
    _value = session;
  }

  @override
  Future<void> remove() async {
    _value = null;
  }
}
