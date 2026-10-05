import 'package:flutter_test/flutter_test.dart';
import 'package:alehulsh_app/services/keyword_verification.dart';

void main() {
  group('isKeywordMatch - the bypass that shipped', () {
    // This is the regression that matters most. The previous implementation
    // accepted ANY non-empty string when the user had no keyword configured,
    // so typing one character silenced a live emergency alarm.
    test('refuses any input when no keyword is configured', () {
      for (final attempt in ['x', 'milo', 'Milo', 'anything', '1', '   a   ']) {
        expect(
          isKeywordMatch(configured: '', input: attempt),
          isFalse,
          reason: 'input "$attempt" must not cancel when no keyword is set',
        );
      }
    });

    test('refuses the old hardcoded default', () {
      // 'Milo' was the shipped default and appeared in the UI hint, so it is
      // the first thing an attacker tries. It must carry no special meaning.
      expect(isKeywordMatch(configured: '', input: 'Milo'), isFalse);
      expect(isKeywordMatch(configured: 'tigist', input: 'Milo'), isFalse);
    });

    test('a whitespace-only keyword counts as unconfigured', () {
      expect(isKeywordMatch(configured: '   ', input: 'anything'), isFalse);
      expect(isKeywordMatch(configured: '\t\n', input: ''), isFalse);
    });
  });

  group('isKeywordMatch - correct keyword', () {
    test('accepts the exact keyword', () {
      expect(isKeywordMatch(configured: 'tigist', input: 'tigist'), isTrue);
    });

    test('ignores case and surrounding whitespace', () {
      // She may be typing one-handed, in the dark, under stress. Spacing and
      // capitalisation must never decide whether she can stop the alarm.
      for (final input in ['TIGIST', 'Tigist', '  tigist  ', '\ttigist\n']) {
        expect(
          isKeywordMatch(configured: 'Tigist', input: input),
          isTrue,
          reason: '"$input" should be accepted',
        );
      }
    });

    test('accepts an Amharic keyword', () {
      expect(isKeywordMatch(configured: 'ትዕግስት', input: 'ትዕግስት'), isTrue);
      expect(isKeywordMatch(configured: 'ትዕግስት', input: ' ትዕግስት '), isTrue);
    });
  });

  group('isKeywordMatch - wrong keyword', () {
    test('rejects a different word', () {
      expect(isKeywordMatch(configured: 'tigist', input: 'tigis'), isFalse);
      expect(isKeywordMatch(configured: 'tigist', input: 'tigistt'), isFalse);
      expect(isKeywordMatch(configured: 'tigist', input: 'hana'), isFalse);
    });

    test('rejects empty input even when a keyword is configured', () {
      // Matters because the dialog can be dismissed with an empty field, and
      // because an attacker mashing OK must not get a cancellation.
      expect(isKeywordMatch(configured: 'tigist', input: ''), isFalse);
      expect(isKeywordMatch(configured: 'tigist', input: '   '), isFalse);
    });

    test('rejects a substring and a superstring', () {
      expect(isKeywordMatch(configured: 'tigist', input: 't'), isFalse);
      expect(isKeywordMatch(configured: 't', input: 'tigist'), isFalse);
    });
  });

  group('normalizeKeyword', () {
    test('trims and lowercases', () {
      expect(normalizeKeyword('  Tigist  '), 'tigist');
      expect(normalizeKeyword('TIGIST'), 'tigist');
    });

    test('leaves inner spacing alone', () {
      // Two words is a legitimate keyword; collapsing inner spaces would make
      // a keyword she set un-enterable.
      expect(normalizeKeyword('  two words  '), 'two words');
    });

    test('is idempotent', () {
      const raw = '  MiXeD Case  ';
      expect(normalizeKeyword(normalizeKeyword(raw)), normalizeKeyword(raw));
    });
  });
}
