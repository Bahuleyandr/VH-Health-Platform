// lib/services/version_gate.dart
//
// Boot-time contract check between a shipped app build and the backend's
// declared minimum version. Both Flutter apps call [VersionGate.check] at
// startup; if the app is below min, callers render a blocking upgrade screen
// instead of entering the normal router.
//
// Uses `/health/client-requirements` which returns
// `{ patient: {min, recommended, updateUrl}, staff: {...} }` — ops can raise
// the floor without a deploy by bumping env vars.

import '../config/api_config.dart';
import 'http_client.dart';

enum AppRole { patient, staff }

enum VersionGateStatus {
  /// The app is ≥ recommended — proceed normally.
  ok,

  /// The app is ≥ min but < recommended — a non-blocking nudge is fine.
  updateAvailable,

  /// The app is < min — block entry, show the upgrade screen.
  mustUpdate,

  /// Backend unreachable or malformed response — fail open so users aren't
  /// locked out by a flaky network. Log + proceed.
  unknown,
}

class VersionGateResult {
  const VersionGateResult({
    required this.status,
    required this.minVersion,
    required this.recommendedVersion,
    required this.currentVersion,
    this.androidUrl,
    this.iosUrl,
  });

  final VersionGateStatus status;
  final String minVersion;
  final String recommendedVersion;
  final String currentVersion;
  final String? androidUrl;
  final String? iosUrl;
}

class VersionGate {
  VersionGate._();

  /// Hit `/health/client-requirements` and compare against [currentVersion]
  /// (usually from `PackageInfo.fromPlatform().version`). Returns a result
  /// the caller can switch on to pick a UI path.
  static Future<VersionGateResult> check({
    required AppRole role,
    required String currentVersion,
  }) async {
    try {
      final resp = await VHHttpClient.get('/health/client-requirements', auth: false);
      if (!resp.isSuccess || resp.data is! Map) {
        return _unknown(currentVersion);
      }
      final bucket = (resp.data as Map)[role == AppRole.patient ? 'patient' : 'staff'];
      if (bucket is! Map) return _unknown(currentVersion);

      final min = bucket['min']?.toString() ?? '0.0.0';
      final recommended = bucket['recommended']?.toString() ?? min;
      final updateUrl = bucket['updateUrl'] is Map ? bucket['updateUrl'] as Map : const {};
      final androidUrl = updateUrl['android']?.toString();
      final iosUrl = updateUrl['ios']?.toString();

      final cmpMin = _compareSemver(currentVersion, min);
      final cmpRec = _compareSemver(currentVersion, recommended);

      late VersionGateStatus status;
      if (cmpMin < 0) {
        status = VersionGateStatus.mustUpdate;
      } else if (cmpRec < 0) {
        status = VersionGateStatus.updateAvailable;
      } else {
        status = VersionGateStatus.ok;
      }

      return VersionGateResult(
        status: status,
        minVersion: min,
        recommendedVersion: recommended,
        currentVersion: currentVersion,
        androidUrl: androidUrl,
        iosUrl: iosUrl,
      );
    } catch (_) {
      return _unknown(currentVersion);
    }
  }

  static VersionGateResult _unknown(String currentVersion) {
    return VersionGateResult(
      status: VersionGateStatus.unknown,
      minVersion: '0.0.0',
      recommendedVersion: '0.0.0',
      currentVersion: currentVersion,
    );
  }

  /// Returns <0 if a<b, 0 if equal, >0 if a>b. Handles semver with optional
  /// pre-release suffix (rudimentary — pre-release always sorts below).
  static int _compareSemver(String a, String b) {
    final ap = _parseSemver(a);
    final bp = _parseSemver(b);
    for (var i = 0; i < 3; i++) {
      if (ap.$1[i] != bp.$1[i]) return ap.$1[i] - bp.$1[i];
    }
    // Same numeric; pre-release sorts below none.
    if (ap.$2 == null && bp.$2 != null) return 1;
    if (ap.$2 != null && bp.$2 == null) return -1;
    if (ap.$2 == null && bp.$2 == null) return 0;
    return ap.$2!.compareTo(bp.$2!);
  }

  /// Returns ([major, minor, patch], prerelease?)
  static (List<int>, String?) _parseSemver(String v) {
    final cleaned = v.split('+').first; // strip build metadata
    final parts = cleaned.split('-');
    final numeric = parts.first
        .split('.')
        .map((s) => int.tryParse(s) ?? 0)
        .toList(growable: true);
    while (numeric.length < 3) {
      numeric.add(0);
    }
    final pre = parts.length > 1 ? parts.sublist(1).join('-') : null;
    return (numeric.sublist(0, 3), pre);
  }
}

/// Exposed for tests only.
int debugCompareSemver(String a, String b) => VersionGate._compareSemver(a, b);
