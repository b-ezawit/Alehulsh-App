/// Lifecycle of one SOS submission, from the user's point of view.
///
/// Exists to enforce a single invariant:
///
///   The UI must never tell the user an SOS was sent when the system does not
///   have evidence the alert was accepted for processing.
///
/// A boolean cannot express that. The previous implementation used one
/// (`_isSOSSent`), set it to true BEFORE the write, and swallowed write errors,
/// so a failed alert was indistinguishable from a delivered one: the screen
/// showed "BROADCAST ACTIVE" either way.
enum SosSubmissionState {
  /// No alert. The SOS button is armed.
  idle,

  /// The write is in flight and nothing has been confirmed. The user is told we
  /// are sending, never that we have sent.
  sending,

  /// Written to this device only, not yet acknowledged by the server.
  ///
  /// Reached when the write does not complete within the ack timeout, which is
  /// the normal offline case: Firestore resolves set() on server acknowledgement
  /// and keeps the write queued until connectivity returns.
  ///
  /// Escalation is NOT active. Nobody has been notified. The user must be told
  /// plainly so she can call for help by other means.
  queued,

  /// The server has acknowledged the alert. Escalation is active.
  ///
  /// This is the only state in which the app may claim the alert was sent.
  sent,

  /// The write was rejected. Nothing is queued and nothing will retry on its
  /// own. The user must be shown the failure and offered a retry.
  failed,
}

extension SosSubmissionStateX on SosSubmissionState {
  /// An alert exists somewhere - on the device or on the server - so the active
  /// SOS controls (cancel, voice note, urgent toggle) belong on screen.
  bool get hasAlert =>
      this == SosSubmissionState.queued || this == SosSubmissionState.sent;

  /// The alert has demonstrably reached the backend. Only here may the UI say
  /// it was sent.
  bool get isDelivered => this == SosSubmissionState.sent;

  /// A submission is in progress; suppress a second trigger.
  bool get isBusy => this == SosSubmissionState.sending;

  /// Something went wrong and the user has to act.
  bool get needsAttention =>
      this == SosSubmissionState.failed || this == SosSubmissionState.queued;
}
