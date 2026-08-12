import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:vhhealth_core/services/secure_storage.dart';

class WalkSessionCheckpoint {
  const WalkSessionCheckpoint({
    required this.sessionId,
    required this.steps,
    required this.distanceMeters,
    required this.durationSeconds,
    required this.savedAt,
  });

  final int sessionId;
  final int steps;
  final double distanceMeters;
  final int durationSeconds;
  final DateTime savedAt;

  Map<String, dynamic> toJson() => {
    'sessionId': sessionId,
    'steps': steps,
    'distanceMeters': distanceMeters,
    'durationSeconds': durationSeconds,
    'savedAt': savedAt.toUtc().toIso8601String(),
  };

  factory WalkSessionCheckpoint.fromJson(Map<String, dynamic> json) {
    final sessionId = (json['sessionId'] as num?)?.toInt();
    final steps = (json['steps'] as num?)?.toInt();
    final distanceMeters = (json['distanceMeters'] as num?)?.toDouble();
    final durationSeconds = (json['durationSeconds'] as num?)?.toInt();
    final savedAt = DateTime.tryParse(json['savedAt']?.toString() ?? '');
    if (sessionId == null ||
        sessionId <= 0 ||
        steps == null ||
        steps < 0 ||
        distanceMeters == null ||
        distanceMeters < 0 ||
        durationSeconds == null ||
        durationSeconds < 0 ||
        savedAt == null) {
      throw const FormatException('Invalid walk session checkpoint');
    }
    return WalkSessionCheckpoint(
      sessionId: sessionId,
      steps: steps,
      distanceMeters: distanceMeters,
      durationSeconds: durationSeconds,
      savedAt: savedAt,
    );
  }
}

class WalkSessionCheckpointStore {
  WalkSessionCheckpointStore({FlutterSecureStorage? storage})
    : _storage = storage ?? VHSecureStorage.instance;

  static const storageKey = 'patient_active_walk_checkpoint_v1';
  final FlutterSecureStorage _storage;

  Future<void> save(WalkSessionCheckpoint checkpoint) =>
      _storage.write(key: storageKey, value: jsonEncode(checkpoint.toJson()));

  Future<WalkSessionCheckpoint?> read() async {
    final raw = await _storage.read(key: storageKey);
    if (raw == null || raw.isEmpty) return null;
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map<String, dynamic>) {
        throw const FormatException('Invalid walk session checkpoint');
      }
      return WalkSessionCheckpoint.fromJson(decoded);
    } on FormatException {
      await clear();
      return null;
    }
  }

  Future<void> clear() => _storage.delete(key: storageKey);
}
