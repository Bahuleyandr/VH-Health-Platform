import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Shared JWT and user session storage for VHHealth apps.
class AuthService {
  static const _storage = FlutterSecureStorage();

  // ── JWT (access token) ───────────────────────────────────────────────────
  static Future<String?> getJwt() => _storage.read(key: 'jwt');
  static Future<void> setJwt(String token) =>
      _storage.write(key: 'jwt', value: token);
  static Future<void> clearJwt() => _storage.delete(key: 'jwt');

  // ── Refresh token (staff path; optional for patient/admin) ───────────────
  static Future<String?> getRefreshToken() =>
      _storage.read(key: 'refreshToken');
  static Future<void> setRefreshToken(String token) =>
      _storage.write(key: 'refreshToken', value: token);
  static Future<void> clearRefreshToken() =>
      _storage.delete(key: 'refreshToken');

  /// Persist an access token plus optional refresh token in one call.
  static Future<void> setTokens({
    required String accessToken,
    String? refreshToken,
  }) async {
    await setJwt(accessToken);
    if (refreshToken != null && refreshToken.isNotEmpty) {
      await setRefreshToken(refreshToken);
    }
  }

  // ── Phone ────────────────────────────────────────────────────────────────
  static Future<String?> getUserPhone() => _storage.read(key: 'userPhone');
  static Future<void> setUserPhone(String phone) =>
      _storage.write(key: 'userPhone', value: phone);

  // ── Role (patient | staff | admin) ───────────────────────────────────────
  static Future<String?> getUserRole() => _storage.read(key: 'userRole');
  static Future<void> setUserRole(String role) =>
      _storage.write(key: 'userRole', value: role);

  // ── Employee ID (staff app) ───────────────────────────────────────────────
  static Future<String?> getEmployeeId() => _storage.read(key: 'employeeId');
  static Future<void> setEmployeeId(String id) =>
      _storage.write(key: 'employeeId', value: id);

  // ── Staff ID (internal DB id) ───────────────────────────────────────────
  static Future<String?> getStaffId() => _storage.read(key: 'staffId');
  static Future<void> setStaffId(String id) =>
      _storage.write(key: 'staffId', value: id);

  // ── Login check ──────────────────────────────────────────────────────────
  static Future<bool> isLoggedIn() async {
    final jwt = await getJwt();
    return jwt != null && jwt.isNotEmpty;
  }

  // ── Clear everything ─────────────────────────────────────────────────────
  static Future<void> clearAll() async {
    await _storage.deleteAll();
  }
}
