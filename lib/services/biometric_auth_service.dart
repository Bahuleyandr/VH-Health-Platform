import 'package:flutter/foundation.dart';

/// Outcome of a biometric authentication attempt.
enum BiometricAuthResult {
  /// User authenticated successfully.
  success,

  /// User cancelled the prompt, or the OS rejected the attempt.
  cancelled,

  /// Device has no enrolled biometrics (no fingerprint / Face ID).
  notEnrolled,

  /// Device does not support biometric authentication at all.
  notAvailable,

  /// An unexpected failure. See [BiometricAuthException.message].
  error,
}

/// Thrown (via [Future] rejection) for unexpected failures.
class BiometricAuthException implements Exception {
  final String message;
  final Object? cause;
  BiometricAuthException(this.message, [this.cause]);
  @override
  String toString() => 'BiometricAuthException: $message';
}

/// Abstraction over platform biometric authentication.
///
/// Consuming apps (patient, staff) install a real implementation at startup
/// (typically backed by `package:local_auth`). Core and widget code use the
/// abstraction so both apps share one API and a swap-in fake makes tests
/// deterministic.
///
/// Usage:
/// ```dart
/// // In main.dart, after plugin init:
/// BiometricAuthService.install(LocalAuthBiometricService());
///
/// // Anywhere in app or core:
/// final result = await BiometricAuthService.instance.authenticate(
///   reason: 'Unlock to view your medical records',
/// );
/// if (result == BiometricAuthResult.success) { /* ... */ }
/// ```
abstract class BiometricAuthService {
  static BiometricAuthService _instance = _NoopBiometricAuthService();

  /// The currently installed implementation. Defaults to a [not available]
  /// no-op until [install] is called.
  static BiometricAuthService get instance => _instance;

  /// Replace the active implementation. Call once at startup from `main.dart`.
  static void install(BiometricAuthService service) {
    _instance = service;
    if (kDebugMode) {
      debugPrint('BiometricAuthService: installed ${service.runtimeType}');
    }
  }

  /// Restore the no-op implementation. Useful in tests.
  @visibleForTesting
  static void reset() {
    _instance = _NoopBiometricAuthService();
  }

  /// Whether the current device supports biometric auth AND has at least
  /// one enrolled biometric. `false` when the hardware is missing or the
  /// user hasn't enrolled a fingerprint/Face ID.
  Future<bool> isAvailable();

  /// Prompt the user for biometric authentication.
  ///
  /// [reason] is shown in the native prompt ("Unlock to view your medical
  /// records"). Keep it short, user-facing, and PII-free.
  /// [stickyAuth] keeps the prompt visible if the app is backgrounded
  /// (Android-only; iOS handles this at the OS level).
  Future<BiometricAuthResult> authenticate({
    required String reason,
    bool stickyAuth = true,
  });

  /// Cancel any in-flight prompt. No-op when nothing is pending.
  Future<void> cancelAuth();
}

/// Default implementation that reports "not available" and declines every
/// prompt. Installed until the app wires up a real reporter.
class _NoopBiometricAuthService implements BiometricAuthService {
  @override
  Future<bool> isAvailable() async => false;

  @override
  Future<BiometricAuthResult> authenticate({
    required String reason,
    bool stickyAuth = true,
  }) async {
    if (kDebugMode) {
      debugPrint(
        'BiometricAuthService (noop): authenticate requested with reason="$reason" — returning notAvailable',
      );
    }
    return BiometricAuthResult.notAvailable;
  }

  @override
  Future<void> cancelAuth() async {}
}
