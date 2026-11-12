import 'dart:async';
import 'package:firebase_auth/firebase_auth.dart';
import '../api/migration_api_client.dart';
import 'identity_runtime.dart';

/// Transitional trusted Node API authentication; never a target release.
class FirebaseIdentityProvider implements TrustedIdentityProvider {
  FirebaseIdentityProvider(this.auth) {
    _subscription = auth.authStateChanges().listen((_) {
      _generation++;
    });
  }
  final FirebaseAuth auth;
  late final StreamSubscription<User?> _subscription;
  int _generation = 0;
  @override
  int get generation => _generation;
  @override
  AppIdentity? get current {
    final u = auth.currentUser;
    return u == null
        ? null
        : AppIdentity(u.uid, email: u.email, displayName: u.displayName);
  }

  @override
  Stream<AppIdentity?> get changes =>
      auth.authStateChanges().map((u) => u == null
          ? null
          : AppIdentity(u.uid, email: u.email, displayName: u.displayName));
  @override
  Future<ApiSession?> session() async {
    final u = auth.currentUser, epoch = generation;
    if (u == null) return null;
    try {
      final token = await u.getIdToken();
      if (epoch != generation ||
          auth.currentUser?.uid != u.uid ||
          token == null) return null;
      return ApiSession(u.uid, token);
    } on FirebaseAuthException catch (error) {
      if (['network-request-failed', 'internal-error'].contains(error.code))
        throw ApiSessionUnavailable();
      return null;
    }
  }

  Future<void> dispose() => _subscription.cancel();
}
