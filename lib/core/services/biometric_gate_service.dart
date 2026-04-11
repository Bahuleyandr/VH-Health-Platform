import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:local_auth/local_auth.dart';

/// Gates sensitive actions behind biometric re-authentication.
///
/// Usage:
/// ```dart
/// if (await BiometricGateService.requireAuth('View Medical Records')) {
///   // proceed with sensitive action
/// }
/// ```
class BiometricGateService {
  BiometricGateService._();

  static final _auth = LocalAuthentication();
  static const _storage = FlutterSecureStorage();

  /// Check if user has biometric enabled in settings.
  static Future<bool> get isBiometricEnabled async {
    final val = await _storage.read(key: 'biometric_enabled');
    return val == 'true';
  }

  /// If biometric is enabled, prompt for verification.
  /// Returns true if verified or biometric not enabled.
  /// Returns false if user cancelled or failed.
  static Future<bool> requireAuth(String reason) async {
    try {
      if (!await isBiometricEnabled) return true; // not enabled, allow

      final canCheck =
          await _auth.canCheckBiometrics || await _auth.isDeviceSupported();
      if (!canCheck) return true; // device doesn't support, allow

      return await _auth.authenticate(
        localizedReason: reason,
        options: const AuthenticationOptions(
          stickyAuth: true,
          biometricOnly: false, // allow PIN fallback
        ),
      );
    } catch (e) {
      if (kDebugMode) debugPrint('BiometricGateService: $e');
      return true; // on error, don't block the user
    }
  }
}
