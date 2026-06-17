import 'package:flutter/foundation.dart';
import 'package:vhhealth_core/services/auth_service.dart' as core_auth;
import 'package:vhhealth_core/services/connectivity_sync_service.dart';
import 'package:vhhealth_core/services/crash_reporter.dart';
import 'package:vhhealth_core/services/secure_storage.dart';
import '../config/api_config.dart';
import '../platform_info.dart';
import 'api_client.dart';
import 'recent_patients_service.dart';
import 'telemetry_service.dart';

class AuthService {
  // Centralized encrypted storage — same instance as api_config.dart and core.
  static final _storage = VHSecureStorage.instance;

  static Future<void> _saveAuthenticatedStaffSession({
    required String employeeId,
    required Map<String, dynamic> data,
    required String loginMethod,
  }) async {
    final token = data['accessToken'] ?? data['token'] ?? data['jwt'];
    if (token == null) return;

    final refreshToken = data['refreshToken'];
    await core_auth.AuthService.setTokens(
      accessToken: token.toString(),
      refreshToken: refreshToken?.toString(),
    );
    await ApiConfig.saveEmployeeId(employeeId);

    final staffId =
        data['staff']?['_id'] ?? data['staff']?['id'] ?? data['staff_id'];
    if (staffId != null) {
      await ApiConfig.saveStaffId(staffId.toString());
    }

    final staffUid =
        data['staff']?['uid'] ??
        data['staff']?['user_uid'] ??
        data['staff_uid'] ??
        data['uid'];
    if (staffUid != null) {
      await ApiConfig.saveStaffUid(staffUid.toString());
      if (staffId == null) await ApiConfig.saveStaffId(staffUid.toString());
    }

    final role = data['staff']?['role'] ?? data['role'] ?? 'GENERAL_STAFF';
    await ApiConfig.saveRole(role.toString());

    final phone = data['staff']?['phone'] ?? data['phone'];
    if (phone != null) await ApiConfig.savePhone(phone.toString());

    await Telemetry.setUserProperties(role: role.toString());
    await Telemetry.event('auth.login_success', {
      'role': role.toString(),
      'method': loginMethod,
    });

    final crashUserId =
        staffUid?.toString() ?? staffId?.toString() ?? employeeId;
    await CrashReporter.instance.setUserId(crashUserId);
    await CrashReporter.instance.setCustomKey('role', role.toString());
    await CrashReporter.instance.setCustomKey('device_type', currentDeviceType);
  }

  /// Staff login with employee ID + password
  static Future<Map<String, dynamic>> login({
    required String employeeId,
    required String password,
  }) async {
    final response = await ApiClient.post(
      '/auth/staff/login',
      auth: false,
      body: {
        'employeeId': employeeId,
        'password': password,
        // Pinned by platform — the backend uses this to (1) restrict
        // attendance-marking to phone-class clients, and (2) record the
        // device class in user_active_sessions for the new-login-evicts-
        // old-session policy.
        'deviceType': currentDeviceType,
      },
    );

    if (response.isSuccess && response.raw is Map) {
      final raw = response.raw as Map<String, dynamic>;
      if (raw['success'] == true) {
        final data = raw['data'] as Map<String, dynamic>? ?? {};
        await _saveAuthenticatedStaffSession(
          employeeId: employeeId,
          data: data,
          loginMethod: 'password',
        );
        return data.isNotEmpty ? data : raw;
      }
    }
    throw Exception(response.message ?? 'Login failed');
  }

  /// Staff PIN login.
  ///
  /// Audit finding M5: PIN login is bound to a registered device — the
  /// backend rejects PIN attempts without the deviceToken issued at
  /// /register-device (code PIN_DEVICE_NOT_REGISTERED). Callers should fall
  /// back to password login when no device token is stored.
  static Future<Map<String, dynamic>> pinLogin({
    required String employeeId,
    required String pin,
  }) async {
    final deviceToken = await getDeviceToken();
    final response = await ApiClient.post(
      '/auth/staff/login-pin',
      auth: false,
      body: {
        'employeeId': employeeId,
        'pin': pin,
        'deviceType': currentDeviceType,
        'deviceToken': ?deviceToken,
      },
    );

    if (response.isSuccess && response.raw is Map) {
      final raw = response.raw as Map<String, dynamic>;
      if (raw['success'] == true) {
        final data = raw['data'] as Map<String, dynamic>? ?? {};
        await _saveAuthenticatedStaffSession(
          employeeId: employeeId,
          data: data,
          loginMethod: 'pin',
        );
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
      // Clear local-only EMR caches so the next staff member to log in
      // on a shared workstation doesn't see the previous user's recent
      // patients (privacy concern on ward kiosks).
      await RecentPatientsService.clear();
      // Clear the offline write-queue too — on a shared ward tablet the
      // queue holds the previous user's pending clinical writes (vitals,
      // nursing notes); leaving it would let the next user drain them.
      try {
        await ConnectivitySyncService.instance.clearQueue();
      } catch (e) {
        debugPrint('AuthService.logout: offline queue clear failed: $e');
      }
      await ApiConfig.clearAll();
      await Telemetry.event('auth.logout');
      await CrashReporter.instance.setUserId(null);
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
      auth: false,
      body: {
        'employeeId': employeeId,
        'pin': ?pin,
        'biometricToken': ?biometricToken,
        'deviceToken': ?deviceToken,
        'deviceType': currentDeviceType,
      },
    );

    if (response.isSuccess && response.raw is Map) {
      final raw = response.raw as Map<String, dynamic>;
      if (raw['success'] == true) {
        final data = raw['data'] as Map<String, dynamic>? ?? {};
        await _saveAuthenticatedStaffSession(
          employeeId: employeeId,
          data: data,
          loginMethod: 'quick',
        );
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
