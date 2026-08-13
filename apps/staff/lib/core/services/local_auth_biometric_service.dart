import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:local_auth/local_auth.dart';
import 'package:vhhealth_core/services/biometric_auth_service.dart';

class LocalAuthBiometricService implements BiometricAuthService {
  LocalAuthBiometricService({LocalAuthentication? authentication})
    : _authentication = authentication ?? LocalAuthentication();

  final LocalAuthentication _authentication;

  @override
  Future<bool> isAvailable() async {
    if (kIsWeb) return false;
    try {
      if (!await _authentication.isDeviceSupported()) return false;
      if (!await _authentication.canCheckBiometrics) return false;
      return (await _authentication.getAvailableBiometrics()).isNotEmpty;
    } on PlatformException {
      return false;
    }
  }

  @override
  Future<BiometricAuthResult> authenticate({
    required String reason,
    bool stickyAuth = true,
  }) async {
    if (!await isAvailable()) return BiometricAuthResult.notAvailable;
    try {
      final authenticated = await _authentication.authenticate(
        localizedReason: reason,
        biometricOnly: true,
        sensitiveTransaction: true,
        persistAcrossBackgrounding: stickyAuth,
      );
      return authenticated
          ? BiometricAuthResult.success
          : BiometricAuthResult.cancelled;
    } on LocalAuthException catch (error) {
      return switch (error.code) {
        LocalAuthExceptionCode.noBiometricsEnrolled ||
        LocalAuthExceptionCode.noCredentialsSet =>
          BiometricAuthResult.notEnrolled,
        LocalAuthExceptionCode.noBiometricHardware ||
        LocalAuthExceptionCode.biometricHardwareTemporarilyUnavailable ||
        LocalAuthExceptionCode.uiUnavailable =>
          BiometricAuthResult.notAvailable,
        LocalAuthExceptionCode.userCanceled ||
        LocalAuthExceptionCode.timeout ||
        LocalAuthExceptionCode.systemCanceled ||
        LocalAuthExceptionCode.temporaryLockout ||
        LocalAuthExceptionCode.biometricLockout ||
        LocalAuthExceptionCode.userRequestedFallback =>
          BiometricAuthResult.cancelled,
        _ => throw BiometricAuthException(
          'Biometric authentication failed',
          error,
        ),
      };
    } on PlatformException catch (error) {
      final code = error.code.toLowerCase();
      if (code.contains('notenrolled') || code.contains('not_enrolled')) {
        return BiometricAuthResult.notEnrolled;
      }
      if (code.contains('notavailable') || code.contains('not_available')) {
        return BiometricAuthResult.notAvailable;
      }
      if (code.contains('cancel') || code.contains('lockedout')) {
        return BiometricAuthResult.cancelled;
      }
      throw BiometricAuthException('Biometric authentication failed', error);
    }
  }

  @override
  Future<void> cancelAuth() => _authentication.stopAuthentication();
}
