import 'package:flutter_test/flutter_test.dart';
import 'package:alehulsh_app/models/sos_submission_state.dart';

void main() {
  test('an empty observation made during sending cannot erase the queued result later', () {
    final guard=SosReconciliationGuard(); guard.beginSubmission();
    final observed=guard.generation;
    expect(guard.canApplyAbsence(observedGeneration:observed,authoritative:true,wasSending:true),isFalse);
    expect(guard.canApplyAbsence(observedGeneration:observed,authoritative:true,wasSending:false),isTrue);
  });
  test('a new SOS invalidates a pending reconciliation from the previous incident', () {
    final guard=SosReconciliationGuard(); final observed=guard.generation;
    guard.beginSubmission();
    expect(guard.canApplyAbsence(observedGeneration:observed,authoritative:true,wasSending:false),isFalse);
    expect(guard.canApplyAbsence(observedGeneration:guard.generation,authoritative:false,wasSending:false),isFalse);
  });
}
