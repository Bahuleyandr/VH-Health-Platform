// lib/services/device_integrity_service.dart

import 'package:flutter/foundation.dart';
import 'package:flutter_jailbreak_detection/flutter_jailbreak_detection.dart';

import '../config/security_config.dart';

/// Result of a [DeviceIntegrityService.check] call.
@immutable
class DeviceIntegrityResult {
  /// `true` when no integrity signals fired — caller may proceed.
  final bool ok;

  /// Human-readable explanations for each signal that fired. Empty when
  /// [ok] is true.
  final List<String> reasons;

  /// `true` when the service decided to block the caller (only happens in
  /// production builds; in debug we warn but permit).
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

/// Single entry point both the patient and staff Flutter apps call at
/// boot time (before issuing / accepting a JWT) to detect a compromised
/// device.
///
/// Usage from a splash/auth screen:
/// ```dart
/// final integrity = await DeviceIntegrityService.check();
/// if (integrity.shouldBlock) {
///   // route to a blocker screen; refuse to proceed with login
///   return;
/// }
/// ```
///
/// Rules:
/// * In **release** builds marked production (see [SecurityConfig.isProduction]),
///   any integrity signal causes [DeviceIntegrityResult.shouldBlock] = true.
/// * In **debug** / non-production builds, signals are still reported
///   (via [DeviceIntegrityResult.reasons]) but [shouldBlock] stays false
///   so developers can test on rooted emulators.
/// * Checks are wrapped in try/catch so a plugin failure on an unsupported
///   platform cannot block login.
class DeviceIntegrityService {
  DeviceIntegrityService._();

  /// Set to true by tests to force a deterministic result. When non-null,
  /// [check] short-circuits and returns the injected value.
  @visibleForTesting
  static DeviceIntegrityResult? testOverride;

  static Future<DeviceIntegrityResult> check() async {
    final override = testOverride;
    if (override != null) return override;

    final reasons = <String>[];

    try {
      final jailBroken = await FlutterJailbreakDetection.jailbroken;
      if (jailBroken) reasons.add('device is rooted / jailbroken');
    } catch (e) {
      if (kDebugMode) {
        // ignore: avoid_print
        print('DeviceIntegrityService: jailbroken check failed: $e');
      }
    }

    try {
      final developerMode = await FlutterJailbreakDetection.developerMode;
      if (developerMode) reasons.add('developer mode is enabled');
    } catch (e) {
      if (kDebugMode) {
        // ignore: avoid_print
        print('DeviceIntegrityService: developerMode check failed: $e');
      }
    }

    final ok = reasons.isEmpty;
    // Only enforce in release-production builds. Debug/non-production
    // builds still report reasons but allow the app to run so engineers
    // can exercise the flow on rooted test devices.
    final shouldBlock = !ok && SecurityConfig.isProduction && kReleaseMode;

    return DeviceIntegrityResult(
      ok: ok,
      reasons: reasons,
      shouldBlock: shouldBlock,
    );
  }
}
