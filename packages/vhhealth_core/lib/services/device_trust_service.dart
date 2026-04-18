import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';

import 'device_integrity_service.dart';

/// Outcome of a device-trust evaluation.
///
/// [score] is a 0–100 number where 100 means "no signals indicate tampering"
/// and 0 means "every signal says this device is hostile". Callers use
/// [isUsable] to gate sensitive flows (prompt MFA, deny bulk-export, etc.)
/// rather than interpreting the raw score directly — the weighting is
/// intentionally encapsulated.
@immutable
class DeviceTrustResult {
  const DeviceTrustResult({
    required this.score,
    required this.signals,
  });

  final int score;

  /// Which signals fired + their deduction. Surfaced primarily for audit logs
  /// and dev diagnostics; not intended for user-facing display (some signals
  /// are best not advertised to attackers).
  final Map<String, int> signals;

  bool isUsable({int threshold = 60}) => score >= threshold;

  @override
  String toString() => 'DeviceTrustResult(score: $score, signals: $signals)';
}

/// Signal probe interface. Default implementation uses what's available
/// cross-platform without native deps; consumers can inject a richer probe
/// (e.g. one that wraps SafetyNet/Play Integrity or DeviceCheck) via
/// [DeviceTrust.installProbe].
abstract class DeviceTrustProbe {
  const DeviceTrustProbe();

  /// Whether a debugger/profiler is currently attached. Default uses
  /// [kDebugMode] which is a compile-time constant — release builds always
  /// report false even when attached. Install a richer probe for production
  /// debugger detection.
  Future<bool> isDebuggerAttached() async => kDebugMode;

  /// Heuristic — true when the app is running on an Android emulator or iOS
  /// simulator. Default uses `Platform.environment` + common fingerprints.
  Future<bool> isEmulator() async {
    if (!Platform.isAndroid && !Platform.isIOS) return false;
    // iOS simulator sets SIMULATOR_DEVICE_NAME.
    if (Platform.isIOS) {
      return Platform.environment.containsKey('SIMULATOR_DEVICE_NAME')
          || Platform.environment['SIMULATOR_ROOT'] != null;
    }
    // Android — no reliable cross-package check without `device_info_plus`;
    // return false by default and let the consumer install a richer probe.
    return false;
  }

  /// Whether developer-mode/USB-debug is on. Default returns false — requires
  /// a platform-specific probe (consumers install one that reads Android's
  /// `Settings.Global.ADB_ENABLED` via a method channel).
  Future<bool> isDeveloperModeOn() async => false;
}

class _DefaultProbe extends DeviceTrustProbe {
  const _DefaultProbe();
}

/// Composite device-trust scorer. Singleton entry point is [DeviceTrust.check].
///
/// Weighting:
///   * jailbroken/rooted         — −50  (dominant signal; root = untrusted)
///   * debugger attached          — −20  (dev tooling or injection)
///   * emulator                   — −30  (rarely real users in prod)
///   * developer/USB-debug on     — −10  (lower-severity: common on dev phones)
///
/// Clamps at 0. Multiple signals stack; the most suspicious device can still
/// only reach 0 (no negative scores — simpler to reason about).
class DeviceTrust {
  DeviceTrust._();

  static DeviceTrustProbe _probe = const _DefaultProbe();

  /// Install a richer probe at app startup (e.g. one backed by Play Integrity
  /// or an attestation native plugin). Call before any [check] invocation.
  static void installProbe(DeviceTrustProbe probe) {
    _probe = probe;
  }

  /// @visibleForTesting
  @visibleForTesting
  static void resetProbe() {
    _probe = const _DefaultProbe();
  }

  static Future<DeviceTrustResult> check() async {
    final signals = <String, int>{};
    var score = 100;

    // Jailbreak/root signal comes from the existing DeviceIntegrityService so
    // there's exactly one source of truth for "is this device rooted".
    final integrity = await DeviceIntegrityService.check();
    if (!integrity.ok) {
      signals['jailbroken_or_rooted'] = -50;
      score -= 50;
    }

    if (await _probe.isDebuggerAttached()) {
      signals['debugger_attached'] = -20;
      score -= 20;
    }

    if (await _probe.isEmulator()) {
      signals['emulator'] = -30;
      score -= 30;
    }

    if (await _probe.isDeveloperModeOn()) {
      signals['developer_mode'] = -10;
      score -= 10;
    }

    return DeviceTrustResult(
      score: score.clamp(0, 100),
      signals: signals,
    );
  }
}
