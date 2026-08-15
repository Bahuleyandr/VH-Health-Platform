// lib/core/services/startup_gate_service.dart
//
// Process-wide cold-start security gates: device integrity (PAT-5) and the
// minimum-version policy. Both used to run ONLY inside the splash screen's tap
// handler, so any launch that never rendered the splash — a
// `vhhealth://app/<route>` deep-link cold start being the concrete case —
// reached authenticated PHI surfaces on a compromised device or an obsolete
// build without either gate ever running. The router now refuses to render any
// non-splash route until this service has evaluated the gates once for the
// process (see `AppRouter.startupGateRedirect`), and the splash consumes the
// same single-flight evaluation so the two paths cannot disagree.

import 'package:flutter/foundation.dart';
import 'package:vhhealth/core/services/minimum_version_gate_service.dart';
import 'package:vhhealth_core/services/device_integrity_service.dart';

typedef StartupIntegrityCheck = Future<DeviceIntegrityResult> Function();
typedef StartupVersionCheck = Future<MinimumVersionGateResult> Function();

/// Outcome of one cold-start gate evaluation. At most one block is set: the
/// integrity gate runs first (a compromised device must never even reach the
/// version-policy network call), so [versionBlock] is only populated when the
/// device passed integrity.
class StartupGateResult {
  const StartupGateResult({this.integrityBlock, this.versionBlock});

  /// Non-null when the device-integrity gate demands a hard block
  /// (`DeviceIntegrityResult.shouldBlock` — production builds with a real
  /// failing signal only).
  final DeviceIntegrityResult? integrityBlock;

  /// Non-null when the minimum-version gate closed
  /// (`MinimumVersionGateResult.updateRequired`).
  final MinimumVersionGateResult? versionBlock;

  bool get allowed => integrityBlock == null && versionBlock == null;
}

/// Fail-closed, single-flight evaluation of the cold-start gates.
///
/// A PASS is cached for the life of the process: the gates are a launch
/// contract, not a per-navigation tax, and re-running them on every route
/// change would add a `/config` round trip to ordinary navigation. A BLOCK is
/// deliberately NOT cached — the splash re-runs the evaluation on every tap
/// today (a transient `/config` outage inside bootstrap grace must stay
/// recoverable without an app restart), and this service preserves that.
class StartupGateService {
  StartupGateService._();

  /// Injectable gate probes. Production defaults are the real services;
  /// `@visibleForTesting` so tests can force either verdict without platform
  /// channels or network.
  @visibleForTesting
  static StartupIntegrityCheck integrityCheck = DeviceIntegrityService.check;

  @visibleForTesting
  static StartupVersionCheck versionCheck = MinimumVersionGateService.check;

  static StartupGateResult? _passed;
  static Future<StartupGateResult>? _inFlight;

  /// Whether a pass has already been recorded for this process.
  static bool get hasPassed => _passed != null;

  /// Evaluates both gates, sharing one in-flight evaluation between
  /// concurrent callers (router redirect racing the splash tap handler must
  /// not double-hit `/config`).
  static Future<StartupGateResult> ensureEvaluated() {
    final passed = _passed;
    if (passed != null) return Future.value(passed);

    final existing = _inFlight;
    if (existing != null) return existing;

    late final Future<StartupGateResult> tracked;
    tracked = _evaluate().whenComplete(() {
      if (identical(_inFlight, tracked)) _inFlight = null;
    });
    _inFlight = tracked;
    return tracked;
  }

  static Future<StartupGateResult> _evaluate() async {
    // Integrity first, mirroring the splash's original ordering: a compromised
    // device never reaches any further startup code path, including the
    // version gate's network call.
    final integrity = await integrityCheck();
    if (integrity.shouldBlock) {
      return StartupGateResult(integrityBlock: integrity);
    }

    final version = await versionCheck();
    if (version.updateRequired) {
      return StartupGateResult(versionBlock: version);
    }

    const result = StartupGateResult();
    _passed = result;
    return result;
  }

  @visibleForTesting
  static void resetForTesting() {
    _passed = null;
    _inFlight = null;
    integrityCheck = DeviceIntegrityService.check;
    versionCheck = MinimumVersionGateService.check;
  }
}
