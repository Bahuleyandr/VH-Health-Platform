import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';
import 'package:vhhealth_core/services/http_client.dart';

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
    await _assertCaptureAllowed();
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

  static Future<void> _assertCaptureAllowed() async {
    // Routed through the shared, cert-pinned VHHttpClient (audit finding #14):
    // this is a policy check about an identified patient's clinical dictation,
    // so it must inherit the SPKI pin / shared auth rather than using a bare
    // http.get over a non-pinned client.
    final response = await VHHttpClient.get('/clinical/voice-note/config');
    if (!response.isSuccess) {
      throw Exception('Voice dictation policy check failed.');
    }

    if (response.raw is! Map<String, dynamic>) {
      throw Exception('Unexpected voice dictation policy response.');
    }
    final data = response.data;
    if (data is! Map<String, dynamic>) {
      throw Exception('Voice dictation policy response missing data.');
    }
    if (data['configured'] == false) {
      final reason = data['reason']?.toString();
      throw Exception(
        reason == null || reason.isEmpty
            ? 'Voice dictation is not configured.'
            : 'Voice dictation is not configured: $reason',
      );
    }

    final voiceNote = data['voice_note'];
    if (voiceNote is Map<String, dynamic>) {
      final allowed = voiceNote['audio_capture_allowed'] == true;
      if (!allowed) {
        final reason = voiceNote['blocking_reason']?.toString();
        throw Exception(
          reason == null || reason.isEmpty
              ? 'Voice dictation is disabled for this tenant.'
              : 'Voice dictation is disabled for this tenant: $reason',
        );
      }
    }
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
    // Routed through the shared, cert-pinned VHHttpClient (audit finding #14):
    // clinical dictation audio about an identified patient must inherit the
    // SPKI pin + shared auth rather than uploading over a bare, non-pinned
    // multipart client. VHHttpClient injects the auth headers itself, so we no
    // longer build/attach them here. A fileBuilder (rather than a pre-built
    // file) is used so the shared client can re-read the audio on a 401-retry —
    // a MultipartFile stream is single-use.
    final fields = <String, String>{
      if (patientUid != null && patientUid.isNotEmpty)
        'patient_uid': patientUid,
      if (admissionId != null) 'admission_id': admissionId.toString(),
      if (language != null && language.isNotEmpty) 'language': language,
    };
    final response = await VHHttpClient.multipart(
      '/clinical/voice-note/transcribe',
      fields: fields,
      fileBuilder: () async => [
        await http.MultipartFile.fromPath('audio', file.path),
      ],
    );
    if (!response.isSuccess) {
      throw Exception('Transcription failed (HTTP ${response.statusCode})');
    }

    if (response.raw is! Map<String, dynamic>) {
      throw Exception('Unexpected transcription response shape.');
    }
    final data = response.data;
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
