// Staff-specific API configuration.
//
// Re-exports core's [ApiConfig] for baseUrl, apiKey, jsonHeaders, etc.
// Adds staff-specific JWT and credential storage using separate keys
// so staff and patient tokens never collide.
import 'dart:convert';

import 'package:vhhealth_core/config/api_config.dart' as core;
import 'package:vhhealth_core/services/secure_storage.dart';

export 'package:vhhealth_core/config/api_config.dart' hide ApiConfig;

class ApiConfig {
  ApiConfig._();

  // All credential reads/writes route through the centralized encrypted store.
  static final _storage = VHSecureStorage.instance;

  // ── Delegate shared config to core ─────────────────────────────────────
  static String get baseUrl => core.ApiConfig.baseUrl;
  static String get apiKey => core.ApiConfig.apiKey;
  static Map<String, String> get jsonHeaders => core.ApiConfig.jsonHeaders;

  // ── Staff-specific authenticated headers (uses staff_jwt key) ──────────
  static Future<Map<String, String>> authenticatedHeaders() async {
    final jwt = await _storage.read(key: 'jwt');
    return {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      if (jwt != null) 'Authorization': 'Bearer $jwt',
    };
  }

  // ── Staff credential storage ───────────────────────────────────────────
  static Future<void> saveJwt(String jwt) async {
    await _storage.write(key: 'jwt', value: jwt);
  }

  static Future<void> saveStaffId(String staffId) async {
    await _storage.write(key: 'staff_id', value: staffId);
  }

  static Future<String?> getStaffId() async {
    return await _storage.read(key: 'staff_id');
  }

  static Future<void> saveStaffUid(String staffUid) async {
    await _storage.write(key: 'staff_uid', value: staffUid);
  }

  static Future<String?> getStaffUid() async {
    final stored = await _storage.read(key: 'staff_uid');
    if (stored != null && stored.trim().isNotEmpty) return stored.trim();

    final jwt = await _storage.read(key: 'jwt');
    final decoded = _staffUidFromJwt(jwt);
    if (decoded != null && decoded.isNotEmpty) {
      await saveStaffUid(decoded);
      return decoded;
    }
    return null;
  }

  static Future<void> saveEmployeeId(String employeeId) async {
    await _storage.write(key: 'employee_id', value: employeeId);
  }

  static Future<String?> getEmployeeId() async {
    return await _storage.read(key: 'employee_id');
  }

  static Future<void> saveRole(String role) async {
    await _storage.write(key: 'staff_role', value: role);
  }

  static Future<String> getRole() async {
    return await _storage.read(key: 'staff_role') ?? 'GENERAL_STAFF';
  }

  static Future<void> savePhone(String phone) async {
    await _storage.write(key: 'staff_phone', value: phone);
  }

  static Future<String?> getPhone() async {
    return await _storage.read(key: 'staff_phone');
  }

  static Future<void> clearAll() async {
    await _storage.deleteAll();
  }

  static Future<bool> isLoggedIn() async {
    try {
      final jwt = await _storage.read(key: 'jwt');
      if (jwt == null || jwt.isEmpty) return false;
      // Basic JWT shape: header.payload.signature with non-empty parts.
      // Without this, any non-empty garbage in storage (e.g. after a
      // FlutterSecureStorage bad-base64 / decrypt-failed event) was being
      // treated as a valid login → splash routed to /dashboard before the
      // user ever signed in.
      final parts = jwt.split('.');
      if (parts.length != 3 || parts.any((p) => p.isEmpty)) {
        await _storage.delete(key: 'jwt');
        return false;
      }
      return true;
    } catch (_) {
      // SecureStorage corruption / keystore error → log out for safety.
      try {
        await _storage.delete(key: 'jwt');
      } catch (_) {}
      return false;
    }
  }

  static String? _staffUidFromJwt(String? jwt) {
    try {
      if (jwt == null || jwt.isEmpty) return null;
      final parts = jwt.split('.');
      if (parts.length != 3 || parts[1].isEmpty) return null;
      final payload = jsonDecode(
        utf8.decode(base64Url.decode(base64Url.normalize(parts[1]))),
      );
      if (payload is! Map<String, dynamic>) return null;
      final staff = payload['staff'];
      for (final key in ['uid', 'user_uid', 'staff_uid', 'sub']) {
        final value = payload[key] ?? (staff is Map ? staff[key] : null);
        if (value != null && value.toString().trim().isNotEmpty) {
          return value.toString().trim();
        }
      }
    } catch (_) {
      return null;
    }
    return null;
  }
}
