import 'package:flutter/foundation.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:http/http.dart' as http;
import '../auth/identity_runtime.dart';
import '../auth/firebase_identity_provider.dart';
import '../auth/supabase_identity_provider.dart';
import '../auth/secure_session_store.dart';
import 'api_configuration.dart';
import 'migration_api_client.dart';
import 'account_api.dart';

class ApiRuntime {
  static const requested=kReleaseMode || String.fromEnvironment('ALEHULSH_DATA_ACCESS',defaultValue:'firestore')!='firestore';
  static MigrationApiClient? _client;
  static ApiIdentity? _identity;
  static SupabaseIdentityProvider? supabase;
  static ApiIdentity get identity=>_identity??(throw StateError('API authentication is unavailable'));
  static bool get enabled=>requested;
  static MigrationApiClient get client=>_client??(throw StateError('Trusted API is unavailable'));
  static AccountApi get account=>AccountApi(client);
  static Future<void> initialize() async {
    IdentityRuntime.requireTrusted=requested;
    final config=ApiConfiguration.parse(const {
      'ALEHULSH_DATA_ACCESS':String.fromEnvironment('ALEHULSH_DATA_ACCESS',defaultValue:'firestore'),
      'FIREBASE_ENV':String.fromEnvironment('FIREBASE_ENV'),
      'ALEHULSH_API_ORIGIN_DEV':String.fromEnvironment('ALEHULSH_API_ORIGIN_DEV'),
      'ALEHULSH_API_ORIGIN_PROD':String.fromEnvironment('ALEHULSH_API_ORIGIN_PROD'),
      'ALEHULSH_API_AUTH':String.fromEnvironment('ALEHULSH_API_AUTH'),
      'USE_FIREBASE_EMULATORS':String.fromEnvironment('USE_FIREBASE_EMULATORS'),
    },release:kReleaseMode);
    _client=null;_identity=config.identity;
    if(!config.enabled)return;
    late final TrustedIdentityProvider provider;
    if(config.identity==ApiIdentity.supabase) {
      const env=String.fromEnvironment('FIREBASE_ENV');
      const devUrl=String.fromEnvironment('ALEHULSH_SUPABASE_URL_DEV'),prodUrl=String.fromEnvironment('ALEHULSH_SUPABASE_URL_PROD');
      const devKey=String.fromEnvironment('ALEHULSH_SUPABASE_PUBLISHABLE_KEY_DEV'),prodKey=String.fromEnvironment('ALEHULSH_SUPABASE_PUBLISHABLE_KEY_PROD');
      final raw=env=='dev'?devUrl:prodUrl;
      if(raw.isEmpty)throw StateError('Environment-specific public Auth configuration required');
      final origin=Uri.parse(raw);
      supabase=SupabaseIdentityProvider(origin:origin,publishableKey:env=='dev'?devKey:prodKey,
        store:NativeSessionStore(origin.origin),proofStore:NativeSessionStore(origin.origin,slot:'pkce'));
      provider=supabase!;IdentityRuntime.trusted=provider;
      await supabase!.initialize();
    } else {
      provider=FirebaseIdentityProvider(FirebaseAuth.instance);
      IdentityRuntime.trusted=provider;
    }
    _client=MigrationApiClient(baseUri:config.origin!,session:provider.session,
      knownSubject:()=>provider.current?.uid,accountEpoch:()=>provider.generation,
      outbox:const NativeSosOutbox(),httpClient:http.Client(),
      allowLoopbackHttp:config.loopback,requireIncidentKey:true);
  }
}
