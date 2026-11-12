enum ApiIdentity { firebase, supabase }

/// Build-time configuration only. Missing trusted configuration never falls
/// back to direct writes, and development endpoints cannot select production.
class ApiConfiguration {
  const ApiConfiguration._(this.enabled, this.origin, this.identity, this.loopback);
  final bool enabled;
  final Uri? origin;
  final ApiIdentity? identity;
  final bool loopback;

  factory ApiConfiguration.parse(Map<String, String> values, {required bool release}) {
    final mode = values['ALEHULSH_DATA_ACCESS'] ?? 'firestore';
    if (mode == 'firestore') {
      if (release) throw StateError('Release builds require the trusted API');
      return const ApiConfiguration._(false, null, null, false);
    }
    if (mode != 'trusted_api') throw StateError('Unknown data-access mode');
    final env = values['FIREBASE_ENV'];
    if (env != 'dev' && env != 'prod') throw StateError('Explicit application environment required');
    final raw = values[env == 'dev' ? 'ALEHULSH_API_ORIGIN_DEV' : 'ALEHULSH_API_ORIGIN_PROD'];
    if (raw == null || raw.trim().isEmpty) throw StateError('API origin is not configured for this environment');
    final uri = Uri.tryParse(raw);
    final local = uri != null && ['localhost', '127.0.0.1', '::1'].contains(uri.host);
    final allowHttp = !release && env == 'dev' && values['USE_FIREBASE_EMULATORS'] == 'true' && local;
    if (uri == null || uri.host.isEmpty || (uri.scheme != 'https' && !(allowHttp && uri.scheme == 'http')) ||
        uri.userInfo.isNotEmpty || uri.hasQuery || uri.hasFragment || !(uri.path.isEmpty || uri.path == '/')) {
      throw StateError('A verified HTTPS API origin is required');
    }
    final identity = switch (values['ALEHULSH_API_AUTH']) {
      'firebase' => ApiIdentity.firebase,
      'supabase' => ApiIdentity.supabase,
      _ => throw StateError('Explicit API identity provider required'),
    };
    if(release && identity!=ApiIdentity.supabase) throw StateError('Target releases require Supabase Auth');
    return ApiConfiguration._(true, uri, identity, allowHttp);
  }
}
