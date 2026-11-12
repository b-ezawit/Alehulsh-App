/// New credentials preserve every character. Older app versions removed outer
/// whitespace; that compatibility path is an explicit sign-in choice only.
String passwordInput(String raw, {bool legacySignIn = false}) => legacySignIn ? raw.trim() : raw;
