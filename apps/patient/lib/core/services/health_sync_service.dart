import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform;

import 'package:cryptography/cryptography.dart';
import 'package:flutter/foundation.dart';
import 'package:health/health.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vhhealth/core/outage/patient_outage_controller.dart';
import 'package:workmanager/workmanager.dart';

import 'api_client.dart';

class HealthSyncRunResult {
  final int updatedSurfaces;
  final bool succeeded;

  const HealthSyncRunResult({
    required this.updatedSurfaces,
    required this.succeeded,
  });
}

class HealthSyncRunCoordinator {
  Future<HealthSyncRunResult>? _inFlight;

  Future<HealthSyncRunResult> run(
    Future<HealthSyncRunResult> Function() operation,
  ) {
    final pending = _inFlight;
    if (pending != null) return pending;

    late final Future<HealthSyncRunResult> tracked;
    tracked = operation().whenComplete(() {
      if (identical(_inFlight, tracked)) _inFlight = null;
    });
    _inFlight = tracked;
    return tracked;
  }
}

class HealthSyncCheckpointPolicy {
  static const Duration bootstrapWindow = Duration(days: 7);

  static DateTime _dayStart(DateTime value) {
    final local = value.toLocal();
    return DateTime(local.year, local.month, local.day);
  }

  static DateTime vitalsStart(DateTime? cursor, DateTime now) =>
      cursor ?? _dayStart(now).subtract(bootstrapWindow);

  static DateTime activityStart(DateTime? cursor, DateTime now) {
    final bootstrap = _dayStart(now).subtract(bootstrapWindow);
    if (cursor == null) return bootstrap;

    final cursorDay = _dayStart(cursor);
    final yesterday = _dayStart(now).subtract(const Duration(days: 1));
    return cursorDay.isBefore(yesterday) ? cursorDay : yesterday;
  }
}

List<List<T>> partitionHealthSyncDays<T>(List<T> values) {
  const batchSize = 31;
  return [
    for (var start = 0; start < values.length; start += batchSize)
      values.sublist(
        start,
        start + batchSize > values.length ? values.length : start + batchSize,
      ),
  ];
}

class HealthSyncCheckpointBatch<T> {
  final DateTime checkpoint;
  final List<T> values;

  const HealthSyncCheckpointBatch({
    required this.checkpoint,
    required this.values,
  });
}

List<HealthSyncCheckpointBatch<T>> groupHealthSyncSamples<T>(
  List<T> values, {
  required DateTime Function(T value) recordedAt,
  required String Function(T value) stableId,
}) {
  final ordered = List<T>.of(values)
    ..sort((a, b) {
      final byTime = recordedAt(a).compareTo(recordedAt(b));
      return byTime != 0 ? byTime : stableId(a).compareTo(stableId(b));
    });
  final batches = <HealthSyncCheckpointBatch<T>>[];
  for (var index = 0; index < ordered.length;) {
    final checkpoint = recordedAt(ordered[index]);
    final batch = <T>[];
    while (index < ordered.length && recordedAt(ordered[index]) == checkpoint) {
      batch.add(ordered[index]);
      index += 1;
    }
    batches.add(
      HealthSyncCheckpointBatch(checkpoint: checkpoint, values: batch),
    );
  }
  return batches;
}

