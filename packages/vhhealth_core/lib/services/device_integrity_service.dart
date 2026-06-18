// lib/services/device_integrity_service.dart
//
// PAT-5: real root / jailbreak detection (replaces the former always-pass stub).
//
// Detection strategy — NO new pub dependency:
//   * Native signal (authoritative): a MethodChannel
//     (`vhhealth/device_integrity`) the host app implements to run platform
//     root/jailbreak checks (e.g. su-binary / Magisk / Cydia probes, or a
//     wrapped Play-Integrity/DeviceCheck verdict). This mirrors the existing
//     `DeviceInfoPlusProbe` developer-mode channel pattern so there is one
//     consistent native-bridge convention. When the host hasn't wired it
//     (MissingPluginException) the probe reports "unknown = NOT compromised"
//     so a stock device is never falsely locked out.
//   * Heuristic signal (corroborating): `device_info_plus` —
//     `androidInfo.isPhysicalDevice == false` or known emulator fingerprints
//     flag an emulator. Emulators are treated as integrity failures because
//     they are a primary tampering surface; this matches DeviceTrust's
//     emulator weighting.
//
// Enforcement posture (warn-only vs block):
//   * Release / production builds (`--dart-define=PRODUCTION=true`) BLOCK a
//     compromised device: `shouldBlock = !ok`. The splash gate then refuses to
//     proceed to any auth code path.
//   * Debug / dev builds NEVER block (`shouldBlock = false`) but still report
//     the real `ok`/`reasons`, so developers on rooted test phones or emulators
//     can keep working while the signal stays visible (and feeds DeviceTrust).
//
// App-layer detection is defense-in-depth only (bypassable by Magisk Hide /
// Frida / patching); the backend remains the authoritative enforcement
// boundary. But the check must report the truth — a permanent ok=true stub is a
// false-assurance hazard, since the splash treats it as a security gate and
// DeviceTrust folds it in as the dominant (-50) signal.

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'device_info_plus_probe.dart';
import 'device_trust_service.dart';

/// Result of a [DeviceIntegrityService.check] call.
@immutable
class DeviceIntegrityResult {
  /// True when no integrity signal fired (device looks untampered).
  final bool ok;

  /// Machine-readable signal keys that fired (e.g. `rooted_or_jailbroken`,
  /// `emulator`). Empty when [ok]. Not user-facing verbatim.
  final List<String> reasons;

  /// Whether the caller should HARD-BLOCK. Only ever true in production builds
  /// with a real failing signal; debug builds warn (false) so devs aren't
  /// locked out.
  final bool shouldBlock;

  const DeviceIntegrityResult({
    required this.ok,
    required this.reasons,
    required this.shouldBlock,
  });

  @override
  String toString() =>
      'DeviceIntegrityResult(ok: $ok, shouldBlock: $shouldBlock, reasons: $reasons)';
}

/// Real root/jailbreak/emulator detection.
///
/// Blocks compromised devices in production builds and warns (without blocking)
/// elsewhere. See file header for the detection + enforcement rationale.
class DeviceIntegrityService {
  DeviceIntegrityService._();

  /// True in production builds. Drives block-vs-warn. Compile-time constant so
  /// release builds tree-shake the debug branch.
  static const bool _isProduction = bool.fromEnvironment(
    'PRODUCTION',
    defaultValue: false,
  );

  /// Native bridge for platform root/jailbreak checks. The host app implements
  /// `isCompromised` on this channel; absent that, the probe reports safe.
  @visibleForTesting
  static MethodChannel integrityChannel = const MethodChannel(
    'vhhealth/device_integrity',
  );

  /// Emulator probe — reuses the shared `device_info_plus`-backed probe so
  /// emulator detection logic lives in exactly one place. Overridable in tests.
  @visibleForTesting
  static DeviceTrustProbe emulatorProbe = DeviceInfoPlusProbe();

  /// Forces a deterministic result for tests/widget gates.
  @visibleForTesting
  static DeviceIntegrityResult? testOverride;

  /// Reset injected test seams back to their production defaults.
  @visibleForTesting
  static void resetForTesting() {
    testOverride = null;
    integrityChannel = const MethodChannel('vhhealth/device_integrity');
    emulatorProbe = DeviceInfoPlusProbe();
  }

  /// Ask the native side whether the device is rooted/jailbroken.
  ///
  /// Returns false ("not compromised") when the host hasn't wired the channel
  /// (MissingPluginException) or on any error — failing OPEN here is deliberate:
  /// a flaky/absent native probe must not lock real users out of a health app.
  /// Production hardening (fail-closed) belongs behind a wired, tested channel.
  static Future<bool> _nativeIsCompromised() async {
    try {
      final result = await integrityChannel.invokeMethod<bool>('isCompromised');
      return result == true;
    } on MissingPluginException {
      if (kDebugMode) {
        debugPrint(
          'DeviceIntegrityService: MethodChannel `vhhealth/device_integrity` '
          'not implemented on host. Wire it (su-binary / Magisk / Cydia probe '
          'or a Play-Integrity/DeviceCheck verdict) to enable native '
          'root/jailbreak detection.',
        );
      }
      return false;
    } catch (e) {
      if (kDebugMode) {
        debugPrint('DeviceIntegrityService._nativeIsCompromised failed: $e');
      }
      return false;
    }
  }

  /// Evaluate device integrity.
  ///
  /// Combines the native root/jailbreak verdict with an emulator heuristic.
  /// [shouldBlock] is true only in production builds when a signal fired.
  static Future<DeviceIntegrityResult> check() async {
    final override = testOverride;
    if (override != null) return override;

    final reasons = <String>[];

    if (await _nativeIsCompromised()) {
      reasons.add('rooted_or_jailbroken');
    }

    try {
      if (await emulatorProbe.isEmulator()) {
        reasons.add('emulator');
      }
    } catch (e) {
      if (kDebugMode) {
        debugPrint('DeviceIntegrityService: emulator probe failed: $e');
      }
    }

    final ok = reasons.isEmpty;
    return DeviceIntegrityResult(
      ok: ok,
      reasons: reasons,
      // Warn-only off production so devs on rooted phones / emulators keep
      // working; hard-block a real signal in production builds.
      shouldBlock: _isProduction && !ok,
    );
  }
}
