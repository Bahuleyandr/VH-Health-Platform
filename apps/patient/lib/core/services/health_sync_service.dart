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

  static List<HealthDataType> get _readTypes => [
    HealthDataType.HEART_RATE,
    HealthDataType.BLOOD_OXYGEN,
    HealthDataType.STEPS,
    HealthDataType.WEIGHT,
    HealthDataType.BODY_TEMPERATURE,
    HealthDataType.SLEEP_ASLEEP,
    HealthDataType.SLEEP_LIGHT,
    HealthDataType.SLEEP_DEEP,
    HealthDataType.SLEEP_REM,
    HealthDataType.ACTIVE_ENERGY_BURNED,
    if (Platform.isIOS)
      HealthDataType.DISTANCE_WALKING_RUNNING
    else
      HealthDataType.DISTANCE_DELTA,
  ];

  /// Subset of [_readTypes] we also write back to HealthKit / Health Connect
  /// after the user records them manually in-app. Kept narrower than [_readTypes]
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

  static bool get _isSupportedPlatform => Platform.isIOS || Platform.isAndroid;

  String get _sourceTag => Platform.isIOS ? 'healthkit' : 'health_connect';

  /// Request read permissions for all six tracked types. Call from an
  /// explicit user action (the Settings tile) — not from background code.
  Future<bool> requestPermissions() async {
    if (!_isSupportedPlatform) return false;
    await _health.configure();
    final types = _availableReadTypes();
    if (types.isEmpty) return false;
    final permissions = List<HealthDataAccess>.filled(
      types.length,
      HealthDataAccess.READ,
    );
    final granted = await _health.requestAuthorization(
      types,
      permissions: permissions,
    );
    _permissionsGranted = granted;
    return granted;
  }

  /// Check whether HealthKit / Health Connect read permissions are already
  /// available without opening the OS permission sheet.
  Future<bool> hasReadPermissions() async {
    if (!_isSupportedPlatform) return false;
    await _health.configure();
    final types = _availableReadTypes();
    if (types.isEmpty) return false;
    final has = await _health.hasPermissions(types) ?? false;
    _permissionsGranted = has;
    return has;
  }

  /// Request WRITE permissions for the vitals we push back after manual entry.
  /// Separate from [requestPermissions] so the read-only sync flow keeps a
  /// narrow permission surface. Call from the vitals-entry screen just before
  /// the user saves — iOS surfaces a single combined HealthKit sheet either way.
  Future<bool> requestWritePermissions() async {
    if (!_isSupportedPlatform) return false;
    await _health.configure();
    final permissions = List<HealthDataAccess>.filled(
      _writableTypes.length,
      HealthDataAccess.READ_WRITE,
    );
    final granted = await _health.requestAuthorization(
      _writableTypes,
      permissions: permissions,
    );
    _writePermissionsGranted = granted;
    return granted;
  }

  /// Schedule a 30-min foreground sync tick and run one immediately.
  Future<void> startForegroundSync() async {
    if (!_isSupportedPlatform) return;
    _periodicTimer?.cancel();
    _periodicTimer = Timer.periodic(_foregroundInterval, (_) => syncNow());
    await syncNow();
  }

  void stopForegroundSync() {
    _periodicTimer?.cancel();
    _periodicTimer = null;
  }

  /// Perform a one-shot sync. Returns the number of backend surfaces updated.
  ///
  /// Silent path — does **not** prompt for permissions. Background/resume
  /// callers rely on this behaviour to avoid spurious prompts.
  Future<int> syncNow() async {
    if (!_isSupportedPlatform) return 0;
    final types = _availableReadTypes();
    if (types.isEmpty) return 0;
    if (!_permissionsGranted) {
      await _health.configure();
      final has = await _health.hasPermissions(types) ?? false;
      if (!has) return 0;
      _permissionsGranted = true;
    }

    final prefs = await SharedPreferences.getInstance();
    final sourceKey = '$_prefsLastSyncPrefix$_sourceTag';
    final lastIso = prefs.getString(sourceKey);
    final end = DateTime.now();
    final todayStart = DateTime(end.year, end.month, end.day);
    final start = lastIso == null
        ? todayStart.subtract(const Duration(days: 7))
        : todayStart.subtract(const Duration(days: 1));
    if (!end.isAfter(start)) return 0;

    final List<HealthDataPoint> points;
    try {
      points = await _health.getHealthDataFromTypes(
        types: types,
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
    DateTime? latestHeartRateAt;
    DateTime? latestSpo2At;
    DateTime? latestWeightAt;
    DateTime? latestTemperatureAt;
    String? sourceApp;
    String? sourceDevice;
    final daily = <String, _DailyActivitySummary>{};

    for (final p in points) {
      if (sourceApp == null && p.sourceName.trim().isNotEmpty) {
        sourceApp = p.sourceName.trim();
      }
      if (sourceDevice == null && p.sourceDeviceId.trim().isNotEmpty) {
        sourceDevice = p.sourceDeviceId.trim();
      }
      final day = _dayKey(_isSleepType(p.type) ? p.dateTo : p.dateFrom);
      final summary = daily.putIfAbsent(
        day,
        () => _DailyActivitySummary(date: day),
      );
      if (_isSleepType(p.type)) {
        final minutes = p.dateTo.difference(p.dateFrom).inMinutes;
        if (minutes > 0) {
          summary.sleepMinutes += minutes;
          summary.trackLatest(p.dateTo);
        }
        if (latestSampleAt == null || p.dateTo.isAfter(latestSampleAt)) {
          latestSampleAt = p.dateTo;
        }
        continue;
      }

      final v = _numeric(p.value);
      if (v == null) continue;
      switch (p.type) {
        case HealthDataType.HEART_RATE:
          if (latestHeartRateAt == null ||
              p.dateFrom.isAfter(latestHeartRateAt)) {
            heartRate = v;
            latestHeartRateAt = p.dateFrom;
          }
          break;
        case HealthDataType.BLOOD_OXYGEN:
          final pct = v <= 1.0 ? v * 100 : v;
          if (latestSpo2At == null || p.dateFrom.isAfter(latestSpo2At)) {
            spo2 = pct;
            latestSpo2At = p.dateFrom;
          }
          break;
        case HealthDataType.STEPS:
          steps += v;
          summary.steps += v.round();
          summary.trackLatest(p.dateTo);
          break;
        case HealthDataType.DISTANCE_DELTA:
        case HealthDataType.DISTANCE_WALKING_RUNNING:
          summary.distanceMeters += v;
          summary.trackLatest(p.dateTo);
          break;
        case HealthDataType.ACTIVE_ENERGY_BURNED:
          summary.activeEnergyKcal += v;
          summary.trackLatest(p.dateTo);
          break;
        case HealthDataType.WEIGHT:
          if (latestWeightAt == null || p.dateFrom.isAfter(latestWeightAt)) {
            weight = v;
            latestWeightAt = p.dateFrom;
          }
          break;
        case HealthDataType.BODY_TEMPERATURE:
          if (latestTemperatureAt == null ||
              p.dateFrom.isAfter(latestTemperatureAt)) {
            temperature = v;
            latestTemperatureAt = p.dateFrom;
          }
          break;
        default:
          break;
      }
      if (latestSampleAt == null || p.dateTo.isAfter(latestSampleAt)) {
        latestSampleAt = p.dateTo;
      }
    }

    var updatedSurfaces = 0;

    final body = <String, dynamic>{
      if (heartRate != null) 'heartRate': heartRate.round(),
      if (spo2 != null) 'spO2': spo2.round(),
      'weight': ?weight,
      'temperature': ?temperature,
      'source': _sourceTag,
      'recordedAtSource': (latestSampleAt ?? end).toIso8601String(),
    };

    if (heartRate != null ||
        spo2 != null ||
        weight != null ||
        temperature != null) {
      try {
        final resp = await ApiClient.post('/health/patient/vitals', body: body);
        if (resp.isSuccess) {
          updatedSurfaces += 1;
        } else if (kDebugMode) {
          debugPrint(
            'HealthSyncService: vitals POST failed ${resp.statusCode}',
          );
        }
      } catch (e) {
        if (kDebugMode) debugPrint('HealthSyncService: vitals POST error $e');
      }
    }

    final days = daily.values.where((d) => d.hasActivity).toList()
      ..sort((a, b) => a.date.compareTo(b.date));
    if (days.isNotEmpty) {
      try {
        final resp = await ApiClient.post(
          '/steps/health-sync',
          body: {
            'source': _sourceTag,
            'sourceApp': sourceApp,
            'sourceDevice': sourceDevice,
            'days': days.map((d) => d.toJson()).toList(),
          },
        );
        if (resp.isSuccess) {
          updatedSurfaces += 1;
        } else if (kDebugMode) {
          debugPrint(
            'HealthSyncService: activity POST failed ${resp.statusCode}',
          );
        }
      } catch (e) {
        if (kDebugMode) debugPrint('HealthSyncService: activity POST error $e');
      }
    }

    await prefs.setString(sourceKey, (latestSampleAt ?? end).toIso8601String());
    if (kDebugMode) {
      debugPrint(
        'HealthSyncService: synced ${points.length} points, steps=$steps, days=${days.length}, surfaces=$updatedSurfaces',
      );
    }
    return updatedSurfaces;
  }

  double? _numeric(HealthValue v) {
    if (v is NumericHealthValue) return v.numericValue.toDouble();
    return null;
  }

  List<HealthDataType> _availableReadTypes() =>
      _readTypes.where(_health.isDataTypeAvailable).toList();

  bool _isSleepType(HealthDataType type) =>
      type == HealthDataType.SLEEP_ASLEEP ||
      type == HealthDataType.SLEEP_LIGHT ||
      type == HealthDataType.SLEEP_DEEP ||
      type == HealthDataType.SLEEP_REM;

  String _dayKey(DateTime value) {
    final local = value.toLocal();
    return DateTime(
      local.year,
      local.month,
      local.day,
    ).toIso8601String().split('T').first;
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
    if (!_isSupportedPlatform) return;
    if (!_writePermissionsGranted) {
      if (_writePermissionsAsked) {
        return; // user previously declined this session
      }
      await _health.configure();
      final permissions = List<HealthDataAccess>.filled(
        _writableTypes.length,
        HealthDataAccess.READ_WRITE,
      );
      final has =
          await _health.hasPermissions(
            _writableTypes,
            permissions: permissions,
          ) ??
          false;
      if (has) {
        _writePermissionsGranted = true;
      } else {
        // First write of the session with no prior grant — prompt now so the
        // mirror actually lands. After one decline, further saves in this
        // session silently no-op (see [_writePermissionsAsked]).
        _writePermissionsAsked = true;
        final granted = await _health.requestAuthorization(
          _writableTypes,
          permissions: permissions,
        );
        _writePermissionsGranted = granted;
        if (!granted) return;
      }
    }

    final at = recordedAt ?? DateTime.now();
    final writes = <Future<bool>>[];

    if (heartRate != null) {
      writes.add(
        _health.writeHealthData(
          value: heartRate.toDouble(),
          type: HealthDataType.HEART_RATE,
          startTime: at,
        ),
      );
    }
    if (spO2 != null) {
      writes.add(
        _health.writeHealthData(
          value: spO2 / 100.0,
          type: HealthDataType.BLOOD_OXYGEN,
          startTime: at,
        ),
      );
    }
    if (weight != null) {
      writes.add(
        _health.writeHealthData(
          value: weight,
          type: HealthDataType.WEIGHT,
          startTime: at,
        ),
      );
    }
    if (temperature != null) {
      writes.add(
        _health.writeHealthData(
          value: temperature,
          type: HealthDataType.BODY_TEMPERATURE,
          startTime: at,
        ),
      );
    }
    if (bloodGlucose != null) {
      writes.add(
        _health.writeHealthData(
          value: bloodGlucose.toDouble(),
          type: HealthDataType.BLOOD_GLUCOSE,
          startTime: at,
        ),
      );
    }
    if (systolic != null && diastolic != null) {
      writes.add(
        _health.writeBloodPressure(
          systolic: systolic,
          diastolic: diastolic,
          startTime: at,
        ),
      );
    }

    try {
      final results = await Future.wait(writes);
      final ok = results.where((r) => r).length;
      if (kDebugMode) {
        debugPrint(
          'HealthSyncService.writeVitalsToHealthStore: $ok/${results.length} writes succeeded',
        );
      }
    } catch (e) {
      if (kDebugMode) {
        debugPrint('HealthSyncService.writeVitalsToHealthStore failed: $e');
      }
    }
  }

  // ── Background sync (workmanager) ─────────────────────────────────────────

  /// Register the periodic background task. Safe to call multiple times —
  /// [ExistingWorkPolicy.keep] means subsequent calls are no-ops.
  ///
  /// Must be called after permissions are granted — scheduling succeeds either
  /// way, but the background isolate will read zero samples without permission.
  static Future<void> enableBackgroundSync() async {
    if (!_isSupportedPlatform) return;
    await Workmanager().initialize(healthSyncBackgroundDispatcher);
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
    if (!_isSupportedPlatform) return;
    await Workmanager().cancelByUniqueName(backgroundTaskName);
  }
}

class _DailyActivitySummary {
  final String date;
  int steps = 0;
  double distanceMeters = 0;
  int sleepMinutes = 0;
  double activeEnergyKcal = 0;
  DateTime? lastSampleAt;

  _DailyActivitySummary({required this.date});

  bool get hasActivity =>
      steps > 0 ||
      distanceMeters > 0 ||
      sleepMinutes > 0 ||
      activeEnergyKcal > 0;

  void trackLatest(DateTime value) {
    if (lastSampleAt == null || value.isAfter(lastSampleAt!)) {
      lastSampleAt = value;
    }
  }

  Map<String, dynamic> toJson() => {
    'date': date,
    'steps': steps,
    'distanceMeters': distanceMeters,
    'sleepMinutes': sleepMinutes,
    'activeEnergyKcal': activeEnergyKcal,
    if (lastSampleAt != null) 'lastSampleAt': lastSampleAt!.toIso8601String(),
  };
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
