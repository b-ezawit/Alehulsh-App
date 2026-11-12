import 'package:firebase_auth/firebase_auth.dart';
import '../api/migration_api_client.dart';

class AppIdentity {
  const AppIdentity(this.uid, {this.email, this.displayName});
  final String uid;
  final String? email, displayName;
}

abstract class TrustedIdentityProvider {
  AppIdentity? get current;
  Stream<AppIdentity?> get changes;
  int get generation;
  Future<ApiSession?> session();
}

/// Application identity has one provider. Firebase is used only by the explicit
/// compatibility build; a configured target never borrows a Firebase identity.
class IdentityRuntime {
  static TrustedIdentityProvider? trusted;
  static bool requireTrusted = false;
  static AppIdentity? get current {
    if (requireTrusted) return trusted?.current;
    final user = FirebaseAuth.instance.currentUser;
    return user == null
        ? null
        : AppIdentity(user.uid,
            email: user.email, displayName: user.displayName);
  }

  static Stream<AppIdentity?> get changes => requireTrusted
      ? trusted!.changes
      : FirebaseAuth.instance.authStateChanges().map((u) => u == null
          ? null
          : AppIdentity(u.uid, email: u.email, displayName: u.displayName));
}
