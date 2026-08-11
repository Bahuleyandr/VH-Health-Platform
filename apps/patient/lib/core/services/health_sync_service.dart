import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:health/health.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vhhealth/core/outage/patient_outage_controller.dart';
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

  static const String _prefsLastVitalsSyncPrefix = 'health_sync_last_vitals_';
  static const String _prefsLastActivitySyncPrefix =
      'health_sync_last_activity_';
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

  static List<HealthDataType> get _activityReadTypes => [
    HealthDataType.STEPS,
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
  Future<int>? _syncInFlight;
  bool _lastSyncSucceeded = true;
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
    return _requestReadPermissions(_readTypes);
  }

  /// Request only activity-related reads for the Home steps card. This keeps
  /// the first wearable prompt focused on steps instead of asking for every
  /// vitals permission at once.
  Future<bool> requestActivityPermissions() async {
    return _requestReadPermissions(_activityReadTypes);
  }

  Future<bool> _requestReadPermissions(
    List<HealthDataType> requestedTypes,
  ) async {
    if (!_isSupportedPlatform) return false;
    await _health.configure();
    final ready = await _ensureAndroidPermissionPrerequisites();
    if (!ready) return false;

    final types = _availableTypes(requestedTypes);
    if (types.isEmpty) return false;
    final permissions = List<HealthDataAccess>.filled(
      types.length,
      HealthDataAccess.READ,
    );
    final granted = await _health.requestAuthorization(
      types,
      permissions: permissions,
    );
    _permissionsGranted = granted && _isFullReadSet(types);
    return granted;
  }

  /// Check whether HealthKit / Health Connect read permissions are already
  /// available without opening the OS permission sheet.
  Future<bool> hasReadPermissions() async {
    return _hasReadPermissions(_readTypes);
  }

  Future<bool> hasActivityReadPermissions() async {
    return _hasReadPermissions(_activityReadTypes);
  }

  Future<bool> _hasReadPermissions(List<HealthDataType> requestedTypes) async {
    if (!_isSupportedPlatform) return false;
    await _health.configure();
    final types = _availableTypes(requestedTypes);
    if (types.isEmpty) return false;

    if (Platform.isAndroid && _containsStepData(types)) {
      final activity = await Permission.activityRecognition.status;
      if (!activity.isGranted) return false;
    }

    final has = await _health.hasPermissions(types) ?? false;
    _permissionsGranted = has && _isFullReadSet(types);
    return has;
  }

  /// Health Connect can sync while the app is backgrounded only when Android
  /// grants this extra permission. We keep it separate from the main read
  /// permission so a denial does not block foreground/manual syncing.
  Future<bool> requestBackgroundReadPermissionIfAvailable() async {
    if (!_isSupportedPlatform) return false;
    if (Platform.isIOS) return true;

    await _health.configure();
    try {
      final status = await _health.getHealthConnectSdkStatus();
      if (status != HealthConnectSdkStatus.sdkAvailable) return false;

      final available = await _health.isHealthDataInBackgroundAvailable();
      if (!available) return false;

      final alreadyGranted = await _health.isHealthDataInBackgroundAuthorized();
      if (alreadyGranted) return true;

      return _health.requestHealthDataInBackgroundAuthorization();
    } catch (e) {
      if (kDebugMode) {
        debugPrint('HealthSyncService: background permission failed: $e');
      }
      return false;
    }
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
  Future<int> syncNow() {
    final pendingSync = _syncInFlight;
    if (pendingSync != null) return pendingSync;

    final sync = _runSync();
    _syncInFlight = sync;
    return sync;
  }

  Future<int> _runSync() async {
    try {
      return await _performSync();
    } finally {
      _syncInFlight = null;
    }
  }

  Future<int> _performSync() async {
    _lastSyncSucceeded = true;
    if (PatientOutageController.instance.blocksHospitalMutations) {
      _lastSyncSucceeded = false;
      return 0;
    }
    if (!_isSupportedPlatform) return 0;
    var types = _availableReadTypes();
    if (types.isEmpty) return 0;
    if (!_permissionsGranted) {
      await _health.configure();
      if (Platform.isAndroid) {
        types = await _grantedReadTypes(types);
        if (types.isEmpty) return 0;
      } else {
        final has = await _health.hasPermissions(types) ?? false;
        if (!has) return 0;
        _permissionsGranted = true;
      }
    }

    final prefs = await SharedPreferences.getInstance();
    final vitalsKey = '$_prefsLastVitalsSyncPrefix$_sourceTag';
    final activityKey = '$_prefsLastActivitySyncPrefix$_sourceTag';
    final end = DateTime.now();
    final todayStart = DateTime(end.year, end.month, end.day);
    final initialStart = todayStart.subtract(const Duration(days: 7));
    // The legacy shared checkpoint advanced after partial failures, so it is
    // deliberately not migrated; the first run safely replays seven days.
    final vitalsCursor = _readCursor(prefs.getString(vitalsKey), end);
    final activityCursor = _readCursor(prefs.getString(activityKey), end);
    final candidateVitalsStart = vitalsCursor?.add(
      const Duration(microseconds: 1),
    );
    final vitalsStart =
        candidateVitalsStart == null ||
            candidateVitalsStart.isBefore(initialStart)
        ? initialStart
        : candidateVitalsStart;
    final activityStart = activityCursor == null
        ? initialStart
        : todayStart.subtract(const Duration(days: 1));
    final start = vitalsStart.isBefore(activityStart)
        ? vitalsStart
        : activityStart;
    if (!end.isAfter(start)) return 0;

    final List<HealthDataPoint> points;
    try {
      points = await _health.getHealthDataFromTypes(
        types: types,
        startTime: start,
        endTime: end,
      );
    } catch (e) {
      _lastSyncSucceeded = false;
      if (kDebugMode) debugPrint('HealthSyncService: read failed: $e');
      return 0;
    }
    if (points.isEmpty) return 0;

    double? heartRate;
    double? spo2;
    double? weight;
    double? temperature;
    double steps = 0;
    DateTime? latestVitalSampleAt;
    DateTime? latestActivitySampleAt;
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
      if (_isSleepType(p.type)) {
        if (p.dateTo.isBefore(activityStart)) continue;
        final day = _dayKey(p.dateTo);
        final summary = daily.putIfAbsent(
          day,
          () => _DailyActivitySummary(date: day),
        );
        final minutes = p.dateTo.difference(p.dateFrom).inMinutes;
        if (minutes > 0) {
          summary.sleepMinutes += minutes;
          summary.trackLatest(p.dateTo);
        }
        latestActivitySampleAt = _laterOf(latestActivitySampleAt, p.dateTo);
        continue;
      }

      final v = _numeric(p.value);
      if (v == null) continue;
      switch (p.type) {
        case HealthDataType.HEART_RATE:
          if (!_isAfterCursor(p.dateTo, vitalsCursor)) break;
          if (latestHeartRateAt == null ||
              p.dateFrom.isAfter(latestHeartRateAt)) {
            heartRate = v;
            latestHeartRateAt = p.dateFrom;
          }
          latestVitalSampleAt = _laterOf(latestVitalSampleAt, p.dateTo);
          break;
        case HealthDataType.BLOOD_OXYGEN:
          if (!_isAfterCursor(p.dateTo, vitalsCursor)) break;
          final pct = v <= 1.0 ? v * 100 : v;
          if (latestSpo2At == null || p.dateFrom.isAfter(latestSpo2At)) {
            spo2 = pct;
            latestSpo2At = p.dateFrom;
          }
          latestVitalSampleAt = _laterOf(latestVitalSampleAt, p.dateTo);
          break;
        case HealthDataType.STEPS:
          if (p.dateTo.isBefore(activityStart)) break;
          final day = _dayKey(p.dateFrom);
          final summary = daily.putIfAbsent(
            day,
            () => _DailyActivitySummary(date: day),
          );
          steps += v;
          summary.steps += v.round();
          summary.trackLatest(p.dateTo);
          latestActivitySampleAt = _laterOf(latestActivitySampleAt, p.dateTo);
          break;
        case HealthDataType.DISTANCE_DELTA:
        case HealthDataType.DISTANCE_WALKING_RUNNING:
          if (p.dateTo.isBefore(activityStart)) break;
          final day = _dayKey(p.dateFrom);
          final summary = daily.putIfAbsent(
            day,
            () => _DailyActivitySummary(date: day),
          );
          summary.distanceMeters += v;
          summary.trackLatest(p.dateTo);
          latestActivitySampleAt = _laterOf(latestActivitySampleAt, p.dateTo);
          break;
        case HealthDataType.ACTIVE_ENERGY_BURNED:
          if (p.dateTo.isBefore(activityStart)) break;
          final day = _dayKey(p.dateFrom);
          final summary = daily.putIfAbsent(
            day,
            () => _DailyActivitySummary(date: day),
          );
          summary.activeEnergyKcal += v;
          summary.trackLatest(p.dateTo);
          latestActivitySampleAt = _laterOf(latestActivitySampleAt, p.dateTo);
          break;
        case HealthDataType.WEIGHT:
          if (!_isAfterCursor(p.dateTo, vitalsCursor)) break;
          if (latestWeightAt == null || p.dateFrom.isAfter(latestWeightAt)) {
            weight = v;
            latestWeightAt = p.dateFrom;
          }
          latestVitalSampleAt = _laterOf(latestVitalSampleAt, p.dateTo);
          break;
        case HealthDataType.BODY_TEMPERATURE:
          if (!_isAfterCursor(p.dateTo, vitalsCursor)) break;
          if (latestTemperatureAt == null ||
              p.dateFrom.isAfter(latestTemperatureAt)) {
            temperature = v;
            latestTemperatureAt = p.dateFrom;
          }
          latestVitalSampleAt = _laterOf(latestVitalSampleAt, p.dateTo);
          break;
        default:
          break;
      }
    }

    var updatedSurfaces = 0;

    final body = <String, dynamic>{
      if (heartRate != null) 'heartRate': heartRate.round(),
      if (spo2 != null) 'spO2': spo2.round(),
      'weight': ?weight,
      'temperature': ?temperature,
      'source': _sourceTag,
      if (latestVitalSampleAt != null)
        'recordedAtSource': latestVitalSampleAt.toIso8601String(),
    };

    if (heartRate != null ||
        spo2 != null ||
        weight != null ||
        temperature != null) {
      try {
        final resp = await ApiClient.post('/health/patient/vitals', body: body);
        if (resp.isSuccess) {
          updatedSurfaces += 1;
          await _saveCursor(prefs, vitalsKey, latestVitalSampleAt!);
        } else {
          _lastSyncSucceeded = false;
          if (kDebugMode) {
            debugPrint(
              'HealthSyncService: vitals POST failed ${resp.statusCode}',
            );
          }
        }
      } catch (e) {
        _lastSyncSucceeded = false;
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
          await _saveCursor(prefs, activityKey, latestActivitySampleAt!);
        } else {
          _lastSyncSucceeded = false;
          if (kDebugMode) {
            debugPrint(
              'HealthSyncService: activity POST failed ${resp.statusCode}',
            );
          }
        }
      } catch (e) {
        _lastSyncSucceeded = false;
        if (kDebugMode) debugPrint('HealthSyncService: activity POST error $e');
      }
    }

    if (kDebugMode) {
      debugPrint(
        'HealthSyncService: synced ${points.length} points, steps=$steps, days=${days.length}, surfaces=$updatedSurfaces',
      );
    }
    return updatedSurfaces;
  }

  DateTime? _readCursor(String? value, DateTime end) {
    final parsed = value == null ? null : DateTime.tryParse(value);
    if (parsed == null || parsed.isAfter(end)) return null;
    return parsed;
  }

  bool _isAfterCursor(DateTime sampleAt, DateTime? cursor) =>
      cursor == null || sampleAt.isAfter(cursor);

  DateTime _laterOf(DateTime? current, DateTime candidate) =>
      current == null || candidate.isAfter(current) ? candidate : current;

  Future<void> _saveCursor(
    SharedPreferences prefs,
    String key,
    DateTime value,
  ) async {
    if (!await prefs.setString(key, value.toIso8601String())) {
      _lastSyncSucceeded = false;
      if (kDebugMode) {
        debugPrint('HealthSyncService: failed to persist $key checkpoint');
      }
    }
  }

  double? _numeric(HealthValue v) {
    if (v is NumericHealthValue) return v.numericValue.toDouble();
    return null;
  }

  List<HealthDataType> _availableReadTypes() => _availableTypes(_readTypes);

  List<HealthDataType> _availableTypes(List<HealthDataType> types) =>
      types.where(_health.isDataTypeAvailable).toList();

  bool _isFullReadSet(List<HealthDataType> types) {
    final available = _availableReadTypes().toSet();
    return types.toSet().containsAll(available);
  }

  bool _containsStepData(List<HealthDataType> types) =>
      types.contains(HealthDataType.STEPS);

  Future<bool> _ensureAndroidPermissionPrerequisites() async {
    if (!Platform.isAndroid) return true;

    final status = await _health.getHealthConnectSdkStatus();
    if (status != HealthConnectSdkStatus.sdkAvailable) {
      await _health.installHealthConnect();
      return false;
    }

    final activity = await Permission.activityRecognition.status;
    if (activity.isGranted) return true;

    final requested = await Permission.activityRecognition.request();
    return requested.isGranted;
  }

  Future<List<HealthDataType>> _grantedReadTypes(
    List<HealthDataType> types,
  ) async {
    final canReadSteps =
        !types.contains(HealthDataType.STEPS) ||
        (await Permission.activityRecognition.status).isGranted;
    final granted = <HealthDataType>[];

    for (final type in types) {
      if (type == HealthDataType.STEPS && !canReadSteps) continue;
      try {
        final has =
            await _health.hasPermissions(
              [type],
              permissions: [HealthDataAccess.READ],
            ) ??
            false;
        if (has) granted.add(type);
      } catch (e) {
        if (kDebugMode) {
          debugPrint(
            'HealthSyncService: permission check failed for $type: $e',
          );
        }
      }
    }

    _permissionsGranted = granted.length == types.length;
    return granted;
  }

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
      final service = HealthSyncService.instance;
      await service.syncNow();
      return service._lastSyncSucceeded;
    } catch (e) {
      if (kDebugMode) debugPrint('healthSyncBackgroundDispatcher failed: $e');
      return false;
    }
  });
}
