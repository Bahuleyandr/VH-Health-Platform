import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vhhealth_core/services/secure_storage.dart';

enum CycleStatus { dueIn, dueToday, delayed, missed }

@immutable
class CycleEstimate {
  final DateTime lastPeriodStart;
  final DateTime lastPeriodEnd;
  final DateTime cycleStart;
  final DateTime expectedPeriodEnd;
  final DateTime nextPeriod;
  final DateTime fertileStart;
  final DateTime fertileEnd;
  final int cycleDay;
  final int daysToNextPeriod;
  final int delayedDays;
  final int cycleLength;
  final int periodLength;
  final CycleStatus status;

  const CycleEstimate({
    required this.lastPeriodStart,
    required this.lastPeriodEnd,
    required this.cycleStart,
    required this.expectedPeriodEnd,
    required this.nextPeriod,
    required this.fertileStart,
    required this.fertileEnd,
    required this.cycleDay,
    required this.daysToNextPeriod,
    required this.delayedDays,
    required this.cycleLength,
    required this.periodLength,
    required this.status,
  });

  DateTime get periodEnd => expectedPeriodEnd;

  bool get isPeriodWindow => status == CycleStatus.dueToday;

  bool get isDelayed => status == CycleStatus.delayed;

  bool get mayBePregnant => status == CycleStatus.missed;

  double get cycleProgress => cycleLength <= 0
      ? 0
      : (cycleDay / cycleLength).clamp(0.0, 1.0).toDouble();

  String get phaseLabel {
    if (mayBePregnant) return 'You may be pregnant';
    if (isDelayed) return 'Cycle delayed by $delayedDays days';
    if (status == CycleStatus.dueToday) return 'Cycle due today';
    if (!today.isBefore(fertileStart) && !today.isAfter(fertileEnd)) {
      return 'Fertile window';
    }
    if (daysToNextPeriod <= 7) return 'Due soon';
    return 'Cycle day $cycleDay';
  }

  DateTime get today => CycleTrackerSnapshot.dateOnly(DateTime.now());
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
    final lastPeriodEnd = base.add(Duration(days: periodDays - 1));
    final nextPeriod = base.add(Duration(days: cycleDays));
    final expectedPeriodEnd = nextPeriod.add(Duration(days: periodDays - 1));
    final daysUntilNextPeriod = nextPeriod.difference(today).inDays;
    final delayedDays = today.isAfter(nextPeriod)
        ? today.difference(nextPeriod).inDays
        : 0;
    final status = daysUntilNextPeriod > 0
        ? CycleStatus.dueIn
        : daysUntilNextPeriod == 0
        ? CycleStatus.dueToday
        : delayedDays >= cycleDays
        ? CycleStatus.missed
        : CycleStatus.delayed;
    final ovulation = nextPeriod.subtract(const Duration(days: 14));
    final fertileStart = ovulation.subtract(const Duration(days: 5));
    final fertileEnd = ovulation.add(const Duration(days: 1));
    final cycleDay = today.difference(base).inDays + 1;

