// test/core/services/startup_gate_service_test.dart
//
// The cold-start gates (device integrity, minimum version) used to run only
// inside the splash tap handler, so a deep-link cold start that never rendered
// the splash bypassed both. StartupGateService is the shared, fail-closed
// evaluation the router guard and the splash now both consume — these tests
// pin its contract: integrity-before-version ordering, a process-cached pass,
// a NEVER-cached block, and single-flight sharing between concurrent callers.

import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/services/minimum_version_gate_service.dart';
import 'package:vhhealth/core/services/startup_gate_service.dart';
import 'package:vhhealth_core/services/device_integrity_service.dart';

const _integrityOk = DeviceIntegrityResult(
  ok: true,
  reasons: [],
  shouldBlock: false,
);

const _integrityBlocked = DeviceIntegrityResult(
  ok: false,
  reasons: ['rooted_or_jailbroken'],
  shouldBlock: true,
);

MinimumVersionGateResult _versionResult({required bool updateRequired}) =>
    MinimumVersionGateResult(
      updateRequired: updateRequired,
      currentVersionCode: 10,
      minPatientVersionCode: updateRequired ? 20 : 0,
      storeUrl: 'https://store.example/vhhealth',
      reason: updateRequired
          ? MinimumVersionGateReason.updateRequired
          : MinimumVersionGateReason.current,
    );

void main() {
  tearDown(StartupGateService.resetForTesting);

  test(
    'a pass is cached for the process — the gates run exactly once',
    () async {
      var integrityCalls = 0;
      var versionCalls = 0;
      StartupGateService.integrityCheck = () async {
        integrityCalls++;
        return _integrityOk;
      };
      StartupGateService.versionCheck = () async {
        versionCalls++;
        return _versionResult(updateRequired: false);
      };

      final first = await StartupGateService.ensureEvaluated();
      final second = await StartupGateService.ensureEvaluated();

      expect(first.allowed, isTrue);
      expect(identical(first, second), isTrue);
      expect(StartupGateService.hasPassed, isTrue);
      expect(integrityCalls, 1);
      expect(versionCalls, 1);
    },
  );

  test('an integrity hard-block fails closed before the version gate runs, '
      'and is never cached', () async {
    var integrityCalls = 0;
    var versionCalls = 0;
    StartupGateService.integrityCheck = () async {
      integrityCalls++;
      return _integrityBlocked;
    };
    StartupGateService.versionCheck = () async {
      versionCalls++;
      return _versionResult(updateRequired: false);
    };

    final blocked = await StartupGateService.ensureEvaluated();

    expect(blocked.allowed, isFalse);
    expect(blocked.integrityBlock, same(_integrityBlocked));
    expect(blocked.versionBlock, isNull);
    // Ordering contract: a compromised device never reaches the version
    // gate's network call.
    expect(versionCalls, 0);
    expect(StartupGateService.hasPassed, isFalse);

    // A block re-evaluates on the next attempt (splash retap recovery).
    await StartupGateService.ensureEvaluated();
    expect(integrityCalls, 2);
  });

  test('a version hard-block fails closed and is never cached', () async {
    var versionCalls = 0;
    StartupGateService.integrityCheck = () async => _integrityOk;
    StartupGateService.versionCheck = () async {
      versionCalls++;
      return _versionResult(updateRequired: true);
    };

    final blocked = await StartupGateService.ensureEvaluated();

    expect(blocked.allowed, isFalse);
    expect(blocked.integrityBlock, isNull);
    expect(blocked.versionBlock?.updateRequired, isTrue);
    expect(StartupGateService.hasPassed, isFalse);

    // Recoverable: a later attempt (e.g. after a transient /config outage)
    // re-runs the gate instead of replaying the stale block.
    StartupGateService.versionCheck = () async {
      versionCalls++;
      return _versionResult(updateRequired: false);
    };
    final recovered = await StartupGateService.ensureEvaluated();
    expect(recovered.allowed, isTrue);
    expect(versionCalls, 2);
  });

  test('concurrent callers share one in-flight evaluation', () async {
    var integrityCalls = 0;
    final gate = Completer<DeviceIntegrityResult>();
    StartupGateService.integrityCheck = () {
      integrityCalls++;
      return gate.future;
    };
    StartupGateService.versionCheck = () async =>
        _versionResult(updateRequired: false);

    // Router redirect racing the splash tap handler must not double-hit
    // /config: both awaits resolve from the same evaluation.
    final fromRouter = StartupGateService.ensureEvaluated();
    final fromSplash = StartupGateService.ensureEvaluated();
    gate.complete(_integrityOk);

    final results = await Future.wait([fromRouter, fromSplash]);
    expect(results[0].allowed, isTrue);
    expect(identical(results[0], results[1]), isTrue);
    expect(integrityCalls, 1);
  });
}