Future<String> buildHealthSyncSourceRecordId({
  required String sampleType,
  required String nativeId,
  required String sourceId,
  required DateTime dateFrom,
  required DateTime dateTo,
}) async {
  final identity = nativeId.trim().isNotEmpty
      ? 'native\u0000${nativeId.trim()}'
      : 'fallback\u0000$sourceId\u0000${dateFrom.toUtc().toIso8601String()}\u0000${dateTo.toUtc().toIso8601String()}';
  final digest = await Sha256().hash(utf8.encode(identity));
  final hex = digest.bytes
      .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
      .join();
  return '$sampleType:$hex';
}

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
  final HealthSyncRunCoordinator _syncCoordinator = HealthSyncRunCoordinator();
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
  Future<int> syncNow() async =>
      (await _syncCoordinator.run(_performSync)).updatedSurfaces;

  Future<bool> syncForBackground() async =>
      (await _syncCoordinator.run(_performSync)).succeeded;

  Future<HealthSyncRunResult> _performSync() async {
    if (PatientOutageController.instance.blocksHospitalMutations) {
      return const HealthSyncRunResult(updatedSurfaces: 0, succeeded: false);
    }
    if (!_isSupportedPlatform) {
      return const HealthSyncRunResult(updatedSurfaces: 0, succeeded: true);
    }
    var types = _availableReadTypes();
    if (types.isEmpty) {
      return const HealthSyncRunResult(updatedSurfaces: 0, succeeded: true);
    }
    if (!_permissionsGranted) {
      await _health.configure();
      if (Platform.isAndroid) {
        types = await _grantedReadTypes(types);
        if (types.isEmpty) {
          return const HealthSyncRunResult(updatedSurfaces: 0, succeeded: true);
        }
      } else {
        final has = await _health.hasPermissions(types) ?? false;
        if (!has) {
          return const HealthSyncRunResult(updatedSurfaces: 0, succeeded: true);
        }
        _permissionsGranted = true;
      }
    }

    final prefs = await SharedPreferences.getInstance();
    final vitalsKey = '$_prefsLastVitalsSyncPrefix$_sourceTag';
    final activityKey = '$_prefsLastActivitySyncPrefix$_sourceTag';
    final end = DateTime.now();
    // The legacy shared checkpoint advanced after partial failures, so it is
    // deliberately not migrated; the first run safely replays seven days.
    final vitalsCursor = _readCursor(prefs.getString(vitalsKey), end);
    final activityCursor = _readCursor(prefs.getString(activityKey), end);
    final vitalsStart = HealthSyncCheckpointPolicy.vitalsStart(
      vitalsCursor,
      end,
    );
    final activityStart = HealthSyncCheckpointPolicy.activityStart(
      activityCursor,
      end,
    );
    final start = vitalsStart.isBefore(activityStart)
        ? vitalsStart
        : activityStart;
    if (!end.isAfter(start)) {
      return const HealthSyncRunResult(updatedSurfaces: 0, succeeded: true);
    }

    final List<HealthDataPoint> points;
    try {
      points = await _health.getHealthDataFromTypes(
        types: types,
        startTime: start,
        endTime: end,
      );
    } catch (e) {
      if (kDebugMode) debugPrint('HealthSyncService: read failed: $e');
      return const HealthSyncRunResult(updatedSurfaces: 0, succeeded: false);
    }
    if (points.isEmpty) {
      return const HealthSyncRunResult(updatedSurfaces: 0, succeeded: true);
    }

    double steps = 0;
    String? sourceApp;
    String? sourceDevice;
    final daily = <String, _DailyActivitySummary>{};
    final vitalSamples = <_WearableVitalSample>[];

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
        continue;
      }

      final v = _numeric(p.value);
      if (v == null) continue;
      switch (p.type) {
        case HealthDataType.HEART_RATE:
          if (!_isAfterCursor(p.dateTo, vitalsCursor)) break;
          vitalSamples.add(
            _WearableVitalSample(
              field: 'heartRate',
              value: v.round(),
              recordedAt: p.dateTo,
              sourceRecordId: await _sourceRecordId(p),
            ),
          );
          break;
        case HealthDataType.BLOOD_OXYGEN:
          if (!_isAfterCursor(p.dateTo, vitalsCursor)) break;
          final pct = v <= 1.0 ? v * 100 : v;
          vitalSamples.add(
            _WearableVitalSample(
              field: 'spO2',
              value: pct.round(),
              recordedAt: p.dateTo,
              sourceRecordId: await _sourceRecordId(p),
            ),
          );
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
          break;
        case HealthDataType.WEIGHT:
          if (!_isAfterCursor(p.dateTo, vitalsCursor)) break;
          vitalSamples.add(
            _WearableVitalSample(
              field: 'weight',
              value: v,
              recordedAt: p.dateTo,
              sourceRecordId: await _sourceRecordId(p),
            ),
          );
          break;
        case HealthDataType.BODY_TEMPERATURE:
          if (!_isAfterCursor(p.dateTo, vitalsCursor)) break;
          vitalSamples.add(
            _WearableVitalSample(
              field: 'temperature',
              value: v,
              recordedAt: p.dateTo,
              sourceRecordId: await _sourceRecordId(p),
            ),
          );
          break;
        default:
          break;
      }
    }

    var updatedSurfaces = 0;
    var succeeded = true;
    var vitalsUpdated = false;
    final vitalBatches = groupHealthSyncSamples(
      vitalSamples,
      recordedAt: (sample) => sample.recordedAt,
      stableId: (sample) => sample.sourceRecordId,
    );
    for (final batch in vitalBatches) {
      var groupSucceeded = true;
      for (final sample in batch.values) {
        try {
          final resp = await ApiClient.post(
            '/health/patient/vitals',
            body: {
              sample.field: sample.value,
              'source': _sourceTag,
              'sourceRecordId': sample.sourceRecordId,
              'recordedAtSource': sample.recordedAt.toIso8601String(),
            },
            idempotencyKey:
                'wearable-vital:$_sourceTag:${sample.sourceRecordId}',
          );
          if (!resp.isSuccess) {
            groupSucceeded = false;
            if (kDebugMode) {
              debugPrint(
                'HealthSyncService: vitals POST failed ${resp.statusCode}',
              );
            }
            break;
          }
          vitalsUpdated = true;
        } catch (e) {
          groupSucceeded = false;
          if (kDebugMode) {
            debugPrint('HealthSyncService: vitals POST error $e');
          }
          break;
        }
      }

      if (!groupSucceeded ||
          !await _saveCursor(prefs, vitalsKey, batch.checkpoint)) {
        succeeded = false;
        break;
      }
    }
    if (vitalsUpdated) updatedSurfaces += 1;

    final days = daily.values.where((d) => d.hasActivity).toList()
      ..sort((a, b) => a.date.compareTo(b.date));
    var activityUpdated = false;
    for (final batch in partitionHealthSyncDays(days)) {
      try {
        final resp = await ApiClient.post(
          '/steps/health-sync',
          body: {
            'source': _sourceTag,
            'sourceApp': sourceApp,
            'sourceDevice': sourceDevice,
            'days': batch.map((d) => d.toJson()).toList(),
          },
        );
        if (!resp.isSuccess) {
          succeeded = false;
          if (kDebugMode) {
            debugPrint(
              'HealthSyncService: activity POST failed ${resp.statusCode}',
            );
          }
          break;
        }
        final checkpoint = batch
            .map((day) => day.lastSampleAt!)
            .reduce(_laterOfNonNull);
        if (!await _saveCursor(prefs, activityKey, checkpoint)) {
          succeeded = false;
          break;
        }
        activityUpdated = true;
      } catch (e) {
        succeeded = false;
        if (kDebugMode) debugPrint('HealthSyncService: activity POST error $e');
        break;
      }
    }
    if (activityUpdated) updatedSurfaces += 1;

    if (kDebugMode) {
      debugPrint(
        'HealthSyncService: synced ${points.length} points, steps=$steps, days=${days.length}, surfaces=$updatedSurfaces',
      );
    }
    return HealthSyncRunResult(
      updatedSurfaces: updatedSurfaces,
      succeeded: succeeded,
    );
  }

  DateTime? _readCursor(String? value, DateTime end) {
    final parsed = value == null ? null : DateTime.tryParse(value);
    if (parsed == null || parsed.isAfter(end)) return null;
    return parsed;
  }

  bool _isAfterCursor(DateTime sampleAt, DateTime? cursor) =>
      cursor == null || sampleAt.isAfter(cursor);

  DateTime _laterOfNonNull(DateTime current, DateTime candidate) =>
      candidate.isAfter(current) ? candidate : current;

  Future<String> _sourceRecordId(HealthDataPoint point) =>
      buildHealthSyncSourceRecordId(
        sampleType: point.type.name,
        nativeId: point.uuid,
        sourceId: point.sourceId,
        dateFrom: point.dateFrom,
        dateTo: point.dateTo,
      );

  Future<bool> _saveCursor(
    SharedPreferences prefs,
    String key,
    DateTime value,
  ) async {
    if (!await prefs.setString(key, value.toIso8601String())) {
      if (kDebugMode) {
        debugPrint('HealthSyncService: failed to persist $key checkpoint');
      }
      return false;
    }
    return true;
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

class _WearableVitalSample {
  final String field;
  final num value;
  final DateTime recordedAt;
  final String sourceRecordId;

  const _WearableVitalSample({
    required this.field,
    required this.value,
    required this.recordedAt,
    required this.sourceRecordId,
  });
}

/// Top-level entry point invoked by workmanager in a background isolate. Must
/// be a top-level function so the Dart VM can locate it by symbol.
/// `@pragma('vm:entry-point')` prevents tree-shaking in release builds.
@pragma('vm:entry-point')
void healthSyncBackgroundDispatcher() {
  Workmanager().executeTask((task, inputData) async {
    try {
      final service = HealthSyncService.instance;
      return service.syncForBackground();
    } catch (e) {
      if (kDebugMode) debugPrint('healthSyncBackgroundDispatcher failed: $e');
      return false;
    }
  });
}
