/// Staff-specific API configuration.
///
/// Re-exports core's [ApiConfig] for baseUrl, apiKey, jsonHeaders, etc.
/// Adds staff-specific JWT and credential storage using separate keys
/// so staff and patient tokens never collide.
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:vhhealth_core/config/api_config.dart' as core;

export 'package:vhhealth_core/config/api_config.dart' hide ApiConfig;

class ApiConfig {
  ApiConfig._();

  static const _storage = FlutterSecureStorage();

  // ── Delegate shared config to core ─────────────────────────────────────
  static String get baseUrl => core.ApiConfig.baseUrl;
  static String get apiKey => core.ApiConfig.apiKey;
  static Map<String, String> get jsonHeaders => core.ApiConfig.jsonHeaders;

  // ── Staff-specific authenticated headers (uses staff_jwt key) ──────────
  static Future<Map<String, String>> authenticatedHeaders() async {
    final jwt = await _storage.read(key: 'staff_jwt');
    return {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      if (jwt != null) 'Authorization': 'Bearer $jwt',
    };
  }

  // ── Staff credential storage ───────────────────────────────────────────
  static Future<void> saveJwt(String jwt) async {
    await _storage.write(key: 'staff_jwt', value: jwt);
  }

  static Future<void> saveStaffId(String staffId) async {
    await _storage.write(key: 'staff_id', value: staffId);
  }

  static Future<String?> getStaffId() async {
    return await _storage.read(key: 'staff_id');
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
    final jwt = await _storage.read(key: 'staff_jwt');
    return jwt != null && jwt.isNotEmpty;
  }
}
