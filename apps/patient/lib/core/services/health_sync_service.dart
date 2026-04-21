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

  /// Subset of [_types] we also write back to HealthKit / Health Connect after
  /// the user records them manually in-app. Kept narrower than [_types]
  /// because some types (STEPS, SLEEP_ASLEEP) are passively sensor-derived
  /// and writing them from the app would create duplicate or fake entries.
  static const List<HealthDataType> _writableTypes = [
    HealthDataType.HEART_RATE,
    HealthDataType.BLOOD_OXYGEN,
    HealthDataType.WEIGHT,
    HealthDataType.BODY_TEMPERATURE,
    HealthDataType.BLOOD_PRESSURE_SYSTOLIC,
    HealthDataType.BLOOD_PRESSURE_DIASTOLIC,
    HealthDataType.BLOOD_GLUCOSE,
  ];

  final Health _health = Health();
  Timer? _periodicTimer;
  bool _permissionsGranted = false;
  bool _writePermissionsGranted = false;
  // True once we've surfaced the write-permission sheet to the user this
  // session. Once the user declines, don't re-prompt until the next launch
  // (OS will suppress re-prompts anyway, but this avoids the channel round-trip).
  bool _writePermissionsAsked = false;

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

  /// Request WRITE permissions for the vitals we push back after manual entry.
  /// Separate from [requestPermissions] so the read-only sync flow keeps a
  /// narrow permission surface. Call from the vitals-entry screen just before
  /// the user saves — iOS surfaces a single combined HealthKit sheet either way.
  Future<bool> requestWritePermissions() async {
    await _health.configure();
    final permissions =
        List<HealthDataAccess>.filled(_writableTypes.length, HealthDataAccess.READ_WRITE);
    final granted =
        await _health.requestAuthorization(_writableTypes, permissions: permissions);
    _writePermissionsGranted = granted;
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
      'weight': ?weight,
      'temperature': ?temperature,
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

  // ── Write-back: push manually-recorded vitals into HealthKit / Health Connect ───

  /// Write the vitals the user just recorded back into the system health store
  /// so they show up in Apple Health / Google Health Connect alongside readings
  /// from wearables. Fire-and-forget: all errors are swallowed + logged in
  /// debug builds. Missing values are skipped.
  ///
  /// Call from the vitals save path (and from the medication-intake handler,
  /// once medication tracking lands) AFTER the backend POST succeeds — the
  /// backend is the source of truth; HealthKit mirror is a convenience for
  /// cross-app visibility.
  Future<void> writeVitalsToHealthStore({
    int? heartRate,
    int? spO2,
    double? weight,
    double? temperature,
    int? systolic,
    int? diastolic,
    int? bloodGlucose,
    DateTime? recordedAt,
  }) async {
    if (!_writePermissionsGranted) {
      if (_writePermissionsAsked) return; // user previously declined this session
      await _health.configure();
      final permissions =
          List<HealthDataAccess>.filled(_writableTypes.length, HealthDataAccess.READ_WRITE);
      final has = await _health.hasPermissions(_writableTypes, permissions: permissions) ?? false;
      if (has) {
        _writePermissionsGranted = true;
      } else {
        // First write of the session with no prior grant — prompt now so the
        // mirror actually lands. After one decline, further saves in this
        // session silently no-op (see [_writePermissionsAsked]).
        _writePermissionsAsked = true;
        final granted =
            await _health.requestAuthorization(_writableTypes, permissions: permissions);
        _writePermissionsGranted = granted;
        if (!granted) return;
      }
    }

    final at = recordedAt ?? DateTime.now();
    final writes = <Future<bool>>[];

    if (heartRate != null) {
      writes.add(_health.writeHealthData(
        value: heartRate.toDouble(),
        type: HealthDataType.HEART_RATE,
        startTime: at,
      ));
    }
    if (spO2 != null) {
      writes.add(_health.writeHealthData(
        value: spO2 / 100.0,
        type: HealthDataType.BLOOD_OXYGEN,
        startTime: at,
      ));
    }
    if (weight != null) {
      writes.add(_health.writeHealthData(
        value: weight,
        type: HealthDataType.WEIGHT,
        startTime: at,
      ));
    }
    if (temperature != null) {
      writes.add(_health.writeHealthData(
        value: temperature,
        type: HealthDataType.BODY_TEMPERATURE,
        startTime: at,
      ));
    }
    if (bloodGlucose != null) {
      writes.add(_health.writeHealthData(
        value: bloodGlucose.toDouble(),
        type: HealthDataType.BLOOD_GLUCOSE,
        startTime: at,
      ));
    }
    if (systolic != null && diastolic != null) {
      writes.add(_health.writeBloodPressure(
        systolic: systolic,
        diastolic: diastolic,
        startTime: at,
      ));
    }

    try {
      final results = await Future.wait(writes);
      final ok = results.where((r) => r).length;
      if (kDebugMode) {
        debugPrint('HealthSyncService.writeVitalsToHealthStore: $ok/${results.length} writes succeeded');
      }
    } catch (e) {
      if (kDebugMode) debugPrint('HealthSyncService.writeVitalsToHealthStore failed: $e');
    }
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
