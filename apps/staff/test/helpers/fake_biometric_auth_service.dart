// test/helpers/fake_biometric_auth_service.dart
//
// Swap-in fake for `vhhealth_core`'s BiometricAuthService. Prefer this over
// the raw MethodChannel mock (plugin_channel_mocks.dart#mockLocalAuth) when
// the code under test talks to BiometricAuthService.instance — the fake is
// deterministic and doesn't depend on local_auth being installed as a plugin.

import 'package:vhhealth_core/vhhealth_core.dart';

class FakeBiometricAuthService implements BiometricAuthService {
  FakeBiometricAuthService({
    this.available = true,
    this.result = BiometricAuthResult.success,
    this.throwOnAuthenticate,
  });

  bool available;
  BiometricAuthResult result;
  Object? throwOnAuthenticate;

  int authenticateCalls = 0;
  int cancelCalls = 0;
  String? lastReason;
  bool? lastStickyAuth;

  @override
  Future<bool> isAvailable() async => available;

  @override
  Future<BiometricAuthResult> authenticate({
    required String reason,
    bool stickyAuth = true,
  }) async {
    authenticateCalls++;
    lastReason = reason;
    lastStickyAuth = stickyAuth;
    if (throwOnAuthenticate != null) {
      throw throwOnAuthenticate!;
    }
    return result;
  }

  @override
  Future<void> cancelAuth() async {
    cancelCalls++;
  }
}
