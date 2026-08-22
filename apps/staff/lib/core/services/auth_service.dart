import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_web_auth_2/flutter_web_auth_2.dart';
import 'package:vhhealth_core/services/auth_service.dart' as core_auth;
import 'package:vhhealth_core/services/connectivity_sync_service.dart';
import 'package:vhhealth_core/services/crash_reporter.dart';
import 'package:vhhealth_core/services/realtime_client.dart';
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

typedef StaffSsoBrowser = Future<String> Function({
  required String url,
  required String callbackUrlScheme,
});
typedef StaffPreLogoutCleanup = Future<void> Function();

enum StaffLogoutStatus { blocked, signedOut }

@immutable
class StaffLogoutResult {
  const StaffLogoutResult._({
    required this.status,
    required this.blockingWriteCount,
    this.serverRevocationFailed = false,
    this.notificationTeardownFailed = false,
  });

  const StaffLogoutResult.blocked(int count)
    : this._(status: StaffLogoutStatus.blocked, blockingWriteCount: count);

  const StaffLogoutResult.signedOut({
    bool serverRevocationFailed = false,
    bool notificationTeardownFailed = false,
  }) : this._(
         status: StaffLogoutStatus.signedOut,
         blockingWriteCount: 0,
         serverRevocationFailed: serverRevocationFailed,
         notificationTeardownFailed: notificationTeardownFailed,
       );

  final StaffLogoutStatus status;
  final int blockingWriteCount;

  /// True when local sign-out completed but the backend never confirmed it
  /// revoked this device's session token, so the bearer token may still be
  /// usable until it expires.
  final bool serverRevocationFailed;
  final bool notificationTeardownFailed;

  bool get isBlocked => status == StaffLogoutStatus.blocked;
  bool get isSignedOut => status == StaffLogoutStatus.signedOut;
}

class AuthService {
  // Centralized encrypted storage — same instance as api_config.dart and core.
  static final _storage = VHSecureStorage.instance;
  static const _staffSsoCallbackScheme = 'vhhealthstaff';
  static const _staffSsoCallbackUri = 'vhhealthstaff://sso/oidc/callback';

  @visibleForTesting
  static StaffSsoBrowser? debugStaffSsoBrowser;

  @visibleForTesting
  static bool debugDisablePostLoginSync = false;

