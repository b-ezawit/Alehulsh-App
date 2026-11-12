import 'dart:convert';
import 'dart:io';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';
import 'audio_evidence_limits.dart';
import '../api/api_runtime.dart';
import '../api/evidence_api.dart';

/// The outcome of stopping a recording.
///
/// Replaces a bare `String?`. Null meant "no recording", "recorder threw",
/// "file missing", "empty file" and - once a size limit existed - "too large",
/// all at once; the caller could only turn it into an empty audioUrl and show
/// success. Each of those needs a different thing said to the woman holding
/// the phone.
class AudioCapture {
  const AudioCapture._(this.verdict, {this.dataUri, this.rawBytes = 0, this.filePath});

  factory AudioCapture.ok(String dataUri, int rawBytes, String? filePath) =>
      AudioCapture._(AudioEvidenceVerdict.ok,
          dataUri: dataUri, rawBytes: rawBytes, filePath: filePath);

  factory AudioCapture.empty() => const AudioCapture._(AudioEvidenceVerdict.empty);
  factory AudioCapture.local(int length,String path)=>AudioCapture._(AudioEvidenceVerdict.ok,rawBytes:length,filePath:path);

  /// The recording EXISTS and is kept on the device; it just cannot go in the
  /// document. [filePath] is carried so a future upload path can collect it
  /// rather than it being lost.
  factory AudioCapture.tooLarge(int rawBytes, String? filePath) =>
      AudioCapture._(AudioEvidenceVerdict.tooLarge,
          rawBytes: rawBytes, filePath: filePath);

  final AudioEvidenceVerdict verdict;

  /// `data:audio/aac;base64,...`, only when [verdict] is ok.
  final String? dataUri;

  /// Size before encoding. 0 when nothing was captured.
  final int rawBytes;

  /// Where the recording still is on disk, when there is one.
  final String? filePath;

  bool get isOk => verdict == AudioEvidenceVerdict.ok && (dataUri != null||filePath!=null);
}

class AudioRecordingService {
  static final AudioRecordingService _instance = AudioRecordingService._internal();
  factory AudioRecordingService() => _instance;
  AudioRecordingService._internal();

  final AudioRecorder _audioRecorder = AudioRecorder();
  String? _currentRecordingPath;
  bool _isRecording = false;

  bool get isRecording => _isRecording;

  Future<bool> hasPermission() async {
    try {
      return await _audioRecorder.hasPermission();
    } catch (e) {
      return false;
    }
  }

  /// Starts recording microphone audio to a local AAC file
  Future<bool> startRecording() async {
    try {
      bool permitted = await _audioRecorder.hasPermission();
      if (!permitted) return false;

      final tempDir = await getTemporaryDirectory();
      final path = '${tempDir.path}/sos_voice_${DateTime.now().millisecondsSinceEpoch}.m4a';
      _currentRecordingPath = path;

      await _audioRecorder.start(
        const RecordConfig(
          encoder: AudioEncoder.aacLc,
          bitRate: 64000,
          sampleRate: 44100,
        ),
        path: path,
      );
      _isRecording = true;
      return true;
    } catch (e) {
      _isRecording = false;
      return false;
    }
  }

  /// Stops recording and reports what can be done with the result.
  ///
  /// Never returns a bare null for five different reasons. A recording that is
  /// too large is reported AS too large, with its size and the path it is
  /// still sitting at - losing evidence quietly is the failure this replaces.
  Future<AudioCapture> stopRecording() async {
    String? filePath;
    try {
      final path = await _audioRecorder.stop();
      _isRecording = false;

      filePath = path ?? _currentRecordingPath;
      if (filePath == null) return AudioCapture.empty();

      final file = File(filePath);
      if (!await file.exists()) return AudioCapture.empty();
      if(ApiRuntime.enabled){
        final length=await file.length();
        if(length<1)return AudioCapture.empty();
        if(length>EvidenceApi.maxBytes)return AudioCapture.tooLarge(length,filePath);
        return AudioCapture.local(length,filePath);
      }

      final bytes = await file.readAsBytes();
      switch (classifyAudioEvidence(bytes.length)) {
        case AudioEvidenceVerdict.empty:
          return AudioCapture.empty();
        case AudioEvidenceVerdict.tooLarge:
          // Checked BEFORE encoding: base64 of an oversized file would be a
          // pointless allocation of a third again its size, on a phone that
          // is mid-emergency.
          return AudioCapture.tooLarge(bytes.length, filePath);
        case AudioEvidenceVerdict.ok:
          return AudioCapture.ok(
            'data:audio/aac;base64,${base64Encode(bytes)}',
            bytes.length,
            filePath,
          );
      }
    } catch (e) {
      _isRecording = false;
      // The file may well exist and be readable later; report nothing
      // captured rather than claiming a note was attached.
      return AudioCapture.empty();
    }
  }

  Future<void> cancelRecording() async {
    try {
      await _audioRecorder.stop();
      _isRecording = false;
      if (_currentRecordingPath != null) {
        final file = File(_currentRecordingPath!);
        if (await file.exists()) {
          await file.delete();
        }
      }
    } catch (_) {
      _isRecording = false;
    }
  }

  void dispose() {
    _audioRecorder.dispose();
  }
}
