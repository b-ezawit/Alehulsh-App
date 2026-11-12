import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:alehulsh_app/services/private_notification_settings.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test(
      'background notification display requires this account consent, not another account grant',
      () async {
    SharedPreferences.setMockInitialValues({
      'notifications_enabled': true,
      'private_push_owner': 'bob',
      'push_consent:alice': 'review-v1'
    });
    expect(await privateNotificationsAllowed(requireConsent: true), isFalse);
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('push_consent:bob', 'review-v1');
    expect(await privateNotificationsAllowed(requireConsent: true), isTrue);
  });
  test(
      'opt-out remains recoverable before revision allocation or HTTP, and suppresses a stale consent grant',
      () async {
    SharedPreferences.setMockInitialValues({
      'private_push_owner': 'alice',
      'push_device:alice': 'synthetic-device',
      'push_consent:alice': 'review-v1',
      'push_registration_pending:alice': true
    });
    final prefs = await SharedPreferences.getInstance();
    await persistPrivateOptOut(prefs, 'alice');
    await prefs.reload();
    expect(prefs.getBool('push_disable_pending:alice'), isTrue);
    expect(prefs.getInt('push_disable_revision:alice'), isNull);
    expect(prefs.getBool('push_registration_pending:alice'), isNull);
    expect(prefs.getString('push_consent:alice'), isNull);
    await prefs.setString('push_consent:alice', 'stale-review-v1');
    expect(await privateNotificationsAllowed(requireConsent: true), isFalse);
  });
  test(
      'persisted notification opt-out gates both foreground and background private delivery after restart',
      () async {
    SharedPreferences.setMockInitialValues({'notifications_enabled': false});
    expect(await privateNotificationsAllowed(), isFalse);
    final prefs = await SharedPreferences.getInstance();
    await prefs.reload();
    expect(await privateNotificationsAllowed(), isFalse);
  });
  test(
      'global display preference does not fabricate an explicit recipient consent record',
      () async {
    SharedPreferences.setMockInitialValues({'notifications_enabled': true});
    expect(await privateNotificationsAllowed(), isTrue);
    expect(
        (await SharedPreferences.getInstance())
            .getKeys()
            .any((k) => k.startsWith('push_consent:')),
        isFalse);
  });
}
