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
  static Future<void> _mutationTail = Future<void>.value();
  static int _sessionGeneration = 0;
  static bool _writesBlocked = false;

  @visibleForTesting
  static String? debugStaffIdentityOverride;

  @visibleForTesting
  static Future<void> Function()? debugBeforeWrite;

  @visibleForTesting
  static Future<void> Function()? debugBeforeClear;

  /// Opens the cache for a newly persisted authenticated session.
  ///
  /// Logout blocks writes synchronously before its asynchronous purge begins.
  /// The next successful login is the only event that may reopen them. This
  /// closes the window where a screen disposed during logout could enqueue a
  /// write using the previous staff identity.
  static void beginSession() {
    _sessionGeneration += 1;
    _writesBlocked = false;
  }

  static Future<void> _serialize(Future<void> Function() operation) {
    final scheduled = _mutationTail.then((_) => operation());
    _mutationTail = scheduled.then<void>(
      (_) {},
      onError: (Object _, StackTrace _) {},
    );
    return scheduled;
  }

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
    final keys = _decodeIndex(rawIndex).toList();
    if (keys.contains(key)) return;
    await _storage.write(key: _indexKey, value: jsonEncode([...keys, key]));
  }

  static Set<String> _decodeIndex(String? raw) {
    if (raw == null || raw.isEmpty) return <String>{};
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! List) return <String>{};
      return decoded
          .whereType<String>()
          .where((key) => key.startsWith(_keyPrefix))
          .toSet();
    } catch (_) {
      return <String>{};
    }
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
  static Future<void> add(String uid, String? name) {
    if (uid.isEmpty || _writesBlocked) return Future<void>.value();
    final generation = _sessionGeneration;
    return _serialize(() async {
      try {
        if (_writesBlocked || generation != _sessionGeneration) return;
        if (uid.isEmpty) return;
        final key = await _currentStorageKey();
        if (key == null || _writesBlocked || generation != _sessionGeneration) {
          return;
        }

        await _purgeLegacyPlaintext();
        if (_writesBlocked || generation != _sessionGeneration) return;

        var list = _decodeList(await _storage.read(key: key));
        list.removeWhere((entry) => entry['uid'] == uid);
        list.insert(0, {
          'uid': uid,
          'name': (name ?? '').trim().isEmpty ? 'Patient' : name!.trim(),
          'ts': DateTime.now().millisecondsSinceEpoch,
        });
        if (list.length > _maxEntries) list = list.sublist(0, _maxEntries);

        final beforeWrite = debugBeforeWrite;
        if (beforeWrite != null) await beforeWrite();
        if (_writesBlocked || generation != _sessionGeneration) return;
        await _storage.write(key: key, value: jsonEncode(list));
        if (_writesBlocked || generation != _sessionGeneration) return;
        await _rememberKey(key);
      } catch (_) {
        // Non-critical.
      }
    });
  }

  /// Returns this staff member's cached entries newest-first.
  static Future<List<Map<String, dynamic>>> getAll() async {
    try {
      if (_writesBlocked) return const [];
      await _mutationTail;
      if (_writesBlocked) return const [];
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
  static Future<void> clear() {
    if (_writesBlocked) return _mutationTail;
    _writesBlocked = true;
    _sessionGeneration += 1;
    return _serialize(() async {
      try {
        final beforeClear = debugBeforeClear;
        if (beforeClear != null) await beforeClear();
        final currentKey = await _currentStorageKey();
        final rawIndex = await _storage.read(key: _indexKey);
        final keys = <String>{..._decodeIndex(rawIndex), ?currentKey};
        for (final key in keys) {
          try {
            await _storage.delete(key: key);
          } catch (_) {
            // Continue purging the remaining owner keys.
          }
        }
        try {
          await _storage.delete(key: _indexKey);
        } catch (_) {
          // The current-owner delete above remains authoritative.
        }

        await _purgeLegacyPlaintext();
      } catch (_) {
        // Non-critical.
      }
    });
  }

  @visibleForTesting
  static Future<void> resetForTesting() async {
    await _mutationTail;
    _mutationTail = Future<void>.value();
    _sessionGeneration = 0;
    _writesBlocked = false;
    debugStaffIdentityOverride = null;
    debugBeforeWrite = null;
    debugBeforeClear = null;
  }
}
