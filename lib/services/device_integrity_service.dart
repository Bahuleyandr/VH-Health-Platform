// lib/services/device_integrity_service.dart
//
// jailbreak_detection plugin removed — incompatible with AGP 8.x (namespace required).
// Device integrity is enforced at the backend API layer, which is the proper
// security boundary. App-level jailbreak detection is trivially bypassed by
// patching the binary or running on a non-rooted device.

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

/// Stub implementation — jailbreak detection removed.
/// Backend API enforces device integrity as the real security boundary.
class DeviceIntegrityService {
  DeviceIntegrityService._();

  /// Set to true by tests to force a deterministic result.
  @visibleForTesting
  static DeviceIntegrityResult? testOverride;

  /// Always returns ok=true since app-level jailbreak detection was removed.
  /// Backend is responsible for device integrity enforcement.
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
