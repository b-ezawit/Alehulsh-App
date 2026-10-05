/// Safety-keyword verification for SOS cancellation.
///
/// Deliberately a standalone module with no Firebase, no I/O and no logging, so
/// the one decision that can silence a live emergency alarm is directly unit
/// testable. See test/keyword_verification_test.dart.
///
/// This is the CLIENT-side stopgap. The authoritative check is the server's
/// resolve endpoint (api/src/crypto/keyword.ts), which compares scrypt hashes
/// in constant time and cannot be bypassed by patching the app. Until the
/// client calls that endpoint (P1-08.5), this runs on a device the attacker may
/// be holding, so treat it as a usability guard rather than a security barrier.
library;

/// Normalise a keyword for comparison: trim surrounding whitespace, lowercase.
///
/// Spacing and capitalisation must never decide whether a woman can stop an
/// alarm - she may be typing one-handed, in the dark, under stress.
///
/// This is NOT full Unicode NFKC. The server normalises NFKC before hashing;
/// Dart has no built-in NFKC, and adding a Unicode dependency for a comparison
/// that disappears at P1-08.5 is not worth the supply-chain surface. The
/// practical gap is Amharic entered via different codepoint sequences, which
/// the server will handle once it is authoritative.
String normalizeKeyword(String raw) => raw.trim().toLowerCase();

/// Whether [input] is the correct keyword for a user whose configured keyword
/// is [configured].
///
/// Returns false in three distinct situations:
///
///   1. No keyword configured ([configured] empty)
///   2. Nothing entered ([input] empty)
///   3. Wrong keyword
///
/// Callers MUST NOT distinguish these three for the user. A person may be
/// standing over her shoulder watching the screen, and he must not learn which
/// case he is in - least of all that no keyword exists and the alarm therefore
/// cannot be cancelled by anyone.
///
/// Case 1 returning false is intentional. The previous implementation accepted
/// ANY non-empty string when no keyword was configured, so a single character
/// silenced the alarm. Refusing instead means her alert escalates and her
/// contacts are told, which is the safe direction to fail.
bool isKeywordMatch({required String configured, required String input}) {
  final expected = normalizeKeyword(configured);
  final entered = normalizeKeyword(input);

  if (expected.isEmpty || entered.isEmpty) return false;
  return expected == entered;
}