  static Future<void> _saveAuthenticatedStaffSession({
    required String employeeId,
    required Map<String, dynamic> data,
    required String loginMethod,
    String? trustedDeviceToken,
    bool rememberEmployeeId = true,
  }) async {
    final token = data['accessToken'] ?? data['token'] ?? data['jwt'];
    if (token == null) return;
    final staffId = _nonEmptyString(
      data['staff']?['_id'] ?? data['staff']?['id'] ?? data['staff_id'],
    );
    final staffUid = _nonEmptyString(
      data['staff']?['uid'] ??
          data['staff']?['user_uid'] ??
          data['staff_uid'] ??
          data['uid'],
    );
    if (staffId == null && staffUid == null) {
      throw StateError('Authenticated staff identity is missing.');
    }

    final syncService = ConnectivitySyncService.instance;
    await syncService.beginSessionBarrier();
    try {
      await ApiConfig.clearSessionIdentity();
      final refreshToken = data['refreshToken'];
      await core_auth.AuthService.setTokens(
        accessToken: token.toString(),
        refreshToken: refreshToken?.toString(),
      );
      await ApiConfig.saveJwt(token.toString());
      // "Remember my Employee ID" honors the shared-ward-device concern:
      // when the user opts out, the ID is never persisted, so the next
      // launch's login screen starts blank. clearSessionIdentity() above
      // already wiped any previously remembered ID, so opting out also
      // clears an older remembered value.
      if (rememberEmployeeId && employeeId.trim().isNotEmpty) {
        await ApiConfig.saveEmployeeId(employeeId);
      }

      if (staffId != null) {
        await ApiConfig.saveStaffId(staffId);
        await core_auth.AuthService.setStaffId(staffId);
      }

      if (staffUid != null) {
        await ApiConfig.saveStaffUid(staffUid);
        if (staffId == null) {
          await ApiConfig.saveStaffId(staffUid);
          await core_auth.AuthService.setStaffId(staffUid);
        }
      }

      final role = data['staff']?['role'] ?? data['role'] ?? 'GENERAL_STAFF';
      await ApiConfig.saveRole(role.toString());

      final phone = data['staff']?['phone'] ?? data['phone'];
      if (phone != null) await ApiConfig.savePhone(phone.toString());

      // Department drives the specialty-module tile filter (dental/oncology/
      // radiation-oncology/ophthalmology/transplant). Absent = no specialty
      // match, mirroring the server gate's fail-closed enforce semantics.
      final department = data['staff']?['department'] ?? data['department'];
      if (department != null && department.toString().trim().isNotEmpty) {
        await ApiConfig.saveDepartment(department.toString());
      }

      if (trustedDeviceToken != null) {
        await saveDeviceToken(trustedDeviceToken);
      }

      await Telemetry.setUserProperties(role: role.toString());
      await Telemetry.event('auth.login_success', {
        'role': role.toString(),
        'method': loginMethod,
      });

      final crashUserId = staffUid ?? staffId ?? employeeId;
      await CrashReporter.instance.setUserId(crashUserId);
      await CrashReporter.instance.setCustomKey('role', role.toString());
      await CrashReporter.instance.setCustomKey(
        'device_type',
        currentDeviceType,
      );
      RecentPatientsService.beginSession();
    } catch (_) {
      await ApiConfig.clearSessionIdentity();
      if (trustedDeviceToken != null) {
        await clearDeviceToken();
      }
      rethrow;
    } finally {
      syncService.endSessionBarrier();
    }
    if (debugDisablePostLoginSync) return;
    unawaited(
      syncService.syncPending().catchError((Object error, StackTrace stack) {
        if (kDebugMode) {
          debugPrint('AuthService: post-login offline sync failed: $error');
        }
      }),
    );
  }

  static String? _nonEmptyString(Object? value) {
    final text = value?.toString().trim();
    return text == null || text.isEmpty ? null : text;
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
    StaffSsoProvider provider, {
    bool rememberEmployeeId = true,
  }) async {
    final redirectUri = _ssoRedirectUriFor(provider);
    final installationId =
        await core_auth.AuthService.getOrCreateInstallationId();
    final startResponse = await ApiClient.get(
      '/auth/staff/sso/oidc/${Uri.encodeComponent(provider.providerKey)}/start',
      auth: false,
      queryParameters: {
        'response_mode': 'json',
        'redirect_uri': redirectUri,
        'deviceType': currentDeviceType,
        'deviceId': installationId,
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
        'deviceId': installationId,
      },
    );
    final data = _successData(callbackResponse, 'Staff SSO login failed');
    await _saveAuthenticatedStaffSession(
      employeeId: _staffEmployeeIdFromData(data),
      data: data,
      loginMethod: 'sso_oidc',
      rememberEmployeeId: rememberEmployeeId,
    );
    return data;
  }

