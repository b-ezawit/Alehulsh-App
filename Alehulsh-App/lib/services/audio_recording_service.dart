import 'dart:convert';
import 'dart:io';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';

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

  /// Stops recording and returns the base64 audio data URI string to be saved in Firestore
  Future<String?> stopRecording() async {
    try {
      final path = await _audioRecorder.stop();
      _isRecording = false;

      final filePath = path ?? _currentRecordingPath;
      if (filePath != null) {
        final file = File(filePath);
        if (await file.exists()) {
          final bytes = await file.readAsBytes();
          if (bytes.isNotEmpty) {
            final base64Str = base64Encode(bytes);
            return 'data:audio/aac;base64,$base64Str';
          }
        }
      }
      return null;
    } catch (e) {
      _isRecording = false;
      return null;
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
