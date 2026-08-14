// test/features/auth/services/biometric_quick_login_test.dart
//
// Sample test demonstrating the plugin-channel mock scaffolding. Uses the
// FakeBiometricAuthService swap-in (recommended) AND a parallel test that
// exercises the raw local_auth MethodChannel mock so both paths stay
// exercised.
//
// This is NOT the full quick-login integration test the staff app needs
// (that's a widget test against the login screen). It's a focused unit
// test proving the mock scaffolding is wired correctly — the real clinical-
// safety tests (MAR 5-rights, CDS allergy blocker, offline drain) can copy
// this pattern.

import 'package:flutter_test/flutter_test.dart';
import 'package:local_auth/local_auth.dart';
import 'package:vhhealth_core/vhhealth_core.dart';
import 'package:vhhealth_staff/core/services/local_auth_biometric_service.dart';

import '../../../helpers/fake_biometric_auth_service.dart';
import '../../../helpers/plugin_channel_mocks.dart';

void main() {
  // ── Layer 1: FakeBiometricAuthService (preferred for most tests) ─────────
  group('BiometricAuthService fake', () {
    tearDown(BiometricAuthService.reset);

    test('success path returns .success and records the reason', () async {
      final fake = FakeBiometricAuthService(
        result: BiometricAuthResult.success,
      );
      BiometricAuthService.install(fake);

      final result = await BiometricAuthService.instance.authenticate(
        reason: 'Unlock to use quick-login',
      );

      expect(result, BiometricAuthResult.success);
      expect(fake.authenticateCalls, 1);
      expect(fake.lastReason, 'Unlock to use quick-login');
      expect(fake.lastStickyAuth, true);
    });

    test('cancelled path surfaces .cancelled', () async {
      BiometricAuthService.install(
        FakeBiometricAuthService(result: BiometricAuthResult.cancelled),
      );
      final result = await BiometricAuthService.instance.authenticate(
        reason: 'ignore',
      );
      expect(result, BiometricAuthResult.cancelled);
    });

    test('throwing propagates the exception', () async {
      BiometricAuthService.install(
        FakeBiometricAuthService(throwOnAuthenticate: StateError('boom')),
      );
      expect(
        () => BiometricAuthService.instance.authenticate(reason: 'ignore'),
        throwsA(isA<StateError>()),
      );
    });

    test('isAvailable reflects the fake flag', () async {
      BiometricAuthService.install(FakeBiometricAuthService(available: false));
      expect(await BiometricAuthService.instance.isAvailable(), false);
    });
  });

  // ── Layer 2: raw local_auth MethodChannel mock (for tests that must
  //    touch the real plugin, e.g. integration-ish widget tests) ─────────
  group('local_auth MethodChannel mock', () {
    setUp(() {
      TestWidgetsFlutterBinding.ensureInitialized();
    });
    tearDown(clearAllPluginMocks);

    // NB: `canCheckBiometrics` on newer local_auth goes through a Pigeon
    // channel that doesn't route through this plain MethodChannel mock on
    // every platform variant. For the negative path, prefer the
    // FakeBiometricAuthService approach above — it's platform-agnostic.
    // The raw-channel mock stays reliable for `authenticate` itself.

    test('authenticate returns the mocked result', () async {
      mockLocalAuth(authenticateResult: true);
      final auth = LocalAuthentication();
      final ok = await auth.authenticate(localizedReason: 'test');
      expect(ok, true);
    });

    test(
      'authenticate with throwOnAuthenticate surfaces a PlatformException',
      () async {
        mockLocalAuth(throwOnAuthenticate: 'NotEnrolled');
        final auth = LocalAuthentication();
        expect(
          () => auth.authenticate(localizedReason: 'test'),
          throwsA(isA<Exception>()),
        );
      },
    );
  });

  group('LocalAuthBiometricService', () {
    test('requires enrolled biometrics before reporting available', () async {
      final authentication = _FakeLocalAuthentication(
        supported: true,
        canCheck: true,
        biometrics: [BiometricType.strong],
      );

      final service = LocalAuthBiometricService(authentication: authentication);

      expect(await service.isAvailable(), isTrue);
    });

    test('uses biometric-only sensitive sticky authentication', () async {
      final authentication = _FakeLocalAuthentication(
        supported: true,
        canCheck: true,
        biometrics: [BiometricType.fingerprint],
        authenticateResult: true,
      );

      final result = await LocalAuthBiometricService(
        authentication: authentication,
      ).authenticate(reason: 'Unlock quick login');

      expect(result, BiometricAuthResult.success);
      expect(authentication.lastReason, 'Unlock quick login');
      expect(authentication.lastBiometricOnly, isTrue);
      expect(authentication.lastSensitiveTransaction, isTrue);
      expect(authentication.lastPersistAcrossBackgrounding, isTrue);
    });

    test(
      'maps an unenrolled platform result without attempting login',
      () async {
        final authentication = _FakeLocalAuthentication(
          supported: true,
          canCheck: true,
          biometrics: [BiometricType.face],
          authenticateError: const LocalAuthException(
            code: LocalAuthExceptionCode.noBiometricsEnrolled,
          ),
        );

        final result = await LocalAuthBiometricService(
          authentication: authentication,
        ).authenticate(reason: 'Unlock quick login');

        expect(result, BiometricAuthResult.notEnrolled);
      },
    );

    test('cancels the in-flight native prompt', () async {
      final authentication = _FakeLocalAuthentication();
      final service = LocalAuthBiometricService(authentication: authentication);

      await service.cancelAuth();

      expect(authentication.stopCalls, 1);
    });
  });
}

class _FakeLocalAuthentication extends LocalAuthentication {
  _FakeLocalAuthentication({
    this.supported = false,
    this.canCheck = false,
    this.biometrics = const [],
    this.authenticateResult = false,
    this.authenticateError,
  });

  final bool supported;
  final bool canCheck;
  final List<BiometricType> biometrics;
  final bool authenticateResult;
  final Object? authenticateError;

  String? lastReason;
  bool? lastBiometricOnly;
  bool? lastSensitiveTransaction;
  bool? lastPersistAcrossBackgrounding;
  int stopCalls = 0;

  @override
  Future<bool> isDeviceSupported() async => supported;

  @override
  Future<bool> get canCheckBiometrics async => canCheck;

  @override
  Future<List<BiometricType>> getAvailableBiometrics() async => biometrics;

  @override
  Future<bool> authenticate({
    required String localizedReason,
    Object? authMessages,
    bool biometricOnly = false,
    bool sensitiveTransaction = true,
    bool persistAcrossBackgrounding = false,
  }) async {
    lastReason = localizedReason;
    lastBiometricOnly = biometricOnly;
    lastSensitiveTransaction = sensitiveTransaction;
    lastPersistAcrossBackgrounding = persistAcrossBackgrounding;
    final error = authenticateError;
    if (error != null) throw error;
    return authenticateResult;
  }

  @override
  Future<bool> stopAuthentication() async {
    stopCalls += 1;
    return true;
  }
}
