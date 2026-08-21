// lib/core/services/minimum_version_gate_service.dart
//
// Staff port of the patient app's minimum-version (force-update) gate.
//
// The staff gate implements the unsigned legacy contract only: it reads the
// `min_staff_version_code` projection from public `GET /config` and compares
// it against this build's version code. The patient app additionally carries
// an Ed25519 signed-policy scheme (`minimum_version_policy` + release-stamped
// `VH_PATIENT_MIN_VERSION_*` trust anchors); the staff app deliberately ships
// no trust anchors and no signed scheme, so there is nothing to verify and
// nothing to persist.
//
// FAILURE POSTURE — an unreachable or unusable `/config` FAILS OPEN.
// This matches the patient gate's posture for exactly this class of artifact:
// a patient build with no trust anchor can never turn any envelope into local
// authority, so its gate refuses to close on an unusable config
// (`MinimumVersionGateReason.policyUnenforceable` — closing enforces nothing
// and only bricks the install). Every staff build is permanently in that
// posture. It is also the clinically safe choice: this app fronts MAR/BCMA,
// CPOE, and code-response workflows, and hard-blocking clinicians on a
// transient network failure would be a patient-safety hazard the offline
// capture flows exist to avoid. A staff build below the minimum is still
// blocked whenever `/config` answers — which is every launch with working
// connectivity.
import 'package:flutter/foundation.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:vhhealth_core/models/api_response.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_core/utils/log_sanitizer.dart';
import 'package:vhhealth_staff/core/config/release_urls.dart';

typedef MinimumVersionConfigRequest = Future<ApiResponse> Function(
  Duration timeout,
);

enum MinimumVersionGateReason {
  /// `/config` answered cleanly with no (or a malformed) staff minimum. The
  /// backend coerces anything unusable to 0, so reading it as "gate disabled"
  /// is the faithful interpretation rather than a relaxation.
  disabled,

  /// `/config` answered cleanly and this build is at or above the minimum.
  current,

  /// `/config` answered cleanly and this build is below the minimum.
  updateRequired,

  /// `/config` was unreachable or unusable. The staff gate FAILS OPEN here —
  /// see the failure-posture note in the library comment above.
  configUnavailable,
}

class MinimumVersionGateResult {
  const MinimumVersionGateResult({
    required this.updateRequired,
    required this.currentVersionCode,
    required this.minStaffVersionCode,
    required this.releaseUrl,
    required this.reason,
  });

  final bool updateRequired;
  final int currentVersionCode;
  final int minStaffVersionCode;
  final String releaseUrl;
  final MinimumVersionGateReason reason;

  /// Whether the update screen has a real link to offer. Empty means "not
  /// configured" (e.g. no iOS distribution channel) and the blocking screen
  /// must hide its CTA instead of showing a button that does nothing.
  bool get hasReleaseUrl => releaseUrl.trim().isNotEmpty;
}

class MinimumVersionGateService {
  MinimumVersionGateService._();

  static const defaultTimeout = Duration(seconds: 5);

  static Future<MinimumVersionGateResult> check({
    MinimumVersionConfigRequest request = _defaultRequest,
    String? currentBuildNumber,
    TargetPlatform? platform,
    Duration timeout = defaultTimeout,
  }) async {
    final releaseUrl = ReleaseUrls.forTargetPlatform(
      platform ?? defaultTargetPlatform,
    );
    final currentCode = await _currentCode(currentBuildNumber);

    Map<String, dynamic>? data;
    try {
      final response = await request(timeout);
      if (response.isSuccess && response.data is Map) {
        data = Map<String, dynamic>.from(response.data as Map);
      }
    } catch (error) {
      if (kDebugMode) {
        debugPrint(
          'MinimumVersionGateService: config unavailable: '
          '${logSafeError(error)}',
        );
      }
    }

    if (data == null) {
      // FAIL OPEN: no usable `/config`. See the library comment — the staff
      // artifact carries no signed-policy trust anchor, so closing here would
      // enforce nothing and only lock clinicians out on a network blip.
      return _allow(
        currentCode: currentCode,
        releaseUrl: releaseUrl,
        reason: MinimumVersionGateReason.configUnavailable,
      );
    }

    final minimum = _strictConfigInt(data['min_staff_version_code']) ?? 0;
    if (minimum == 0) {
      return _allow(
        currentCode: currentCode,
        releaseUrl: releaseUrl,
        reason: MinimumVersionGateReason.disabled,
      );
    }
    if (currentCode >= minimum) {
      return _allow(
        currentCode: currentCode,
        minStaffVersionCode: minimum,
        releaseUrl: releaseUrl,
        reason: MinimumVersionGateReason.current,
      );
    }
    return MinimumVersionGateResult(
      updateRequired: true,
      currentVersionCode: currentCode,
      minStaffVersionCode: minimum,
      releaseUrl: releaseUrl,
      reason: MinimumVersionGateReason.updateRequired,
    );
  }

  static MinimumVersionGateResult _allow({
    required int currentCode,
    int minStaffVersionCode = 0,
    required String releaseUrl,
    required MinimumVersionGateReason reason,
  }) => MinimumVersionGateResult(
    updateRequired: false,
    currentVersionCode: currentCode,
    minStaffVersionCode: minStaffVersionCode,
    releaseUrl: releaseUrl,
    reason: reason,
  );

  static Future<int> _currentCode(String? supplied) async {
    try {
      return _parseNonNegativeInt(
        supplied ?? (await PackageInfo.fromPlatform()).buildNumber,
      );
    } catch (_) {
      return 0;
    }
  }

  static int? _strictConfigInt(Object? value) =>
      value is int && value >= 0 && value <= 9007199254740991 ? value : null;

  static int _parseNonNegativeInt(String value) {
    final parsed = int.tryParse(value.trim());
    return parsed != null && parsed >= 0 ? parsed : 0;
  }

  static Future<ApiResponse> _defaultRequest(Duration timeout) =>
      VHHttpClient.get('/config', auth: false, timeout: timeout);
}