  /// Staff login with employee ID + password
  static Future<Map<String, dynamic>> login({
    required String employeeId,
    required String password,
    bool rememberEmployeeId = true,
  }) async {
    final installationId =
        await core_auth.AuthService.getOrCreateInstallationId();
    final response = await ApiClient.post(
      '/auth/staff/register-device',
      auth: false,
      body: {
        'employeeId': employeeId,
        'password': password,
        'installationId': installationId,
        'deviceInfo': {
          'deviceId': installationId,
          'deviceName': 'VH Health Staff (${defaultTargetPlatform.name})',
          'platform': _platformName,
          'type': currentDeviceType,
        },
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
        final deviceToken = _nonEmptyString(data['deviceToken']);
        if (deviceToken == null) {
          throw StateError(
            'Device registration did not return a device token.',
          );
        }
        await _saveAuthenticatedStaffSession(
          employeeId: employeeId,
          data: data,
          loginMethod: 'password',
          trustedDeviceToken: deviceToken,
          rememberEmployeeId: rememberEmployeeId,
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
    bool rememberEmployeeId = true,
  }) async {
    final deviceToken = await getDeviceToken();
    if (deviceToken == null || deviceToken.trim().isEmpty) {
      throw StateError(
        'This device is not registered. Sign in with your password first.',
      );
    }
    final installationId =
        await core_auth.AuthService.getOrCreateInstallationId();
    final response = await ApiClient.post(
      '/auth/staff/login-pin',
      auth: false,
      body: {
        'employeeId': employeeId,
        'pin': pin,
        'deviceType': currentDeviceType,
        'deviceToken': deviceToken,
        'installationId': installationId,
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
          rememberEmployeeId: rememberEmployeeId,
        );
        return data.isNotEmpty ? data : raw;
      }
    }
    throw Exception(response.failureMessage('PIN login failed'));
  }

  /// Attempts an ordinary logout after closing the offline-write session
  /// barrier and authoritatively rechecking the current owner's queue.
  static Future<StaffLogoutResult> logout({
    StaffPreLogoutCleanup? beforeSessionRevocation,
  }) async {
    final syncService = ConnectivitySyncService.instance;
    await syncService.beginSessionBarrier();
    try {
      final blockingCount = await syncService
          .blockingWriteCountForCurrentOwner();
      if (blockingCount > 0) {
        return StaffLogoutResult.blocked(blockingCount);
      }

      var notificationTeardownFailed = false;
      if (beforeSessionRevocation != null) {
        try {
          await beforeSessionRevocation();
        } catch (e) {
          notificationTeardownFailed = true;
          debugPrint('AuthService: notification teardown failed: $e');
        }
      }

      // The server call is what actually revokes the session: it deletes the
      // staff_auth_sessions row (killing the refresh credential) AND blacklists
      // this device's access-token jti. Local teardown below runs either way —
      // refusing to sign out because the network is down would strand a staff
      // member on a shared ward device, which is worse than a token that lapses
      // on its own — but the failure is REPORTED rather than swallowed, because
      // "logged out" with a live bearer token is a lie (audit follow-up P12).
      var serverRevocationFailed = false;
      try {
        final response = await ApiClient.post('/auth/staff/logout', body: {});
        serverRevocationFailed = !response.isSuccess;
      } catch (e) {
        serverRevocationFailed = true;
        debugPrint('AuthService.logout error: $e');
      }
      await _clearLocalSession(telemetryEvent: 'auth.logout');
      return StaffLogoutResult.signedOut(
        serverRevocationFailed: serverRevocationFailed,
        notificationTeardownFailed: notificationTeardownFailed,
      );
    } finally {
      syncService.endSessionBarrier();
    }
  }

  /// Forced/server revocation bypasses the ordinary logout blocker while
  /// preserving all encrypted, owner-bound offline rows and device keys.
  static Future<int> forceLogoutForRevocation() async {
    final syncService = ConnectivitySyncService.instance;
    await syncService.beginSessionBarrier();
    try {
      var unresolvedCount = 0;
      try {
        unresolvedCount = await syncService
            .unresolvedWriteCountForCurrentOwner();
      } catch (e) {
        debugPrint('AuthService: revocation queue count failed: $e');
      }
      await _clearLocalSession(telemetryEvent: 'auth.session_revoked');
      return unresolvedCount;
    } finally {
      syncService.endSessionBarrier();
    }
  }

  /// Idle-timeout logout. Unlike [logout] it never blocks on pending offline
  /// work (an unattended shared ward device must always end its session), but
  /// it DOES revoke the session server-side like an explicit logout — the
  /// backend deletes the staff_auth_sessions row and blacklists this device's
  /// access-token jti, so the bearer token cannot keep working after the
  /// on-device timeout. Best-effort: if the device is offline the local
  /// teardown still runs and the token lapses on its own expiry.
  static Future<void> logoutForIdleTimeout() async {
    final syncService = ConnectivitySyncService.instance;
    await syncService.beginSessionBarrier();
    try {
      try {
        await ApiClient.post('/auth/staff/logout', body: {});
      } catch (e) {
        debugPrint('AuthService.logoutForIdleTimeout revocation failed: $e');
      }
      await _clearLocalSession(telemetryEvent: 'auth.idle_timeout');
    } finally {
      syncService.endSessionBarrier();
    }
  }

  static Future<void> _clearLocalSession({
    required String telemetryEvent,
  }) async {
    // Tear down the realtime socket BEFORE clearing the JWT so any
    // last-breath unsubscribe frames still authenticate, and so no
    // message/notification events can pop up on the login screen of a
    // shared ward device after sign-out (STF-1 / H3). Never let a socket
    // hiccup block the sign-out itself.
    try {
      await RealtimeClient.instance.disconnect();
    } catch (e) {
      debugPrint('AuthService: realtime teardown failed: $e');
    }
    // This is the one local-PHI retention policy for explicit, idle, forced,
    // and server-revoked logout. It must run before identity is cleared so an
    // install whose cache index is damaged can still target the current key.
    await RecentPatientsService.clear();
    await ApiConfig.clearSessionIdentity();
    await Telemetry.event(telemetryEvent);
    await CrashReporter.instance.setUserId(null);
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
    bool biometric = false,
    bool rememberEmployeeId = true,
  }) async {
    final deviceToken = await getDeviceToken();
    if (deviceToken == null || deviceToken.trim().isEmpty) {
      throw StateError(
        'This device is not registered. Sign in with your password first.',
      );
    }
    final installationId =
        await core_auth.AuthService.getOrCreateInstallationId();
    final response = await ApiClient.post(
      '/auth/staff/quick-login',
      auth: false,
      body: {
        'employeeId': employeeId,
        'pin': ?pin,
        if (biometric) 'biometric': true,
        'deviceToken': deviceToken,
        'deviceType': currentDeviceType,
        'installationId': installationId,
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
          rememberEmployeeId: rememberEmployeeId,
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

  static Future<void> clearDeviceToken() async {
    await _storage.delete(key: 'device_token');
  }

  /// Apply the server's trusted-device removal revocation locally.
  ///
  /// Removing any device revokes every staff session, so every successful
  /// removal must clear this app's authenticated session. The installation's
  /// trusted-device token is retained only when a different device was
  /// removed; password login can then re-establish this installation without
  /// losing its device binding.
  static Future<bool> applyDeviceRemovalRevocation(
    String removedDeviceId,
  ) async {
    final currentInstallationId = await getInstallationId();
    final removedCurrentInstallation =
        removedDeviceId.trim().toLowerCase() ==
        currentInstallationId.toLowerCase();
    if (removedCurrentInstallation) {
      await clearDeviceToken();
    }
    await forceLogoutForRevocation();
    return removedCurrentInstallation;
  }

  /// Get saved device token
  static Future<String?> getDeviceToken() async {
    return await _storage.read(key: 'device_token');
  }

  static Future<String> getInstallationId() {
    return core_auth.AuthService.getOrCreateInstallationId();
  }

  static Future<Map<String, String>?> getSavedCredentials() async {
    final employeeId = await _storage.read(key: 'employee_id');
    return employeeId != null ? {'employeeId': employeeId} : null;
  }

  static String get _platformName {
    if (kIsWeb) return 'web';
    return switch (defaultTargetPlatform) {
      TargetPlatform.android => 'android',
      TargetPlatform.iOS => 'ios',
      TargetPlatform.windows => 'windows',
      TargetPlatform.macOS => 'macos',
      TargetPlatform.linux => 'linux',
      TargetPlatform.fuchsia => 'linux',
    };
  }
}
