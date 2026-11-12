import 'package:shared_preferences/shared_preferences.dart';

/// Shared by foreground and background isolates. Storage failures cannot
/// silently restore private notification display or registration.
Future<bool> privateNotificationsAllowed({bool requireConsent = false}) async {
  try {
    final prefs = await SharedPreferences.getInstance();
    await prefs.reload();
    if (prefs.getBool('notifications_enabled') == false) return false;
    if (!requireConsent) return true;
    final owner = prefs.getString('private_push_owner');
    return owner != null &&
        prefs.getBool('push_disable_pending:$owner') != true &&
        (prefs.getString('push_consent:$owner')?.isNotEmpty ?? false);
  } catch (_) {
    return false;
  }
}

/// Persist the desired state before allocating a revision or making a request.
/// Recovery must still see the opt-out if either later step fails or is killed.
Future<void> persistPrivateOptOut(SharedPreferences prefs, String owner) async {
  if (!await prefs.setBool('push_disable_pending:$owner', true)) {
    throw StateError('Opt-out could not be persisted');
  }
  await prefs.remove('push_consent:$owner');
  await prefs.remove('push_registration_pending:$owner');
}
