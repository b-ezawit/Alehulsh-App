import 'package:flutter_test/flutter_test.dart';
import 'package:alehulsh_app/services/password_input.dart';

void main() {
  test('registration and ordinary authentication preserve password characters', () {
    for (final value in ['  synthetic password  ', '\tሰላም\n', ' synthetic ', 'normal']) {
      expect(passwordInput(value), value);
    }
  });
  test('legacy spacing compatibility is explicit and preserves internal whitespace', () {
    expect(passwordInput('  synthetic  password  ', legacySignIn: true), 'synthetic  password');
    expect(passwordInput('  synthetic  password  '), '  synthetic  password  ');
  });
}
