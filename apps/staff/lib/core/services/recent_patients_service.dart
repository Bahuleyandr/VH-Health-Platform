import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../config/api_config.dart';

/// Local-only cache of the most recently opened EMR patients.
///
/// Entries are scoped to the signed-in staff identity so shared tablets and
/// workstations never show one staff member another staff member's recent PHI
/// context after an unclean shutdown or account switch.
class RecentPatientsService {
  RecentPatientsService._();

  static const _legacyKey = 'recent_patients';
  static const _indexKey = 'recent_patients_keys';
  static const _keyPrefix = 'recent_patients:staff:';
  static const _maxEntries = 5;

  @visibleForTesting
  static String? debugStaffIdentityOverride;

  static Future<String?> _currentStorageKey() async {
    final debugIdentity = debugStaffIdentityOverride?.trim();
    if (debugIdentity != null && debugIdentity.isNotEmpty) {
      return '$_keyPrefix$debugIdentity';
    }

    final staffId = (await ApiConfig.getStaffId())?.trim();
    if (staffId != null && staffId.isNotEmpty) {
      return '$_keyPrefix$staffId';
    }

    final employeeId = (await ApiConfig.getEmployeeId())?.trim();
    if (employeeId != null && employeeId.isNotEmpty) {
      return '$_keyPrefix$employeeId';
    }

    return null;
  }

  static List<Map<String, dynamic>> _decodeList(String? raw) {
    if (raw == null || raw.isEmpty) return <Map<String, dynamic>>[];
    final decoded = jsonDecode(raw);
    if (decoded is! List) return const [];
    return decoded.whereType<Map>().map((entry) {
      return entry.map((key, value) => MapEntry(key.toString(), value));
    }).toList();
  }

  static Future<void> _rememberKey(SharedPreferences prefs, String key) async {
    final keys = prefs.getStringList(_indexKey) ?? const [];
    if (keys.contains(key)) return;
    await prefs.setStringList(_indexKey, [...keys, key]);
  }

  /// Records [uid] + [name] as the most-recently-viewed patient.
  ///
  /// Dedupes by uid, moves an existing entry to the top, trims to
  /// [_maxEntries], and silently ignores storage errors so navigation never
  /// fails because the local recents cache is unavailable.
  static Future<void> add(String uid, String? name) async {
    try {
      if (uid.isEmpty) return;
      final key = await _currentStorageKey();
      if (key == null) return;

      final prefs = await SharedPreferences.getInstance();
      var list = _decodeList(prefs.getString(key));
      list.removeWhere((entry) => entry['uid'] == uid);
      list.insert(0, {
        'uid': uid,
        'name': (name ?? '').trim().isEmpty ? 'Patient' : name!.trim(),
        'ts': DateTime.now().millisecondsSinceEpoch,
      });
      if (list.length > _maxEntries) list = list.sublist(0, _maxEntries);

      await prefs.setString(key, jsonEncode(list));
      await _rememberKey(prefs, key);
    } catch (_) {
      // Non-critical.
    }
  }

  /// Returns this staff member's cached entries newest-first.
  static Future<List<Map<String, dynamic>>> getAll() async {
    try {
      final key = await _currentStorageKey();
      if (key == null) return const [];
      final prefs = await SharedPreferences.getInstance();
      return _decodeList(prefs.getString(key));
    } catch (_) {
      return const [];
    }
  }

  /// Clears every local recent-patient cache, including the legacy global key.
  ///
  /// Logout and idle-timeout use this broad wipe so shared tablets and
  /// workstations do not expose the previous staff member's local PHI context.
  static Future<void> clear() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final currentKey = await _currentStorageKey();
      final keys = <String>{_legacyKey, ...?prefs.getStringList(_indexKey)};
      if (currentKey != null) keys.add(currentKey);

      for (final key in keys) {
        await prefs.remove(key);
      }
      await prefs.remove(_indexKey);
    } catch (_) {
      // Non-critical.
    }
  }
}
