import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:health/health.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:workmanager/workmanager.dart';

import 'api_client.dart';

/// Bridges Apple HealthKit / Google Health Connect (Fit successor) into the
/// VHHealth backend. Sync runs on three schedules:
///   1. User-triggered — the Settings tile calls [requestPermissions] + [syncNow].
///   2. App-resume — [main.dart] calls [syncNow] on `AppLifecycleState.resumed`.
///   3. Background — `workmanager` registers a 15-min periodic task that invokes
///      [healthSyncBackgroundDispatcher] (a top-level `@pragma('vm:entry-point')`
///      function) in a separate isolate. Enable via [enableBackgroundSync].
class HealthSyncService {
  HealthSyncService._();
  static final HealthSyncService instance = HealthSyncService._();

  static const String _prefsLastSyncPrefix = 'health_sync_last_';
  static const Duration _foregroundInterval = Duration(minutes: 30);
  static const String backgroundTaskName = 'vhhealth.health_sync';

  static const List<HealthDataType> _types = [
    HealthDataType.HEART_RATE,
    HealthDataType.BLOOD_OXYGEN,
    HealthDataType.STEPS,
    HealthDataType.WEIGHT,
    HealthDataType.BODY_TEMPERATURE,
    HealthDataType.SLEEP_ASLEEP,
  ];

  final Health _health = Health();
  Timer? _periodicTimer;
  bool _permissionsGranted = false;

  String get _sourceTag => Platform.isIOS ? 'healthkit' : 'google_fit';

  /// Request read permissions for all six tracked types. Call from an
  /// explicit user action (the Settings tile) — not from background code.
  Future<bool> requestPermissions() async {
    await _health.configure();
    final permissions = List<HealthDataAccess>.filled(_types.length, HealthDataAccess.READ);
    final granted = await _health.requestAuthorization(_types, permissions: permissions);
    _permissionsGranted = granted;
    return granted;
  }

  /// Schedule a 30-min foreground sync tick and run one immediately.
  Future<void> startForegroundSync() async {
    _periodicTimer?.cancel();
    _periodicTimer = Timer.periodic(_foregroundInterval, (_) => syncNow());
    await syncNow();
  }

  void stopForegroundSync() {
    _periodicTimer?.cancel();
    _periodicTimer = null;
  }

  /// Perform a one-shot sync. Returns 1 if vitals were posted, 0 otherwise.
  ///
  /// Silent path — does **not** prompt for permissions. Background/resume
  /// callers rely on this behaviour to avoid spurious prompts.
  Future<int> syncNow() async {
    if (!_permissionsGranted) {
      await _health.configure();
      final has = await _health.hasPermissions(_types) ?? false;
      if (!has) return 0;
      _permissionsGranted = true;
    }

    final prefs = await SharedPreferences.getInstance();
    final sourceKey = '$_prefsLastSyncPrefix$_sourceTag';
    final lastIso = prefs.getString(sourceKey);
    final start = lastIso != null
        ? DateTime.parse(lastIso)
        : DateTime.now().subtract(const Duration(days: 7));
    final end = DateTime.now();
    if (!end.isAfter(start)) return 0;

    final List<HealthDataPoint> points;
    try {
      points = await _health.getHealthDataFromTypes(
        types: _types,
        startTime: start,
        endTime: end,
      );
    } catch (e) {
      if (kDebugMode) debugPrint('HealthSyncService: read failed: $e');
      return 0;
    }
    if (points.isEmpty) {
      await prefs.setString(sourceKey, end.toIso8601String());
      return 0;
    }

    double? heartRate;
    double? spo2;
    double? weight;
    double? temperature;
    double steps = 0;
    DateTime? latestSampleAt;

    for (final p in points) {
      final v = _numeric(p.value);
      if (v == null) continue;
      switch (p.type) {
        case HealthDataType.HEART_RATE:
          if (latestSampleAt == null || p.dateFrom.isAfter(latestSampleAt)) {
            heartRate = v;
          }
          break;
        case HealthDataType.BLOOD_OXYGEN:
          final pct = v <= 1.0 ? v * 100 : v;
          if (spo2 == null || p.dateFrom.isAfter(latestSampleAt ?? start)) {
            spo2 = pct;
          }
          break;
        case HealthDataType.STEPS:
          steps += v;
          break;
        case HealthDataType.WEIGHT:
          weight = v;
          break;
        case HealthDataType.BODY_TEMPERATURE:
          temperature = v;
          break;
        default:
          break;
      }
      if (latestSampleAt == null || p.dateTo.isAfter(latestSampleAt)) {
        latestSampleAt = p.dateTo;
      }
    }

    if (heartRate == null && spo2 == null && weight == null && temperature == null) {
      await prefs.setString(sourceKey, (latestSampleAt ?? end).toIso8601String());
      return 0;
    }

    final body = <String, dynamic>{
      if (heartRate != null) 'heartRate': heartRate.round(),
      if (spo2 != null) 'spO2': spo2.round(),
      if (weight != null) 'weight': weight,
      if (temperature != null) 'temperature': temperature,
      'source': _sourceTag,
      'recordedAtSource': (latestSampleAt ?? end).toIso8601String(),
    };

    try {
      final resp = await ApiClient.post('/health/patient/vitals', body: body);
      if (!resp.isSuccess) {
        if (kDebugMode) debugPrint('HealthSyncService: POST failed ${resp.statusCode}');
        return 0;
      }
    } catch (e) {
      if (kDebugMode) debugPrint('HealthSyncService: POST error $e');
      return 0;
    }

    await prefs.setString(sourceKey, (latestSampleAt ?? end).toIso8601String());
    if (kDebugMode) debugPrint('HealthSyncService: synced ${points.length} points, steps=$steps');
    return 1;
  }

  double? _numeric(HealthValue v) {
    if (v is NumericHealthValue) return v.numericValue.toDouble();
    return null;
  }

  // ── Background sync (workmanager) ─────────────────────────────────────────

  /// Register the periodic background task. Safe to call multiple times —
  /// [ExistingWorkPolicy.keep] means subsequent calls are no-ops.
  ///
  /// Must be called after permissions are granted — scheduling succeeds either
  /// way, but the background isolate will read zero samples without permission.
  static Future<void> enableBackgroundSync() async {
    await Workmanager().initialize(
      healthSyncBackgroundDispatcher,
      isInDebugMode: kDebugMode,
    );
    await Workmanager().registerPeriodicTask(
      backgroundTaskName,
      backgroundTaskName,
      frequency: const Duration(minutes: 15),
      existingWorkPolicy: ExistingPeriodicWorkPolicy.keep,
      constraints: Constraints(
        networkType: NetworkType.connected,
        requiresBatteryNotLow: true,
      ),
    );
  }

  static Future<void> disableBackgroundSync() async {
    await Workmanager().cancelByUniqueName(backgroundTaskName);
  }
}

/// Top-level entry point invoked by workmanager in a background isolate. Must
/// be a top-level function so the Dart VM can locate it by symbol.
/// `@pragma('vm:entry-point')` prevents tree-shaking in release builds.
@pragma('vm:entry-point')
void healthSyncBackgroundDispatcher() {
  Workmanager().executeTask((task, inputData) async {
    try {
      await HealthSyncService.instance.syncNow();
    } catch (e) {
      if (kDebugMode) debugPrint('healthSyncBackgroundDispatcher failed: $e');
    }
    return true; // never error — retry is implicit via the next scheduled tick
  });
}
