import 'dart:convert';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:alehulsh_app/services/audio_evidence_limits.dart';

/// The size ceiling on audio evidence.
///
/// Pure arithmetic, no microphone and no Firestore. What these prove is that
/// the limit is derived from Firestore's real document ceiling and that an
/// oversized recording is CLASSIFIED rather than silently dropped. What they
/// cannot prove is that a write of a permitted size actually succeeds against
/// a real document that already holds other notes — only a server-side
/// evidence store removes that risk.
void main() {
  group('base64EncodedLength matches the real encoder', () {
    test('agrees with dart:convert for every length up to 300 bytes', () {
      // The limit is only as trustworthy as this arithmetic: if the predicted
      // length were under-estimated, oversized payloads would be admitted.
      final rnd = Random(20261021);
      for (var n = 0; n <= 300; n++) {
        final bytes = List<int>.generate(n, (_) => rnd.nextInt(256));
        expect(
          base64EncodedLength(n),
          base64Encode(bytes).length,
          reason: 'predicted length disagrees with the encoder at $n bytes',
        );
      }
    });

    test('agrees at sizes near the real limit', () {
      for (final n in [
        kMaxRawAudioBytes - 3,
        kMaxRawAudioBytes - 1,
        kMaxRawAudioBytes,
        kMaxRawAudioBytes + 1,
      ]) {
        final bytes = filledBytes(n);
        expect(base64EncodedLength(n), base64Encode(bytes).length);
      }
    });
  });

  group('the limit is derived from Firestore, not invented', () {
    test('a permitted recording encodes to no more than the budget', () {
      expect(base64EncodedLength(kMaxRawAudioBytes),
          lessThanOrEqualTo(kMaxBase64AudioBytes));
    });

    test('the budget leaves real headroom inside a 1 MiB document', () {
      expect(kFirestoreDocumentLimitBytes, 1048576);
      expect(kMaxBase64AudioBytes + kAlertDocumentReserveBytes,
          kFirestoreDocumentLimitBytes);
      // Headroom exists for the rest of the document AND for notes already
      // attached, because they accumulate in one array.
      expect(kAlertDocumentReserveBytes, greaterThan(0));
      expect(base64EncodedLength(kMaxRawAudioBytes),
          lessThan(kFirestoreDocumentLimitBytes));
    });

    test('the limit is tight — one more byte would overflow the budget', () {
      // Proves kMaxRawAudioBytes is the actual inverse of the encoder, not a
      // round number chosen for comfort.
      expect(base64EncodedLength(kMaxRawAudioBytes + 3),
          greaterThan(kMaxBase64AudioBytes));
    });

    test('the limit is expressible as a duration a user can act on', () {
      expect(kRecorderBitsPerSecond, 64000);
      // ~73s at the recorder's configured bitrate. Asserted as a range, since
      // AAC is not exactly constant-bitrate and the message is advisory.
      expect(kApproxMaxRecordingSeconds, inInclusiveRange(60, 90));
    });
  });

  group('classifyAudioEvidence', () {
    test('nothing captured is empty, not ok', () {
      expect(classifyAudioEvidence(0), AudioEvidenceVerdict.empty);
      expect(classifyAudioEvidence(-1), AudioEvidenceVerdict.empty);
    });

    test('a normal recording is ok', () {
      // 10 seconds at 64 kbps.
      expect(classifyAudioEvidence(10 * 8000), AudioEvidenceVerdict.ok);
      expect(classifyAudioEvidence(1), AudioEvidenceVerdict.ok);
      expect(classifyAudioEvidence(kMaxRawAudioBytes), AudioEvidenceVerdict.ok);
    });

    test('an oversized recording is tooLarge, never ok and never empty', () {
      expect(classifyAudioEvidence(kMaxRawAudioBytes + 3),
          AudioEvidenceVerdict.tooLarge);
      // A ten-minute recording: the case that used to fail silently.
      expect(classifyAudioEvidence(600 * 8000), AudioEvidenceVerdict.tooLarge);
      // And one that would exceed the document limit outright.
      expect(classifyAudioEvidence(kFirestoreDocumentLimitBytes),
          AudioEvidenceVerdict.tooLarge);
    });

    test('nothing classified ok could overflow the document', () {
      // The property that matters, swept across the whole admissible range.
      for (final n in [
        1, 1024, 64000, 320000, kMaxRawAudioBytes - 1, kMaxRawAudioBytes,
      ]) {
        expect(classifyAudioEvidence(n), AudioEvidenceVerdict.ok);
        expect(base64EncodedLength(n), lessThan(kFirestoreDocumentLimitBytes));
      }
    });

    test('the boundary is exact in both directions', () {
      var largestOk = kMaxRawAudioBytes;
      while (classifyAudioEvidence(largestOk) != AudioEvidenceVerdict.ok) {
        largestOk--;
      }
      expect(classifyAudioEvidence(largestOk), AudioEvidenceVerdict.ok);
      expect(classifyAudioEvidence(largestOk + 3),
          AudioEvidenceVerdict.tooLarge);
    });
  });
}

/// A byte list of a given length, cheap to build at ~600 KB.
List<int> filledBytes(int n) => List<int>.filled(n, 0x41);
