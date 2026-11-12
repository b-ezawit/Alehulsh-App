import 'package:flutter_test/flutter_test.dart';
import 'package:alehulsh_app/api/api_configuration.dart';

void main() {
  test('unknown data access modes fail closed instead of selecting Firestore', () {
    expect(() => ApiConfiguration.parse({'ALEHULSH_DATA_ACCESS': 'typo'}, release: false), throwsStateError);
  });
  const base = {'ALEHULSH_DATA_ACCESS': 'trusted_api', 'FIREBASE_ENV': 'dev', 'ALEHULSH_API_AUTH': 'firebase'};
  test('no API is selected implicitly and no origin is invented', () {
    expect(ApiConfiguration.parse({}, release: false).enabled, isFalse);
    expect(() => ApiConfiguration.parse({}, release: true), throwsStateError);
    expect(() => ApiConfiguration.parse({'ALEHULSH_DATA_ACCESS': 'firestore'}, release: true), throwsStateError);
    expect(() => ApiConfiguration.parse(base, release: false), throwsStateError);
  });
  test('each environment requires its own explicit origin', () {
    expect(() => ApiConfiguration.parse({...base, 'FIREBASE_ENV': 'prod', 'ALEHULSH_API_ORIGIN_DEV': 'https://synthetic.invalid'}, release: true), throwsStateError);
    expect(ApiConfiguration.parse({...base, 'ALEHULSH_API_ORIGIN_DEV': 'https://synthetic.invalid'}, release: false).identity, ApiIdentity.firebase);
  });
  test('credentials, paths, fragments and remote HTTP are refused', () {
    for (final uri in ['https://user:password@synthetic.invalid', 'https://synthetic.invalid/path', 'https://synthetic.invalid/#fragment', 'http://synthetic.invalid']) {
      expect(() => ApiConfiguration.parse({...base, 'ALEHULSH_API_ORIGIN_DEV': uri}, release: false), throwsStateError);
    }
  });
  test('loopback HTTP requires explicit non-release development emulator mode', () {
    final values = {...base, 'ALEHULSH_API_ORIGIN_DEV': 'http://127.0.0.1:18081', 'USE_FIREBASE_EMULATORS': 'true'};
    expect(ApiConfiguration.parse(values, release: false).loopback, isTrue);
    expect(() => ApiConfiguration.parse(values, release: true), throwsStateError);
    expect(() => ApiConfiguration.parse({...values, 'USE_FIREBASE_EMULATORS': 'false'}, release: false), throwsStateError);
  });
}
