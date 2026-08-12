import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:health/health.dart';
import 'package:vhhealth/core/services/health_sync_service.dart';

void main() {
  group('HealthSyncCheckpointPolicy', () {
    final now = DateTime(2026, 8, 11, 15, 30);

    test(
      'keeps a stale vitals cursor with a bounded inclusive replay overlap',
      () {
        final cursor = now.subtract(const Duration(days: 19));
        final recentSafetyScan = now.subtract(const Duration(hours: 1));

        expect(
          HealthSyncCheckpointPolicy.vitalsStart(
            cursor,
            now,
            lastSafetyScan: recentSafetyScan,
          ),
          cursor.subtract(HealthSyncCheckpointPolicy.vitalsReplayWindow),
        );
      },
    );

    test('periodically replays a multi-day window for delayed imports', () {
      final cursor = now.subtract(const Duration(minutes: 10));
      final staleSafetyScan = now.subtract(
        HealthSyncCheckpointPolicy.vitalsSafetyInterval,
      );
      final start = HealthSyncCheckpointPolicy.vitalsStart(
        cursor,
        now,
        lastSafetyScan: staleSafetyScan,
      );

      expect(
        start,
        now.subtract(HealthSyncCheckpointPolicy.vitalsSafetyWindow),
      );
      expect(
        HealthSyncCheckpointPolicy.includesVitalSample(
          now.subtract(const Duration(days: 3)),
          start,
        ),
        isTrue,
      );
    });

    test('includes samples equal to and older than the durable cursor', () {
      final cursor = DateTime(2026, 8, 11, 14);
      final start = HealthSyncCheckpointPolicy.vitalsStart(cursor, now);

      expect(
        HealthSyncCheckpointPolicy.includesVitalSample(start, start),
        isTrue,
      );
      expect(
        HealthSyncCheckpointPolicy.includesVitalSample(cursor, start),
        isTrue,
      );
      expect(
        HealthSyncCheckpointPolicy.includesVitalSample(
          start.subtract(const Duration(microseconds: 1)),
          start,
        ),
        isFalse,
      );
    });

    test(
      'keeps a stale activity cursor day instead of truncating to yesterday',
      () {
        final cursor = DateTime(2026, 7, 12, 19, 45);

        expect(
          HealthSyncCheckpointPolicy.activityStart(cursor, now),
          DateTime(2026, 7, 12),
        );
      },
    );

    test(
      'replays yesterday for recent activity so daily totals stay complete',
      () {
        final cursor = DateTime(2026, 8, 11, 14);

        expect(
          HealthSyncCheckpointPolicy.activityStart(cursor, now),
          DateTime(2026, 8, 10),
        );
      },
    );

    test(
      'uses the bounded bootstrap window only when no checkpoint exists',
      () {
        expect(
          HealthSyncCheckpointPolicy.vitalsStart(null, now),
          DateTime(2026, 8, 4),
        );
        expect(
          HealthSyncCheckpointPolicy.activityStart(null, now),
          DateTime(2026, 8, 4),
        );
      },
    );
  });

  test('vital cursor keys are stable and isolated per sample type', () {
    final heartRate = buildHealthSyncVitalCursorKey(
      ownerScope: 'owner-a',
      sourceTag: 'health_connect',
      sampleType: 'HEART_RATE',
    );
    final oxygen = buildHealthSyncVitalCursorKey(
      ownerScope: 'owner-a',
      sourceTag: 'health_connect',
      sampleType: 'BLOOD_OXYGEN',
    );

    expect(
      heartRate,
      'health_sync_owner-a_last_vitals_health_connect_HEART_RATE',
    );
    expect(oxygen, isNot(heartRate));
    expect(
      buildHealthSyncVitalSafetyKey(
        ownerScope: 'owner-a',
        sourceTag: 'health_connect',
        sampleType: 'HEART_RATE',
      ),
      'health_sync_owner-a_last_vitals_safety_health_connect_HEART_RATE',
    );
  });

  test('persisted sync state is isolated by a hashed account scope', () async {
    final first = await buildHealthSyncOwnerScope('patient-a');
    final replay = await buildHealthSyncOwnerScope('patient-a');
    final second = await buildHealthSyncOwnerScope('patient-b');

    expect(first, replay);
    expect(first, matches(RegExp(r'^[0-9a-f]{64}$')));
    expect(second, isNot(first));
    expect(
      buildHealthSyncVitalCursorKey(
        ownerScope: second,
        sourceTag: 'health_connect',
        sampleType: 'HEART_RATE',
      ),
      isNot(
        buildHealthSyncVitalCursorKey(
          ownerScope: first,
          sourceTag: 'health_connect',
          sampleType: 'HEART_RATE',
        ),
      ),
    );
  });

  test('sync runs only for the bound account and scheduled owner', () {
    expect(
      isHealthSyncAccountSessionActive(
        currentOwnerScope: 'owner-a',
        persistedOwnerScope: 'owner-a',
        scheduledOwnerScope: 'owner-a',
      ),
      isTrue,
    );
    expect(
      isHealthSyncAccountSessionActive(
        currentOwnerScope: 'owner-b',
        persistedOwnerScope: 'owner-b',
        scheduledOwnerScope: 'owner-a',
      ),
      isFalse,
    );
    expect(
      isHealthSyncAccountSessionActive(
        currentOwnerScope: 'owner-b',
        persistedOwnerScope: 'owner-a',
      ),
      isFalse,
    );
  });

  test('manual health-store records are excluded from wearable ingestion', () {
    expect(shouldSyncHealthRecordingMethod(RecordingMethod.manual), isFalse);
    expect(shouldSyncHealthRecordingMethod(RecordingMethod.automatic), isTrue);
    expect(shouldSyncHealthRecordingMethod(RecordingMethod.active), isTrue);
    expect(
      shouldSyncHealthDataPoint(
        recordingMethod: RecordingMethod.automatic,
        sourceId: 'com.vh.vhhealth',
      ),
      isFalse,
      reason: 'legacy app writes were incorrectly tagged automatic',
    );
    expect(
      shouldSyncHealthDataPoint(
        recordingMethod: RecordingMethod.automatic,
        sourceId: 'com.example.watch',
      ),
      isTrue,
    );
  });

  test(
    'health timestamps carry an explicit offset without changing the instant',
    () {
      final instant = DateTime.utc(2026, 8, 11, 8, 1, 2, 345);
      final encoded = formatHealthSyncRfc3339(instant);

      expect(encoded, matches(RegExp(r'(?:Z|[+-]\d{2}:\d{2})$')));
      expect(DateTime.parse(encoded).toUtc(), instant);
    },
  );

  test('activity batches stay within the backend 31-day contract', () {
    final batches = partitionHealthSyncDays(
      List<int>.generate(65, (index) => index),
    );

    expect(batches.map((batch) => batch.length), [31, 31, 3]);
    expect(batches.expand((batch) => batch), List<int>.generate(65, (i) => i));
  });

  test('vitals replay preserves every unsent sample in checkpoint order', () {
    final oldest = DateTime(2026, 7, 12, 8);
    final newest = DateTime(2026, 8, 11, 9);
    final samples = [
      (id: 'newest', recordedAt: newest),
      (id: 'same-time-b', recordedAt: oldest),
      (id: 'same-time-a', recordedAt: oldest),
    ];

    final batches = groupHealthSyncSamples(
      samples,
      recordedAt: (sample) => sample.recordedAt,
      stableId: (sample) => sample.id,
    );

    expect(batches.map((batch) => batch.checkpoint), [oldest, newest]);
    expect(batches.expand((batch) => batch.values).map((sample) => sample.id), [
      'same-time-a',
      'same-time-b',
      'newest',
    ]);
  });

  test(
    'wearable sample receipts are stable, bounded, and collision-resistant',
    () async {
      final from = DateTime.utc(2026, 8, 11, 8);
      final to = DateTime.utc(2026, 8, 11, 8, 1);
      final first = await buildHealthSyncSourceRecordId(
        sampleType: 'HEART_RATE',
        nativeId: 'sample / with unsafe characters',
        sourceId: 'provider',
        dateFrom: from,
        dateTo: to,
      );
      final replay = await buildHealthSyncSourceRecordId(
        sampleType: 'HEART_RATE',
        nativeId: 'sample / with unsafe characters',
        sourceId: 'ignored-for-native-id',
        dateFrom: from.add(const Duration(days: 1)),
        dateTo: to.add(const Duration(days: 1)),
      );
      final distinct = await buildHealthSyncSourceRecordId(
        sampleType: 'HEART_RATE',
        nativeId: 'sample ? with unsafe characters',
        sourceId: 'provider',
        dateFrom: from,
        dateTo: to,
      );

      expect(first, replay);
      expect(first, matches(RegExp(r'^HEART_RATE:[0-9a-f]{64}$')));
      expect(first.length, lessThanOrEqualTo(180));
      expect(distinct, isNot(first));
    },
  );

  test('receipt conflicts use the explicit correction path', () {
    expect(
      classifyHealthSyncPostStatus(200),
      HealthSyncPostDisposition.accepted,
    );
    expect(
      classifyHealthSyncPostStatus(400),
      HealthSyncPostDisposition.terminalRejection,
    );
    expect(
      classifyHealthSyncPostStatus(409),
      HealthSyncPostDisposition.correctionRequired,
    );
    expect(
      buildHealthSyncCorrectionPath('HEART_RATE:sample/902'),
      '/health/patient/vitals/wearable/HEART_RATE%3Asample%2F902',
    );
    for (final status in [401, 403, 404, 408, 429, 500, 503]) {
      expect(
        classifyHealthSyncPostStatus(status),
        HealthSyncPostDisposition.retryableFailure,
        reason: 'HTTP $status must retain the sample for replay',
      );
    }
  });

  test('separate correction attempts never reuse a prior successful key', () {
    final first = buildHealthSyncCorrectionAttemptKey(
      sourceTag: 'health_connect',
      targetFingerprint: 'a' * 64,
    );
    final retryOfTheSameTarget = buildHealthSyncCorrectionAttemptKey(
      sourceTag: 'health_connect',
      targetFingerprint: 'a' * 64,
    );

    expect(first, isNot(retryOfTheSameTarget));
    expect(
      first,
      matches(
        RegExp(
          r'^wearable-vital-correction:health_connect:a{64}:[0-9a-f-]{36}$',
        ),
      ),
    );
  });

  test(
    'quarantine keys bind the receipt to the exact rejected payload',
    () async {
      final recordedAt = DateTime.utc(2026, 8, 11, 8, 1);
      final first = await buildHealthSyncRejectionKey(
        sourceTag: 'health_connect',
        field: 'heartRate',
        value: 999,
        sourceRecordId: 'HEART_RATE:receipt',
        recordedAt: recordedAt,
      );
      final replay = await buildHealthSyncRejectionKey(
        sourceTag: 'health_connect',
        field: 'heartRate',
        value: 999,
        sourceRecordId: 'HEART_RATE:receipt',
        recordedAt: recordedAt,
      );
      final changed = await buildHealthSyncRejectionKey(
        sourceTag: 'health_connect',
        field: 'heartRate',
        value: 998,
        sourceRecordId: 'HEART_RATE:receipt',
        recordedAt: recordedAt,
      );

      expect(first, replay);
      expect(first, matches(RegExp(r'^[0-9a-f]{64}$')));
      expect(changed, isNot(first));
    },
  );

  test('quarantine retention is bounded and keeps the newest receipts', () {
    final retained = retainHealthSyncRejectionKeys(
      List<String>.generate(
        HealthSyncRejectionPolicy.maxEntries + 2,
        (i) => 'r$i',
      ),
    );

    expect(retained, hasLength(HealthSyncRejectionPolicy.maxEntries));
    expect(retained.first, 'r2');
    expect(retained.last, 'r${HealthSyncRejectionPolicy.maxEntries + 1}');
  });

  test(
    'overlapping triggers execute one operation and share its result',
    () async {
      final coordinator = HealthSyncRunCoordinator();
      final completion = Completer<HealthSyncRunResult>();
      var calls = 0;

      Future<HealthSyncRunResult> operation() {
        calls += 1;
        return completion.future;
      }

      final first = coordinator.run(operation);
      final second = coordinator.run(operation);

      expect(identical(first, second), isTrue);
      expect(calls, 1);

      const result = HealthSyncRunResult(updatedSurfaces: 1, succeeded: false);
      completion.complete(result);
      expect(await first, result);
      expect(await second, result);
    },
  );

  test(
    'a failed run can be retried after the shared operation completes',
    () async {
      final coordinator = HealthSyncRunCoordinator();
      var calls = 0;

      Future<HealthSyncRunResult> operation() async {
        calls += 1;
        return HealthSyncRunResult(updatedSurfaces: 0, succeeded: calls > 1);
      }

      expect((await coordinator.run(operation)).succeeded, isFalse);
      expect((await coordinator.run(operation)).succeeded, isTrue);
      expect(calls, 2);
    },
  );
}