    return CycleEstimate(
      lastPeriodStart: base,
      lastPeriodEnd: lastPeriodEnd,
      cycleStart: base,
      expectedPeriodEnd: expectedPeriodEnd,
      nextPeriod: nextPeriod,
      fertileStart: fertileStart,
      fertileEnd: fertileEnd,
      cycleDay: _bounded(cycleDay, min: 1, max: 3650),
      daysToNextPeriod: daysUntilNextPeriod.clamp(0, 365).toInt(),
      delayedDays: delayedDays.clamp(0, 3650).toInt(),
      cycleLength: cycleDays,
      periodLength: periodDays,
      status: status,
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

/// Persistence for cycle/period/fertility tracking.
///
/// This is PHI, so it is stored ENCRYPTED AT REST via [VHSecureStorage]
/// (Android Keystore-backed EncryptedSharedPreferences / iOS Keychain — the
/// same app-wide secure store used for JWTs and downloaded clinical docs).
/// It was previously written as plaintext to [SharedPreferences]; [load]
/// performs a one-time migration of any legacy plaintext record into the
/// encrypted store and PURGES the plaintext copy so it cannot linger on disk.
///
/// Each owner (the signed-in patient, or an active dependent profile) gets one
/// JSON blob under `period_tracker_<ownerKey>`. Because secure storage has no
/// prefix scan, an index key ([_indexKey]) tracks the owner keys so [clearAll]
/// (logout) can wipe every one.
class CycleTrackerStore {
  const CycleTrackerStore._();

  /// Index of every secure-storage key that holds a cycle record, so logout
  /// can enumerate + delete them (secure storage offers no prefix scan).
  static const String _indexKey = 'period_tracker__owner_index';

  /// Legacy plaintext SharedPreferences keys all share this prefix.
  static const String _legacyPrefix = 'period_tracker_';

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
    final storage = VHSecureStorage.instance;

    final raw = await storage.read(key: storageKey);
    if (raw != null) {
      return _decode(ownerKey, raw);
    }

    // No encrypted record yet — attempt a one-time migration of any legacy
    // plaintext copy, then purge the plaintext keys.
    final migrated = await _migrateLegacy(ownerKey);
    if (migrated != null) return migrated;

    return CycleTrackerSnapshot(
      ownerKey: ownerKey,
      lastPeriodStart: null,
      cycleLength: 28,
      periodLength: 5,
    );
  }

  static Future<void> save(CycleTrackerSnapshot snapshot) async {
    final storageKey = storageKeyFor(snapshot.ownerKey);
    final storage = VHSecureStorage.instance;
    final start = snapshot.lastPeriodStart;
    final payload = <String, dynamic>{
      'lastPeriodStart': start == null ? null : _dateKey(start),
      'cycleLength': snapshot.cycleLength,
      'periodLength': snapshot.periodLength,
    };
    await storage.write(key: storageKey, value: jsonEncode(payload));
    await _indexAdd(storageKey);
  }

  /// Remove all cycle/period/fertility data for every owner (self +
  /// dependents). Called on logout so this sensitive data does not survive for
  /// the next user on a shared device. Wipes the encrypted store AND sweeps up
  /// any leftover legacy plaintext SharedPreferences keys.
  static Future<void> clearAll() async {
    final storage = VHSecureStorage.instance;

    // Encrypted records, enumerated via the index.
    for (final key in await _indexKeys()) {
      await storage.delete(key: key);
    }
    await storage.delete(key: _indexKey);

    // Legacy plaintext keys (pre-migration installs, or records never re-read).
    try {
      final prefs = await SharedPreferences.getInstance();
      final keys = prefs
          .getKeys()
          .where((k) => k.startsWith(_legacyPrefix))
          .toList();
      for (final key in keys) {
        await prefs.remove(key);
      }
    } catch (e) {
      if (kDebugMode) {
        debugPrint('CycleTrackerStore: legacy plaintext purge failed: $e');
      }
    }
  }

  /// Decode a stored JSON blob into a snapshot, tolerating any corruption.
  static CycleTrackerSnapshot _decode(String ownerKey, String raw) {
    try {
      final map = jsonDecode(raw) as Map<String, dynamic>;
      final rawStart = map['lastPeriodStart'] as String?;
      return CycleTrackerSnapshot(
        ownerKey: ownerKey,
        lastPeriodStart: rawStart == null ? null : DateTime.tryParse(rawStart),
        cycleLength: (map['cycleLength'] as num?)?.toInt() ?? 28,
        periodLength: (map['periodLength'] as num?)?.toInt() ?? 5,
      );
    } catch (e) {
      if (kDebugMode) {
        debugPrint('CycleTrackerStore: decode failed for $ownerKey: $e');
      }
      return CycleTrackerSnapshot(
        ownerKey: ownerKey,
        lastPeriodStart: null,
        cycleLength: 28,
        periodLength: 5,
      );
    }
  }

  /// One-time migration: if a plaintext SharedPreferences record exists for
  /// [ownerKey], move it into the encrypted store, delete the plaintext keys,
  /// and return the migrated snapshot. Returns null when there is nothing to
  /// migrate.
  static Future<CycleTrackerSnapshot?> _migrateLegacy(String ownerKey) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final storageKey = storageKeyFor(ownerKey);
      final startKey = '${storageKey}_last_start';
      final cycleKey = '${storageKey}_cycle_length';
      final periodKey = '${storageKey}_period_length';

      final hasLegacy =
          prefs.containsKey(startKey) ||
          prefs.containsKey(cycleKey) ||
          prefs.containsKey(periodKey);
      if (!hasLegacy) return null;

      final rawStart = prefs.getString(startKey);
      final snapshot = CycleTrackerSnapshot(
        ownerKey: ownerKey,
        lastPeriodStart: rawStart == null ? null : DateTime.tryParse(rawStart),
        cycleLength: prefs.getInt(cycleKey) ?? 28,
        periodLength: prefs.getInt(periodKey) ?? 5,
      );

      // Write to the encrypted store first, then purge the plaintext copy so a
      // crash mid-migration never loses the user's data.
      await save(snapshot);
      await prefs.remove(startKey);
      await prefs.remove(cycleKey);
      await prefs.remove(periodKey);
      return snapshot;
    } catch (e) {
      if (kDebugMode) {
        debugPrint('CycleTrackerStore: legacy migration failed: $e');
      }
      return null;
    }
  }

  static Future<List<String>> _indexKeys() async {
    final raw = await VHSecureStorage.instance.read(key: _indexKey);
    if (raw == null || raw.isEmpty) return const [];
    try {
      final list = jsonDecode(raw) as List<dynamic>;
      return list.map((e) => e as String).toList();
    } catch (_) {
      return const [];
    }
  }

  static Future<void> _indexAdd(String storageKey) async {
    final keys = (await _indexKeys()).toSet()..add(storageKey);
    await VHSecureStorage.instance.write(
      key: _indexKey,
      value: jsonEncode(keys.toList()),
    );
  }

  static String _dateKey(DateTime value) {
    final local = CycleTrackerSnapshot.dateOnly(value);
    final year = local.year.toString().padLeft(4, '0');
    final month = local.month.toString().padLeft(2, '0');
    final day = local.day.toString().padLeft(2, '0');
    return '$year-$month-$day';
  }
}
