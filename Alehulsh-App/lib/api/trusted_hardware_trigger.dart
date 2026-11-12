/// A late native callback is an existing account-bound intent, never authority
/// to create an SOS for whichever account happens to be foregrounded now.
String? trustedHardwareRequest(Object? arguments, String? selectedOwner) {
  if (arguments is! Map ||
      selectedOwner == null ||
      arguments['ownerSubject'] != selectedOwner) return null;
  final request = arguments['requestId'];
  return request is String && RegExp(r'^[a-zA-Z0-9-]{8,128}$').hasMatch(request)
      ? request
      : null;
}
