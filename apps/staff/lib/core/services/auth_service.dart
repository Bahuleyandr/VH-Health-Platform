import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import '../config/api_config.dart';
import 'api_client.dart';
import 'recent_patients_service.dart';

class AuthService {
  static const _storage = FlutterSecureStorage();

  /// Staff login with employee ID + password
  static Future<Map<String, dynamic>> login({
    required String employeeId,
    required String password,
  }) async {
    final response = await ApiClient.post(
      '/auth/staff/login',
      body: {'employeeId': employeeId, 'password': password},
    );

    if (response.isSuccess && response.raw is Map) {
      final raw = response.raw as Map<String, dynamic>;
      if (raw['success'] == true) {
        final data = raw['data'] as Map<String, dynamic>? ?? {};
        final token = data['accessToken'] ?? data['token'] ?? data['jwt'];
        if (token != null) {
          await ApiConfig.saveJwt(token.toString());
          await ApiConfig.saveEmployeeId(employeeId);

          final staffId =
              data['staff']?['_id'] ?? data['staff']?['id'] ?? data['uid'];
          if (staffId != null) {
            await ApiConfig.saveStaffId(staffId.toString());
          }

          // Save staff role for role-based feature access
          final role =
              data['staff']?['role'] ?? data['role'] ?? 'GENERAL_STAFF';
          await ApiConfig.saveRole(role.toString());

          // Save phone if available (needed for device/notification registration)
          final phone = data['staff']?['phone'] ?? data['phone'];
          if (phone != null) await ApiConfig.savePhone(phone.toString());
        }
        return data.isNotEmpty ? data : raw;
      }
    }
    throw Exception(response.message ?? 'Login failed');
  }

  /// Staff PIN login
  static Future<Map<String, dynamic>> pinLogin({
    required String employeeId,
    required String pin,
  }) async {
    final response = await ApiClient.post(
      '/auth/staff/login-pin',
      body: {'employeeId': employeeId, 'pin': pin},
    );

    if (response.isSuccess && response.raw is Map) {
      final raw = response.raw as Map<String, dynamic>;
      if (raw['success'] == true) {
        final data = raw['data'] as Map<String, dynamic>? ?? {};
        final token = data['accessToken'] ?? data['token'] ?? data['jwt'];
        if (token != null) {
          await ApiConfig.saveJwt(token.toString());
          await ApiConfig.saveEmployeeId(employeeId);

          final staffId =
              data['staff']?['_id'] ?? data['staff']?['id'] ?? data['uid'];
          if (staffId != null) {
            await ApiConfig.saveStaffId(staffId.toString());
          }

          // Save staff role for role-based feature access
          final role =
              data['staff']?['role'] ?? data['role'] ?? 'GENERAL_STAFF';
          await ApiConfig.saveRole(role.toString());

          // Save phone if available (needed for device/notification registration)
          final phone = data['staff']?['phone'] ?? data['phone'];
          if (phone != null) await ApiConfig.savePhone(phone.toString());
        }
        return data.isNotEmpty ? data : raw;
      }
    }
    throw Exception(response.message ?? 'PIN login failed');
  }

  /// Logout — clears all local credentials
  static Future<void> logout() async {
    try {
      await ApiClient.post('/auth/staff/logout', body: {});
    } catch (e) {
      debugPrint('AuthService.logout error: $e');
      // Best effort
    } finally {
      await ApiConfig.clearAll();
      // Clear local-only EMR caches so the next staff member to log in
      // on a shared workstation doesn't see the previous user's recent
      // patients (privacy concern on ward kiosks).
      await RecentPatientsService.clear();
    }
  }

  static Future<bool> isLoggedIn() => ApiConfig.isLoggedIn();
  static Future<String?> getStaffId() => ApiConfig.getStaffId();
  static Future<String?> getEmployeeId() => ApiConfig.getEmployeeId();
  static Future<String> getRole() => ApiConfig.getRole();
  static Future<void> setRole(String role) => ApiConfig.saveRole(role);

  /// Quick login via PIN/biometric for registered devices
  static Future<Map<String, dynamic>> quickLogin({
    required String employeeId,
    String? pin,
    String? biometricToken,
    String? deviceToken,
  }) async {
    final response = await ApiClient.post(
      '/auth/staff/quick-login',
      body: {
        'employeeId': employeeId,
        'pin': ?pin,
        'biometricToken': ?biometricToken,
        'deviceToken': ?deviceToken,
      },
    );

    if (response.isSuccess && response.raw is Map) {
      final raw = response.raw as Map<String, dynamic>;
      if (raw['success'] == true) {
        final data = raw['data'] as Map<String, dynamic>? ?? {};
        final token = data['accessToken'] ?? data['token'] ?? data['jwt'];
        if (token != null) {
          await ApiConfig.saveJwt(token.toString());
          await ApiConfig.saveEmployeeId(employeeId);

          final staffId =
              data['staff']?['_id'] ?? data['staff']?['id'] ?? data['uid'];
          if (staffId != null) {
            await ApiConfig.saveStaffId(staffId.toString());
          }

          final role =
              data['staff']?['role'] ?? data['role'] ?? 'GENERAL_STAFF';
          await ApiConfig.saveRole(role.toString());
        }
        return data.isNotEmpty ? data : raw;
      }
    }
    throw Exception(response.message ?? 'Quick login failed');
  }

  /// Check if device is registered for quick login
  static Future<bool> isDeviceRegistered() async {
    final deviceToken = await _storage.read(key: 'device_token');
    return deviceToken != null && deviceToken.isNotEmpty;
  }

  /// Save device token locally
  static Future<void> saveDeviceToken(String token) async {
    await _storage.write(key: 'device_token', value: token);
  }

  /// Get saved device token
  static Future<String?> getDeviceToken() async {
    return await _storage.read(key: 'device_token');
  }

  static Future<Map<String, String>?> getSavedCredentials() async {
    final employeeId = await _storage.read(key: 'employee_id');
    return employeeId != null ? {'employeeId': employeeId} : null;
  }
}
