import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/features/period_tracker/models/cycle_tracker.dart';

void main() {
  group('CycleTrackerSnapshot.estimate', () {
    const snapshot = CycleTrackerSnapshot(
      ownerKey: 'patient',
      lastPeriodStart: null,
      cycleLength: 28,
      periodLength: 5,
    );

    test('returns null until a period start is recorded', () {
      expect(snapshot.estimate(now: DateTime(2026, 1, 10)), isNull);
    });

    test('counts down to the next actual expected cycle only', () {
      final estimate = CycleTrackerSnapshot(
        ownerKey: 'patient',
        lastPeriodStart: DateTime(2026, 1, 1),
        cycleLength: 28,
        periodLength: 5,
      ).estimate(now: DateTime(2026, 1, 10));

      expect(estimate, isNotNull);
      expect(estimate!.status, CycleStatus.dueIn);
      expect(estimate.daysToNextPeriod, 19);
      expect(estimate.nextPeriod, DateTime(2026, 1, 29));
    });

    test('does not roll forward when the expected date passes', () {
      final estimate = CycleTrackerSnapshot(
        ownerKey: 'patient',
        lastPeriodStart: DateTime(2026, 1, 1),
        cycleLength: 28,
        periodLength: 5,
      ).estimate(now: DateTime(2026, 2, 1));

      expect(estimate, isNotNull);
      expect(estimate!.status, CycleStatus.delayed);
      expect(estimate.delayedDays, 3);
      expect(estimate.nextPeriod, DateTime(2026, 1, 29));
    });

    test('marks a missed cycle as possibly pregnant', () {
      final estimate = CycleTrackerSnapshot(
        ownerKey: 'patient',
        lastPeriodStart: DateTime(2026, 1, 1),
        cycleLength: 28,
        periodLength: 5,
      ).estimate(now: DateTime(2026, 3, 1));

      expect(estimate, isNotNull);
      expect(estimate!.status, CycleStatus.missed);
      expect(estimate.mayBePregnant, isTrue);
      expect(estimate.nextPeriod, DateTime(2026, 1, 29));
    });
  });
}
