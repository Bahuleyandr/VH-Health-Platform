import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';
import 'package:vhhealth_core/config/api_config.dart' as core;

/// Records audio from the microphone and uploads it to the backend's
/// `/clinical/voice-note/transcribe` endpoint, returning the transcript
/// text. Used by [VoiceDictateButton] to dictate into any [TextField].
///
/// Recording lifecycle:
///   `start()` → captures to a temp WAV file via the `record` package
///   `stop()`  → uploads the WAV, awaits transcription, returns text
///   `cancel()` → discards the in-flight recording
///
/// All three are safe to call multiple times; the service guards
/// against double-start by checking the recorder's `isRecording`
/// state. Errors are surfaced via thrown exceptions so the calling
/// widget can render them in its dialog.
class VoiceDictationService {
  VoiceDictationService._();

  static final AudioRecorder _recorder = AudioRecorder();
  static String? _activePath;
  static DateTime? _startedAt;

  /// True while a recording is in progress.
  static Future<bool> get isRecording => _recorder.isRecording();

  /// Returns elapsed time since `start()` was called, or zero when idle.
  static Duration get elapsed => _startedAt == null
      ? Duration.zero
      : DateTime.now().difference(_startedAt!);

  /// Start recording to a temp WAV. Throws if mic permission is denied
  /// or if the platform doesn't support recording.
  static Future<void> start() async {
    if (await _recorder.isRecording()) return;
    if (!await _recorder.hasPermission()) {
      throw Exception(
        'Microphone permission denied. Enable it in your OS / app settings.',
      );
    }
    final dir = await getTemporaryDirectory();
    final path = p.join(
      dir.path,
      'vh_dictation_${DateTime.now().millisecondsSinceEpoch}.wav',
    );
    await _recorder.start(
      const RecordConfig(
        encoder: AudioEncoder.wav,
        // 16 kHz mono is the standard input rate for STT pipelines and
        // keeps the upload payload modest (≈ 30 KB / second).
        sampleRate: 16000,
        numChannels: 1,
        bitRate: 128000,
      ),
      path: path,
    );
    _activePath = path;
    _startedAt = DateTime.now();
  }

  /// Stop recording, upload to backend, and return the transcript text.
  /// Throws on upload / transcription failure.
  ///
  /// Optional patient context (passed in from the bed-sheet quick-action
  /// flow) hits the same query params the backend supports so the saved
  /// voice note ties back to the patient automatically.
  static Future<String> stopAndTranscribe({
    String? patientUid,
    int? admissionId,
    String? language,
  }) async {
    if (!await _recorder.isRecording()) {
      throw Exception('No active recording.');
    }
    final path = await _recorder.stop();
    final filePath = path ?? _activePath;
    _activePath = null;
    _startedAt = null;
    if (filePath == null) {
      throw Exception('Recording stopped without a file path.');
    }
    final file = File(filePath);
    if (!await file.exists()) {
      throw Exception('Recorded file missing: $filePath');
    }

    try {
      return await _upload(
        file: file,
        patientUid: patientUid,
        admissionId: admissionId,
        language: language,
      );
    } finally {
      // Best-effort temp-file cleanup. Failures here are noise.
      try {
        await file.delete();
      } catch (_) {}
    }
  }

  /// Discard the in-flight recording without uploading.
  static Future<void> cancel() async {
    try {
      if (await _recorder.isRecording()) {
        final path = await _recorder.stop();
        if (path != null) {
          try {
            await File(path).delete();
          } catch (_) {}
        }
      }
    } catch (e) {
      if (kDebugMode) {
        debugPrint('VoiceDictationService.cancel error: $e');
      }
    } finally {
      _activePath = null;
      _startedAt = null;
    }
  }

  static Future<String> _upload({
    required File file,
    String? patientUid,
    int? admissionId,
    String? language,
  }) async {
    final headers = await core.ApiConfig.authenticatedAuthHeaders();
    final uri =
        Uri.parse('${core.ApiConfig.baseUrl}/clinical/voice-note/transcribe');
    final request = http.MultipartRequest('POST', uri)
      ..headers.addAll(headers);
    if (patientUid != null && patientUid.isNotEmpty) {
      request.fields['patient_uid'] = patientUid;
    }
    if (admissionId != null) {
      request.fields['admission_id'] = admissionId.toString();
    }
    if (language != null && language.isNotEmpty) {
      request.fields['language'] = language;
    }
    request.files.add(await http.MultipartFile.fromPath('audio', file.path));

    final streamed = await request.send();
    final body = await streamed.stream.bytesToString();
    if (streamed.statusCode < 200 || streamed.statusCode >= 300) {
      throw Exception('Transcription failed (HTTP ${streamed.statusCode})');
    }

    final decoded = jsonDecode(body);
    if (decoded is! Map<String, dynamic>) {
      throw Exception('Unexpected transcription response shape.');
    }
    final data = decoded['data'];
    if (data is! Map) {
      throw Exception('Transcription response missing data.');
    }
    final status = data['transcript_status'];
    final transcript = data['transcript'];
    if (status != null && status != 'completed') {
      throw Exception('Transcription not completed (status: $status).');
    }
    if (transcript is! String || transcript.trim().isEmpty) {
      throw Exception('Transcript was empty.');
    }
    return transcript.trim();
  }
}
