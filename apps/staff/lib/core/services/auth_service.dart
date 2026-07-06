import 'package:flutter/foundation.dart';
import 'package:flutter_web_auth_2/flutter_web_auth_2.dart';
import 'package:vhhealth_core/services/auth_service.dart' as core_auth;
import 'package:vhhealth_core/services/connectivity_sync_service.dart';
import 'package:vhhealth_core/services/crash_reporter.dart';
import 'package:vhhealth_core/services/secure_storage.dart';
import '../config/api_config.dart';
import '../platform_info.dart';
import 'api_client.dart';
import 'recent_patients_service.dart';
import 'telemetry_service.dart';

class StaffSsoProvider {
  const StaffSsoProvider({
    required this.providerKey,
    required this.displayName,
    required this.startUrl,
    required this.redirectUris,
  });

  final String providerKey;
  final String displayName;
  final String startUrl;
  final List<String> redirectUris;

  factory StaffSsoProvider.fromJson(Map<String, dynamic> json) {
    return StaffSsoProvider(
      providerKey: (json['provider_key'] ?? json['providerKey'] ?? '')
          .toString(),
      displayName: (json['display_name'] ?? json['displayName'] ?? 'SSO')
          .toString(),
      startUrl: (json['start_url'] ?? json['startUrl'] ?? '').toString(),
      redirectUris: (json['redirect_uris'] is List)
          ? (json['redirect_uris'] as List)
                .map((value) => value.toString())
                .where((value) => value.trim().isNotEmpty)
                .toList()
          : const [],
    );
  }
}

typedef StaffSsoBrowser =
    Future<String> Function({
      required String url,
      required String callbackUrlScheme,
    });

class AuthService {
  // Centralized encrypted storage — same instance as api_config.dart and core.
  static final _storage = VHSecureStorage.instance;
  static const _staffSsoCallbackScheme = 'vhhealthstaff';
  static const _staffSsoCallbackUri = 'vhhealthstaff://sso/oidc/callback';

  @visibleForTesting
  static StaffSsoBrowser? debugStaffSsoBrowser;

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
    await ApiConfig.saveJwt(token.toString());
    if (employeeId.trim().isNotEmpty) {
      await ApiConfig.saveEmployeeId(employeeId);
    }

    final staffId =
        data['staff']?['_id'] ?? data['staff']?['id'] ?? data['staff_id'];
    if (staffId != null) {
      await ApiConfig.saveStaffId(staffId.toString());
      await core_auth.AuthService.setStaffId(staffId.toString());
    }

    final staffUid =
        data['staff']?['uid'] ??
        data['staff']?['user_uid'] ??
        data['staff_uid'] ??
        data['uid'];
    if (staffUid != null) {
      await ApiConfig.saveStaffUid(staffUid.toString());
      if (staffId == null) {
        await ApiConfig.saveStaffId(staffUid.toString());
        await core_auth.AuthService.setStaffId(staffUid.toString());
      }
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

  static Map<String, dynamic> _successData(ApiResponse response, String label) {
    if (response.isSuccess && response.raw is Map) {
      final raw = Map<String, dynamic>.from(response.raw as Map);
      if (raw['success'] == true && raw['data'] is Map) {
        return Map<String, dynamic>.from(raw['data'] as Map);
      }
      return raw;
    }
    throw Exception(response.failureMessage(label));
  }

  static String _staffEmployeeIdFromData(Map<String, dynamic> data) {
    final staff = data['staff'];
    final value =
        data['employeeId'] ??
        data['employee_id'] ??
        (staff is Map ? staff['employeeId'] ?? staff['employee_id'] : null);
    return value?.toString().trim() ?? '';
  }

  static String _ssoRedirectUriFor(StaffSsoProvider provider) {
    return provider.redirectUris.firstWhere(
      (uri) => uri.startsWith('$_staffSsoCallbackScheme://'),
      orElse: () => provider.redirectUris.isNotEmpty
          ? provider.redirectUris.first
          : _staffSsoCallbackUri,
    );
  }

  static Future<String> _openStaffSsoBrowser({
    required String url,
    required String callbackUrlScheme,
  }) {
    final browser = debugStaffSsoBrowser;
    if (browser != null) {
      return browser(url: url, callbackUrlScheme: callbackUrlScheme);
    }
    return FlutterWebAuth2.authenticate(
      url: url,
      callbackUrlScheme: callbackUrlScheme,
      options: const FlutterWebAuth2Options(useWebview: false),
    );
  }

  static Future<List<StaffSsoProvider>> discoverStaffSsoProviders() async {
    final response = await ApiClient.get(
      '/auth/staff/sso/oidc/providers',
      auth: false,
    );
    final data = _successData(response, 'Staff SSO discovery failed');
    final providers = data['providers'];
    if (providers is! List) return const [];
    return providers
        .whereType<Map>()
        .map(
          (provider) =>
              StaffSsoProvider.fromJson(Map<String, dynamic>.from(provider)),
        )
        .where(
          (provider) =>
              provider.providerKey.isNotEmpty && provider.startUrl.isNotEmpty,
        )
        .toList();
  }

  static Future<Map<String, dynamic>> loginWithStaffSso(
    StaffSsoProvider provider,
  ) async {
    final redirectUri = _ssoRedirectUriFor(provider);
    final deviceToken = await getDeviceToken();
    final startResponse = await ApiClient.get(
      '/auth/staff/sso/oidc/${Uri.encodeComponent(provider.providerKey)}/start',
      auth: false,
      queryParameters: {
        'response_mode': 'json',
        'redirect_uri': redirectUri,
        'deviceType': currentDeviceType,
        if (deviceToken != null && deviceToken.isNotEmpty)
          'deviceId': deviceToken,
      },
    );
    final startData = _successData(
      startResponse,
      'Staff SSO authorization failed',
    );
    final authorizationUrl = startData['redirectUrl']?.toString();
    if (authorizationUrl == null || authorizationUrl.isEmpty) {
      throw Exception('Staff SSO authorization URL missing');
    }

    final callback = Uri.parse(
      await _openStaffSsoBrowser(
        url: authorizationUrl,
        callbackUrlScheme: Uri.parse(redirectUri).scheme,
      ),
    );
    final error = callback.queryParameters['error'];
    if (error != null && error.isNotEmpty) {
      throw Exception(callback.queryParameters['error_description'] ?? error);
    }
    final code = callback.queryParameters['code'];
    final state = callback.queryParameters['state'];
    if (code == null || code.isEmpty || state == null || state.isEmpty) {
      throw Exception('Staff SSO callback missing code or state');
    }

    final callbackResponse = await ApiClient.post(
      '/auth/staff/sso/oidc/${Uri.encodeComponent(provider.providerKey)}/callback',
      auth: false,
      body: {
        'code': code,
        'state': state,
        'redirect_uri': redirectUri,
        'deviceType': currentDeviceType,
        if (deviceToken != null && deviceToken.isNotEmpty)
          'deviceId': deviceToken,
      },
    );
    final data = _successData(callbackResponse, 'Staff SSO login failed');
    await _saveAuthenticatedStaffSession(
      employeeId: _staffEmployeeIdFromData(data),
      data: data,
      loginMethod: 'sso_oidc',
    );
    return data;
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
    throw Exception(response.failureMessage('Login failed'));
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
    throw Exception(response.failureMessage('PIN login failed'));
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
    throw Exception(response.failureMessage('Quick login failed'));
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
