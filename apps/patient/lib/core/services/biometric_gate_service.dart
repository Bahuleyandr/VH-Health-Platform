import 'package:flutter/foundation.dart';
import 'package:local_auth/local_auth.dart';
import 'package:vhhealth_core/services/secure_storage.dart';

/// Gates sensitive actions behind biometric re-authentication.
///
/// Usage:
/// ```dart
/// if (await BiometricGateService.requireAuth('View Medical Records')) {
///   // proceed with sensitive action
/// }
/// ```
///
/// Audit finding M11 (2026-06-10): this gate previously FAILED OPEN — it
/// returned `true` (allow) when biometrics were enabled-but-unavailable or
/// on any exception, so the "extra lock" the patient turned on silently did
/// nothing exactly when the device was in a weird state. It now fails
/// CLOSED: once the user enables the biometric lock, an unavailable sensor
/// or an error DENIES access (the caller shows "unlock failed, try again").
class BiometricGateService {
  BiometricGateService._();

  static final _auth = LocalAuthentication();
  static final _storage = VHSecureStorage.instance;

  /// Check if user has biometric enabled in settings.
  static Future<bool> get isBiometricEnabled async {
    final val = await _storage.read(key: 'biometric_enabled');
    return val == 'true';
  }

  /// If biometric is enabled, prompt for verification.
  /// Returns true if verified, or if the user never enabled the gate.
  /// Returns false if the user cancelled/failed, if biometrics are
  /// enabled-but-unavailable, or on any error (fail closed — M11).
  static Future<bool> requireAuth(String reason) async {
    try {
      if (!await isBiometricEnabled) return true; // gate not enabled — allow

      final canCheck =
          await _auth.canCheckBiometrics || await _auth.isDeviceSupported();
      if (!canCheck) {
        // The user enabled the lock but the device can't verify right now.
        // Allowing here would let anyone bypass the gate by breaking the
        // sensor state — deny (M11).
        if (kDebugMode) {
          debugPrint(
            'BiometricGateService: biometric enabled but unavailable — DENY (fail closed)',
          );
        }
        return false;
      }

      return await _auth.authenticate(
        localizedReason: reason,
        biometricOnly: false, // allow PIN fallback
        persistAcrossBackgrounding: true,
      );
    } catch (e) {
      if (kDebugMode) {
        debugPrint('BiometricGateService: $e — DENY (fail closed)');
      }
      return false; // fail closed (M11)
    }
  }
}
