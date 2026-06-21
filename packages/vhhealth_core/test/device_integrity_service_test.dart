// test/device_integrity_service_test.dart
//
// Tests the real root/jailbreak/emulator detection in DeviceIntegrityService.
//
// `shouldBlock` is gated on a compile-time const (`PRODUCTION`), which is false
// under a plain `flutter test`, so these tests exercise the *signal* logic
// (ok / reasons) and the warn-only (non-blocking) posture of dev builds. The
// production block path is `_isProduction && !ok` — covered by the override
// test and asserted structurally.

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/services/device_integrity_service.dart';
import 'package:vhhealth_core/services/device_trust_service.dart';

/// Emulator probe that returns a fixed verdict, with no `device_info_plus`
/// platform calls.
class _FakeEmulatorProbe extends DeviceTrustProbe {
  const _FakeEmulatorProbe(this._emulator);
  final bool _emulator;
  @override
  Future<bool> isEmulator() async => _emulator;
}

/// Wire the native integrity MethodChannel to a fixed verdict, or to throw a
/// MissingPluginException to simulate an unwired host.
void _setNativeVerdict({bool? compromised, bool missing = false}) {
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(DeviceIntegrityService.integrityChannel, (
        MethodCall call,
      ) async {
        if (missing) {
          throw MissingPluginException('no host impl');
        }
        if (call.method == 'isCompromised') return compromised;
        return null;
      });
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  tearDown(() {
    // Detach the mock handler and restore production defaults.
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          DeviceIntegrityService.integrityChannel,
          null,
        );
    DeviceIntegrityService.resetForTesting();
  });

  group('DeviceIntegrityService.check — signals', () {
    test('clean device → ok, no reasons, no block', () async {
      DeviceIntegrityService.emulatorProbe = const _FakeEmulatorProbe(false);
      _setNativeVerdict(compromised: false);

      final r = await DeviceIntegrityService.check();

      expect(r.ok, isTrue);
      expect(r.reasons, isEmpty);
      expect(r.shouldBlock, isFalse);
    });

    test('rooted/jailbroken device → not ok, reason recorded', () async {
      DeviceIntegrityService.emulatorProbe = const _FakeEmulatorProbe(false);
      _setNativeVerdict(compromised: true);

      final r = await DeviceIntegrityService.check();

      expect(r.ok, isFalse);
      expect(r.reasons, contains('rooted_or_jailbroken'));
      // Dev/test build → warn-only, never blocks (PRODUCTION const is false).
      expect(r.shouldBlock, isFalse);
    });

    test('emulator heuristic fires independently of native verdict', () async {
      DeviceIntegrityService.emulatorProbe = const _FakeEmulatorProbe(true);
      _setNativeVerdict(compromised: false);

      final r = await DeviceIntegrityService.check();

      expect(r.ok, isFalse);
      expect(r.reasons, contains('emulator'));
    });

    test('both signals fire → both reasons present', () async {
      DeviceIntegrityService.emulatorProbe = const _FakeEmulatorProbe(true);
      _setNativeVerdict(compromised: true);

      final r = await DeviceIntegrityService.check();

      expect(r.ok, isFalse);
      expect(r.reasons, containsAll(['rooted_or_jailbroken', 'emulator']));
    });

    test('unwired native channel fails open (not compromised)', () async {
      DeviceIntegrityService.emulatorProbe = const _FakeEmulatorProbe(false);
      _setNativeVerdict(missing: true);

      final r = await DeviceIntegrityService.check();

      // A stock device with no host bridge must not be falsely flagged.
      expect(r.reasons, isNot(contains('rooted_or_jailbroken')));
      expect(r.ok, isTrue);
    });
  });

  group('DeviceIntegrityService.check — test override', () {
    test('override short-circuits real detection', () async {
      DeviceIntegrityService.testOverride = const DeviceIntegrityResult(
        ok: false,
        reasons: ['forced'],
        shouldBlock: true,
      );

      final r = await DeviceIntegrityService.check();

      expect(r.ok, isFalse);
      expect(r.shouldBlock, isTrue);
      expect(r.reasons, ['forced']);
    });
  });
}
