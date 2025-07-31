// lib/core/services/shared_prefs_service.dart
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class SharedPrefsService {
  static const _tokenKey = 'auth_access_token';
  static const FlutterSecureStorage _secure = FlutterSecureStorage();

  static String? _cachedToken;

  /// Persist the token securely and cache it in RAM.
  static Future<void> saveToken(String token) async {
    _cachedToken = token;
    try {
      await _secure.write(key: _tokenKey, value: token);
    } catch (e) {
      // fallback: you may log or handle gracefully
    }
  }

  /// Fetch the token (RAM → secure storage → null).
  static Future<String?> getToken() async {
    if (_cachedToken != null) return _cachedToken;
    try {
      _cachedToken = await _secure.read(key: _tokenKey);
    } catch (_) {
      // ignore – will return null
    }
    return _cachedToken;
  }

  /// Wipe both the secure storage entry and the RAM cache.
  static Future<void> clearToken() async {
    _cachedToken = null;
    try {
      await _secure.delete(key: _tokenKey);
    } catch (_) {}
  }
}
