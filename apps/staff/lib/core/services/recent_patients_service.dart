import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vhhealth_core/services/secure_storage.dart';

import '../config/api_config.dart';

/// Local-only cache of the most recently opened EMR patients.
///
/// Entries are scoped to the signed-in staff identity so shared tablets and
/// workstations never show one staff member another staff member's recent PHI
/// context after an unclean shutdown or account switch.
///
/// Storage: [FlutterSecureStorage] (audit finding M10, 2026-06-10 — this PHI
/// cache previously lived in plaintext SharedPreferences, extractable on a
/// rooted device or via the `adb backup` path closed by finding H9). Legacy
/// plaintext entries are purged on first write/clear after upgrade.
class RecentPatientsService {
  RecentPatientsService._();

  static const _legacyKey = 'recent_patients';
  static const _indexKey = 'recent_patients_keys';
  static const _keyPrefix = 'recent_patients:staff:';
  static const _maxEntries = 5;

  static final _storage = VHSecureStorage.instance;

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

  static Future<void> _rememberKey(String key) async {
    final rawIndex = await _storage.read(key: _indexKey);
    final keys = (rawIndex == null || rawIndex.isEmpty)
        ? const <String>[]
        : List<String>.from(jsonDecode(rawIndex) as List);
    if (keys.contains(key)) return;
    await _storage.write(key: _indexKey, value: jsonEncode([...keys, key]));
  }

  /// One-time purge of the pre-M10 plaintext SharedPreferences entries so
  /// upgraded installs don't keep stale PHI on disk in cleartext.
  static Future<void> _purgeLegacyPlaintext() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final keys = <String>{
        _legacyKey,
        _indexKey,
        ...?prefs.getStringList(_indexKey),
        ...prefs.getKeys().where((k) => k.startsWith(_keyPrefix)),
      };
      for (final key in keys) {
        await prefs.remove(key);
      }
    } catch (_) {
      // Non-critical.
    }
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

      await _purgeLegacyPlaintext();

      var list = _decodeList(await _storage.read(key: key));
      list.removeWhere((entry) => entry['uid'] == uid);
      list.insert(0, {
        'uid': uid,
        'name': (name ?? '').trim().isEmpty ? 'Patient' : name!.trim(),
        'ts': DateTime.now().millisecondsSinceEpoch,
      });
      if (list.length > _maxEntries) list = list.sublist(0, _maxEntries);

      await _storage.write(key: key, value: jsonEncode(list));
      await _rememberKey(key);
    } catch (_) {
      // Non-critical.
    }
  }

  /// Returns this staff member's cached entries newest-first.
  static Future<List<Map<String, dynamic>>> getAll() async {
    try {
      final key = await _currentStorageKey();
      if (key == null) return const [];
      return _decodeList(await _storage.read(key: key));
    } catch (_) {
      return const [];
    }
  }

  /// Clears every local recent-patient cache, including the legacy plaintext
  /// SharedPreferences keys from before the M10 migration.
  ///
  /// Logout and idle-timeout use this broad wipe so shared tablets and
  /// workstations do not expose the previous staff member's local PHI context.
  static Future<void> clear() async {
    try {
      final currentKey = await _currentStorageKey();
      final rawIndex = await _storage.read(key: _indexKey);
      final keys = <String>{
        if (rawIndex != null && rawIndex.isNotEmpty)
          ...List<String>.from(jsonDecode(rawIndex) as List),
        ?currentKey,
      };
      for (final key in keys) {
        await _storage.delete(key: key);
      }
      await _storage.delete(key: _indexKey);

      await _purgeLegacyPlaintext();
    } catch (_) {
      // Non-critical.
    }
  }
}
