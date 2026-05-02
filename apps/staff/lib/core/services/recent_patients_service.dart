import 'dart:convert';
import 'package:shared_preferences/shared_preferences.dart';

/// Simple local-only cache of the last few patients the staff member
/// has opened in the EMR. Persisted via SharedPreferences so it
/// survives app restarts and re-logins on the same device.
///
/// Used by the dashboard's "Recent patients" tile to give doctors and
/// nurses a one-tap way back to the patient they were just looking at.
/// The classic round flow is: round → consult → write note → move on
/// → realize you forgot something → and the next thing you want is
/// THAT patient again. Searching for them takes 4–5 taps; this list
/// makes it 1.
///
/// Stored shape (JSON in `recent_patients` key):
/// ```
/// [
///   { "uid": "uuid", "name": "...", "ts": <epoch ms> },
///   ...
/// ]
/// ```
class RecentPatientsService {
  RecentPatientsService._();

  static const _key = 'recent_patients';
  static const _maxEntries = 5;

  /// Records [uid] + [name] as the most-recently-viewed patient.
  /// Dedupes by uid (moves an existing entry to the top), trims to
  /// [_maxEntries]. Best-effort — silently swallows storage errors so
  /// EMR navigation never breaks because of a recents write hiccup.
  static Future<void> add(String uid, String? name) async {
    try {
      if (uid.isEmpty) return;
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_key);
      List<Map<String, dynamic>> list = const [];
      if (raw != null && raw.isNotEmpty) {
        final decoded = jsonDecode(raw);
        if (decoded is List) {
          list = decoded.whereType<Map>().map((e) {
            return e.map((k, v) => MapEntry(k.toString(), v));
          }).toList();
        }
      }
      list.removeWhere((e) => e['uid'] == uid);
      list.insert(0, {
        'uid': uid,
        'name': (name ?? '').trim().isEmpty ? 'Patient' : name!.trim(),
        'ts': DateTime.now().millisecondsSinceEpoch,
      });
      if (list.length > _maxEntries) list = list.sublist(0, _maxEntries);
      await prefs.setString(_key, jsonEncode(list));
    } catch (_) {
      // Non-critical.
    }
  }

  /// Returns the cached entries newest-first. Empty list when nothing
  /// recorded or storage read fails.
  static Future<List<Map<String, dynamic>>> getAll() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_key);
      if (raw == null || raw.isEmpty) return const [];
      final decoded = jsonDecode(raw);
      if (decoded is! List) return const [];
      return decoded.whereType<Map>().map((e) {
        return e.map((k, v) => MapEntry(k.toString(), v));
      }).toList();
    } catch (_) {
      return const [];
    }
  }

  /// Clear the cache — used by logout.
  static Future<void> clear() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.remove(_key);
    } catch (_) {}
  }
}
