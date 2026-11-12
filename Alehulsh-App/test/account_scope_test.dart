import 'dart:async';
import 'package:flutter_test/flutter_test.dart';
import 'package:alehulsh_app/services/account_scope.dart';

void main() {
  test('late account A read is discarded after B signs in', () async {
    final scope = AccountScope()..bind('alice');
    final ticket = scope.capture('alice')!;
    final pending = Completer<String>();
    final read = scope.read(ticket, () => pending.future);
    scope.bind('bob'); pending.complete('private Alice profile');
    expect(await read, isNull);
    expect(scope.owns(ticket), isFalse);
    expect(scope.capture('alice'), isNull);
  });
  test('logout and relogin as the same owner cannot resurrect stale work', () async {
    final scope = AccountScope()..bind('alice');
    final old = scope.capture('alice')!;
    scope.bind(null); scope.bind('alice');
    var reads = 0;
    expect(await scope.read(old, () async { reads++; return 'stale'; }), isNull);
    expect(reads, 0);
    expect(await scope.read(scope.capture('alice')!, () async => 'current'), 'current');
  });
}
