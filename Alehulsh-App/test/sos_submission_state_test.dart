import 'package:flutter_test/flutter_test.dart';
import 'package:alehulsh_app/models/sos_submission_state.dart';

void main() {
  group('the invariant: only `sent` may be presented as delivered', () {
    test('isDelivered is true for sent and nothing else', () {
      for (final state in SosSubmissionState.values) {
        expect(
          state.isDelivered,
          state == SosSubmissionState.sent,
          reason: '$state must not claim delivery',
        );
      }
    });

    test('queued is NOT delivered', () {
      // The regression that matters: a queued alert exists only on the phone.
      // Nobody has been notified. Presenting it as sent is the bug this enum
      // was introduced to make impossible.
      expect(SosSubmissionState.queued.isDelivered, isFalse);
    });

    test('sending is NOT delivered', () {
      // _isSOSSent used to be set before the write, which is exactly this.
      expect(SosSubmissionState.sending.isDelivered, isFalse);
    });

    test('failed is NOT delivered', () {
      expect(SosSubmissionState.failed.isDelivered, isFalse);
    });
  });

  group('hasAlert drives the active-SOS controls', () {
    test('true exactly for queued and sent', () {
      expect(SosSubmissionState.queued.hasAlert, isTrue);
      expect(SosSubmissionState.sent.hasAlert, isTrue);
      expect(SosSubmissionState.idle.hasAlert, isFalse);
      expect(SosSubmissionState.sending.hasAlert, isFalse);
      expect(SosSubmissionState.failed.hasAlert, isFalse);
    });

    test('hasAlert does not imply delivery', () {
      // These two must never be collapsed back into one boolean.
      expect(SosSubmissionState.queued.hasAlert, isTrue);
      expect(SosSubmissionState.queued.isDelivered, isFalse);
    });
  });

  group('retry is reachable from failed but not from an active alert', () {
    // _triggerSOS returns early when isBusy || hasAlert.
    bool canTrigger(SosSubmissionState s) => !(s.isBusy || s.hasAlert);

    test('failed can retry', () {
      expect(canTrigger(SosSubmissionState.failed), isTrue);
    });

    test('idle can send', () {
      expect(canTrigger(SosSubmissionState.idle), isTrue);
    });

    test('sending cannot double-send', () {
      expect(canTrigger(SosSubmissionState.sending), isFalse);
    });

    test('an existing alert cannot be duplicated', () {
      expect(canTrigger(SosSubmissionState.queued), isFalse);
      expect(canTrigger(SosSubmissionState.sent), isFalse);
    });
  });

  group('needsAttention', () {
    test('flags the two states where she must act', () {
      expect(SosSubmissionState.queued.needsAttention, isTrue);
      expect(SosSubmissionState.failed.needsAttention, isTrue);
      expect(SosSubmissionState.sent.needsAttention, isFalse);
      expect(SosSubmissionState.idle.needsAttention, isFalse);
      expect(SosSubmissionState.sending.needsAttention, isFalse);
    });
  });
}
