/// Size limits for audio evidence, and the arithmetic behind them.
///
/// WHY THIS EXISTS. `stopRecording()` base64-encodes the whole recording and
/// it is written into the alert document. Firestore refuses any document over
/// 1 MiB, so past a certain length the write FAILS - and it failed silently:
/// `stopRecording()` returned null on every error, the caller turned null into
/// an empty `audioUrl`, `addVoiceNote` swallowed the exception, and the UI
/// then showed "Voice note recorded and attached to alert!" regardless.
/// A woman recording evidence during an assault was told it was saved when it
/// was not.
///
/// Pure and plugin-free so it is unit-testable without a microphone.
///
/// THIS IS A CEILING, NOT A FIX. Audio does not belong in a database document
/// at all; it belongs in object storage with the document holding a reference.
/// That is the C-04 work. Until then these limits make the failure VISIBLE and
/// bounded rather than silent.
library;

/// Firestore's hard per-document ceiling. Not configurable, not negotiable.
const int kFirestoreDocumentLimitBytes = 1048576;

/// Reserved for everything in the alert document that is not this recording:
/// her coordinates, status, contacts, responders, messages - and crucially any
/// voice notes ALREADY attached, since notes accumulate in one array.
///
/// A quarter of the budget is a judgement, not a measurement. It is deliberate
/// headroom: the alternative is sizing a single note against the whole limit
/// and having the SECOND note break every later write to the document,
/// including non-audio ones like a status change.
const int kAlertDocumentReserveBytes = 262144;

/// What one recording's base64 payload may occupy.
const int kMaxBase64AudioBytes =
    kFirestoreDocumentLimitBytes - kAlertDocumentReserveBytes;

/// Length of the base64 encoding of [rawBytes]: four characters per three
/// bytes, rounded up, which is what the encoder actually emits.
int base64EncodedLength(int rawBytes) => ((rawBytes + 2) ~/ 3) * 4;

/// The largest recording that still fits, in raw bytes before encoding.
///
/// Derived rather than hardcoded: the inverse of [base64EncodedLength].
const int kMaxRawAudioBytes = (kMaxBase64AudioBytes ~/ 4) * 3;

/// The recorder's configured bitrate (`RecordConfig.bitRate` in
/// AudioRecordingService). Only used to express the limit to a user in
/// seconds, which is the only unit she can act on.
const int kRecorderBitsPerSecond = 64000;

/// Roughly how long a recording may be. Approximate by nature - AAC is not
/// perfectly constant-bitrate - so it is used for messaging, never as the
/// enforcement mechanism. Bytes are enforced.
int get kApproxMaxRecordingSeconds =>
    (kMaxRawAudioBytes * 8) ~/ kRecorderBitsPerSecond;

/// Whether a recording of [rawBytes] can be attached.
enum AudioEvidenceVerdict {
  /// Fits, and has content.
  ok,

  /// Nothing was captured. Not an error to hide, but not a note either.
  empty,

  /// Captured, but too large for the document. The recording still exists on
  /// the device: the caller must say so rather than discard it.
  tooLarge,
}

AudioEvidenceVerdict classifyAudioEvidence(int rawBytes) {
  if (rawBytes <= 0) return AudioEvidenceVerdict.empty;
  if (base64EncodedLength(rawBytes) > kMaxBase64AudioBytes) {
    return AudioEvidenceVerdict.tooLarge;
  }
  return AudioEvidenceVerdict.ok;
}
