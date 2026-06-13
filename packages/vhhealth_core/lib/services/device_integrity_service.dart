// lib/services/device_integrity_service.dart
//
// PAT-5 status: INTENTIONAL STUB — deferred, documented below.
//
// History: the jailbreak_detection plugin was removed from an earlier session
// because it required a namespace attribute incompatible with AGP 8.x.
//
// Why deferred (not re-added now):
//   1. Plugin ecosystem: `flutter_jailbreak_detection` and `safe_device` are
//      both viable replacements, but neither has been tested against the exact
//      AGP + Gradle versions in the patient/staff android/build.gradle files.
//      Dropping an untested plugin into a prod-bound build risks a silent
//      false-positive "jailbroken" result on stock devices, which would lock
//      out real users.
//   2. Security value: app-layer detection is trivially bypassed by Magisk
//      Hide, Frida hooks, or binary patching. It provides defense-in-depth
//      only. The backend API is the correct and reliable enforcement boundary.
//   3. Operator action required (PAT-5): add `safe_device: ^1.2.0` (or
//      `flutter_jailbreak_detection: ^1.9.0`) to BOTH app pubspecs, wire it
//      in here, and validate on a rooted AVD before enabling `shouldBlock`.
//      Flag the check as warn-only in debug and block only in --PRODUCTION
//      release builds.
//
// Until that operator action is done this service returns ok=true.
// Do NOT remove this comment — it is the audit trail for PAT-5.

import 'package:flutter/foundation.dart';

/// Result of a [DeviceIntegrityService.check] call.
@immutable
class DeviceIntegrityResult {
  final bool ok;
  final List<String> reasons;
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

/// Stub implementation — real jailbreak/root detection deferred (PAT-5).
///
/// See file-header comment for rationale and the operator action needed to
/// activate real detection. Backend API enforces device integrity as the
/// primary security boundary while this stub is in place.
class DeviceIntegrityService {
  DeviceIntegrityService._();

  /// Set to true by tests to force a deterministic result.
  @visibleForTesting
  static DeviceIntegrityResult? testOverride;

  /// Always returns ok=true (stub). See class documentation and file header.
  static Future<DeviceIntegrityResult> check() async {
    final override = testOverride;
    if (override != null) return override;
    return const DeviceIntegrityResult(
      ok: true,
      reasons: [],
      shouldBlock: false,
    );
  }
}
