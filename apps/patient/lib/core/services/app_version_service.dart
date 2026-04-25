import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:vhhealth/core/config/api_config.dart';

/// Checks the backend for a newer app version and exposes the result.
///
/// Call [checkForUpdate] on app launch (fire-and-forget).
/// Read [hasUpdate] and [updateUrl] later to show an update prompt.
class AppVersionService {
  AppVersionService._();

  static String? _latestVersion;
  static String? _currentVersion;
  static String? _updateUrl;

  /// True if the backend reports a newer version than the running app.
  static bool get hasUpdate {
    if (_currentVersion == null || _latestVersion == null) return false;
    return _compareVersions(_latestVersion!, _currentVersion!) > 0;
  }

  static String? get updateUrl => _updateUrl;
  static String? get latestVersion => _latestVersion;

  /// Set the current running version (call from main.dart with package_info).
  static void setCurrentVersion(String version) {
    _currentVersion = version;
  }

  /// Fetch latest version info from the backend (non-blocking, best-effort).
  static Future<void> checkForUpdate() async {
    try {
      final uri = Uri.parse('${ApiConfig.baseUrl}/health/app-version');
      final response = await http.get(uri).timeout(const Duration(seconds: 5));
      if (response.statusCode == 200) {
        final body = jsonDecode(response.body);
        final data = body['data'] ?? body;
        _latestVersion =
            data['latestVersion'] as String? ??
            data['latest_version'] as String?;
        _updateUrl =
            data['updateUrl'] as String? ?? data['update_url'] as String?;
        if (kDebugMode) {
          debugPrint(
            'AppVersionService: current=$_currentVersion latest=$_latestVersion',
          );
        }
      }
    } catch (e) {
      if (kDebugMode) debugPrint('AppVersionService: check failed: $e');
    }
  }

  /// Compare two semver strings. Returns >0 if a > b, 0 if equal, <0 if a < b.
  static int _compareVersions(String a, String b) {
    final aParts = a.split('.').map((s) => int.tryParse(s) ?? 0).toList();
    final bParts = b.split('.').map((s) => int.tryParse(s) ?? 0).toList();
    for (var i = 0; i < 3; i++) {
      final av = i < aParts.length ? aParts[i] : 0;
      final bv = i < bParts.length ? bParts[i] : 0;
      if (av != bv) return av.compareTo(bv);
    }
    return 0;
  }
}
