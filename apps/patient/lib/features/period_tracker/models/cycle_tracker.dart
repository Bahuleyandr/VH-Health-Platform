import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

@immutable
class CycleEstimate {
  final DateTime cycleStart;
  final DateTime periodEnd;
  final DateTime nextPeriod;
  final DateTime fertileStart;
  final DateTime fertileEnd;
  final int cycleDay;
  final int daysToNextPeriod;
  final int cycleLength;
  final int periodLength;

  const CycleEstimate({
    required this.cycleStart,
    required this.periodEnd,
    required this.nextPeriod,
    required this.fertileStart,
    required this.fertileEnd,
    required this.cycleDay,
    required this.daysToNextPeriod,
    required this.cycleLength,
    required this.periodLength,
  });

  bool get isPeriodWindow {
    final today = CycleTrackerSnapshot.dateOnly(DateTime.now());
    return !today.isBefore(cycleStart) && !today.isAfter(periodEnd);
  }

  double get cycleProgress => cycleLength <= 0
      ? 0
      : (cycleDay / cycleLength).clamp(0.0, 1.0).toDouble();

  String get phaseLabel {
    final today = CycleTrackerSnapshot.dateOnly(DateTime.now());
    if (isPeriodWindow) return 'Period window';
    if (!today.isBefore(fertileStart) && !today.isAfter(fertileEnd)) {
      return 'Fertile window';
    }
    if (daysToNextPeriod <= 7) return 'Due soon';
    return 'Cycle day $cycleDay';
  }
}

@immutable
class CycleTrackerSnapshot {
  final String ownerKey;
  final DateTime? lastPeriodStart;
  final int cycleLength;
  final int periodLength;

  const CycleTrackerSnapshot({
    required this.ownerKey,
    required this.lastPeriodStart,
    required this.cycleLength,
    required this.periodLength,
  });

  bool get hasStartDate => lastPeriodStart != null;

  CycleEstimate? estimate({DateTime? now}) {
    final start = lastPeriodStart;
    if (start == null) return null;

    final today = dateOnly(now ?? DateTime.now());
    final base = dateOnly(start);
    final cycleDays = _bounded(cycleLength, min: 1, max: 365);
    final periodDays = _bounded(periodLength, min: 1, max: cycleDays);
    final daysSince = today.difference(base).inDays;
    final cyclesElapsed = daysSince < 0 ? 0 : daysSince ~/ cycleDays;
    final cycleStart = base.add(Duration(days: cyclesElapsed * cycleDays));
    final periodEnd = cycleStart.add(Duration(days: periodDays - 1));
    final inPeriodWindow =
        !today.isBefore(cycleStart) && !today.isAfter(periodEnd);
    final nextPeriod = inPeriodWindow
        ? cycleStart
        : cycleStart.add(Duration(days: cycleDays));
    final ovulation = cycleStart.add(Duration(days: cycleDays - 14));
    final fertileStart = ovulation.subtract(const Duration(days: 5));
    final fertileEnd = ovulation.add(const Duration(days: 1));
    final cycleDay = today.difference(cycleStart).inDays + 1;

    return CycleEstimate(
      cycleStart: cycleStart,
      periodEnd: periodEnd,
      nextPeriod: nextPeriod,
      fertileStart: fertileStart,
      fertileEnd: fertileEnd,
      cycleDay: _bounded(cycleDay, min: 1, max: cycleDays),
      daysToNextPeriod: nextPeriod
          .difference(today)
          .inDays
          .clamp(0, 365)
          .toInt(),
      cycleLength: cycleDays,
      periodLength: periodDays,
    );
  }

  static DateTime dateOnly(DateTime value) =>
      DateTime(value.year, value.month, value.day);

  static int _bounded(int value, {required int min, required int max}) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }
}

class CycleTrackerStore {
  const CycleTrackerStore._();

  static String ownerKeyFor({required String userPhone, String? dependentUid}) {
    final dep = dependentUid?.trim();
    if (dep != null && dep.isNotEmpty) return dep;
    return userPhone.trim();
  }

  static String storageKeyFor(String ownerKey) => 'period_tracker_$ownerKey';

  static Future<CycleTrackerSnapshot> load({
    required String userPhone,
    String? dependentUid,
  }) async {
    final ownerKey = ownerKeyFor(
      userPhone: userPhone,
      dependentUid: dependentUid,
    );
    final storageKey = storageKeyFor(ownerKey);
    final prefs = await SharedPreferences.getInstance();
    final rawStart = prefs.getString('${storageKey}_last_start');

    return CycleTrackerSnapshot(
      ownerKey: ownerKey,
      lastPeriodStart: rawStart == null ? null : DateTime.tryParse(rawStart),
      cycleLength: prefs.getInt('${storageKey}_cycle_length') ?? 28,
      periodLength: prefs.getInt('${storageKey}_period_length') ?? 5,
    );
  }

  static Future<void> save(CycleTrackerSnapshot snapshot) async {
    final storageKey = storageKeyFor(snapshot.ownerKey);
    final prefs = await SharedPreferences.getInstance();
    final start = snapshot.lastPeriodStart;
    if (start != null) {
      await prefs.setString('${storageKey}_last_start', _dateKey(start));
    } else {
      await prefs.remove('${storageKey}_last_start');
    }
    await prefs.setInt('${storageKey}_cycle_length', snapshot.cycleLength);
    await prefs.setInt('${storageKey}_period_length', snapshot.periodLength);
  }

  static String _dateKey(DateTime value) {
    final local = CycleTrackerSnapshot.dateOnly(value);
    final year = local.year.toString().padLeft(4, '0');
    final month = local.month.toString().padLeft(2, '0');
    final day = local.day.toString().padLeft(2, '0');
    return '$year-$month-$day';
  }
}
