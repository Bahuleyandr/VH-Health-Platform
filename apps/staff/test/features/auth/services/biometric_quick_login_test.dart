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

import '../../../helpers/fake_biometric_auth_service.dart';
import '../../../helpers/plugin_channel_mocks.dart';

void main() {
  // ── Layer 1: FakeBiometricAuthService (preferred for most tests) ─────────
  group('BiometricAuthService fake', () {
    tearDown(BiometricAuthService.reset);

    test('success path returns .success and records the reason', () async {
      final fake = FakeBiometricAuthService(result: BiometricAuthResult.success);
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

    test('authenticate with throwOnAuthenticate surfaces a PlatformException', () async {
      mockLocalAuth(throwOnAuthenticate: 'NotEnrolled');
      final auth = LocalAuthentication();
      expect(
        () => auth.authenticate(localizedReason: 'test'),
        throwsA(isA<Exception>()),
      );
    });
  });
}
