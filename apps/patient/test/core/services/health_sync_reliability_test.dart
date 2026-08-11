import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/services/health_sync_service.dart';

void main() {
  group('HealthSyncCheckpointPolicy', () {
    final now = DateTime(2026, 8, 11, 15, 30);

    test(
      'keeps a stale vitals cursor instead of truncating replay to 7 days',
      () {
        final cursor = now.subtract(const Duration(days: 19));

        expect(HealthSyncCheckpointPolicy.vitalsStart(cursor, now), cursor);
      },
    );

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
