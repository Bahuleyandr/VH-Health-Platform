// test/core/navigation/app_router_deep_link_test.dart
//
// Deep-link cold-start contract. A `vhhealth://app/<route>` launch normalizes
// straight to its target on the first routing pass and never renders the
// splash — which is exactly why the cold-start security gates (device
// integrity, minimum version) can no longer live only in the splash tap
// handler. The router-level guard (`AppRouter.startupGateRedirect`) must hold
// on EVERY path into a non-splash route: a deep link still lands on its target
// when the gates pass, and is intercepted to the inert splash (which surfaces
// the block UI) when they do not.

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:vhhealth/core/navigation/app_router.dart';
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

void _gatesPass() {
  StartupGateService.integrityCheck = () async => _integrityOk;
  StartupGateService.versionCheck = () async =>
      _versionResult(updateRequired: false);
}

/// The production redirect's deep-link-relevant pipeline, in production
/// order: custom-scheme normalization first, then the cold-start gate guard.
GoRouter _harnessRouter(String initialLocation) {
  return GoRouter(
    initialLocation: initialLocation,
    redirect: (_, state) async {
      final external = AppRouter.customSchemeRedirect(state.uri);
      if (external != null) return external;
      return AppRouter.startupGateRedirect(state.matchedLocation);
    },
    routes: [
      GoRoute(path: '/', builder: (_, _) => const Text('splash')),
      GoRoute(
        path: '/appointments',
        builder: (_, _) => const Text('appointments'),
      ),
    ],
  );
}

void main() {
  tearDown(StartupGateService.resetForTesting);

  testWidgets(
    'a deep-link cold start lands on its target when the startup gates pass',
    (tester) async {
      _gatesPass();
      final router = _harnessRouter('vhhealth://app/appointments');
      addTearDown(router.dispose);

      await tester.pumpWidget(MaterialApp.router(routerConfig: router));
      await tester.pumpAndSettle();

      expect(find.text('appointments'), findsOneWidget);
      expect(
        router.routeInformationProvider.value.uri,
        Uri.parse('/appointments'),
      );
    },
  );

  testWidgets(
    'an integrity hard-block intercepts a deep-link cold start onto the '
    'inert splash',
    (tester) async {
      StartupGateService.integrityCheck = () async => _integrityBlocked;
      StartupGateService.versionCheck = () async =>
          _versionResult(updateRequired: false);
      final router = _harnessRouter('vhhealth://app/appointments');
      addTearDown(router.dispose);

      await tester.pumpWidget(MaterialApp.router(routerConfig: router));
      await tester.pumpAndSettle();

      expect(find.text('appointments'), findsNothing);
      expect(find.text('splash'), findsOneWidget);
      expect(router.routeInformationProvider.value.uri, Uri.parse('/'));
    },
  );

  testWidgets(
    'a minimum-version hard-block intercepts a deep-link cold start onto the '
    'inert splash',
    (tester) async {
      StartupGateService.integrityCheck = () async => _integrityOk;
      StartupGateService.versionCheck = () async =>
          _versionResult(updateRequired: true);
      final router = _harnessRouter('vhhealth://app/appointments');
      addTearDown(router.dispose);

      await tester.pumpWidget(MaterialApp.router(routerConfig: router));
      await tester.pumpAndSettle();

      expect(find.text('appointments'), findsNothing);
      expect(find.text('splash'), findsOneWidget);
      expect(router.routeInformationProvider.value.uri, Uri.parse('/'));
    },
  );

  testWidgets('a malformed custom URI goes to the inert splash', (
    tester,
  ) async {
    _gatesPass();
    final router = _harnessRouter('vhhealth://app/admin/users');
    addTearDown(router.dispose);

    await tester.pumpWidget(MaterialApp.router(routerConfig: router));
    await tester.pumpAndSettle();

    expect(find.text('splash'), findsOneWidget);
    expect(router.routeInformationProvider.value.uri, Uri.parse('/'));
  });

  test('AppRouter leaves externally-owned HTTPS links unclaimed', () {
    expect(
      AppRouter.customSchemeRedirect(
        Uri.parse('https://vhhealth.app/appointments'),
      ),
      isNull,
    );
  });

  test('startupGateRedirect never gates the splash route itself', () async {
    // The splash must always be renderable — it is both where a block is
    // surfaced and where the gates are retried, so gating it would deadlock.
    var evaluated = false;
    StartupGateService.integrityCheck = () async {
      evaluated = true;
      return _integrityBlocked;
    };

    expect(await AppRouter.startupGateRedirect('/'), isNull);
    expect(evaluated, isFalse);
  });

  test('a throwing gate evaluation fails closed to the splash', () async {
    StartupGateService.integrityCheck = () async =>
        throw StateError('integrity probe unavailable');

    expect(await AppRouter.startupGateRedirect('/appointments'), '/');
  });

  test('the production redirect holds the startup gates on every non-splash '
      'route', () {
    // Source-level pin, same technique as patient_session_expiry_wiring_test:
    // the guard being dropped from the production redirect would silently
    // re-open the deep-link cold-start bypass while every harness test here
    // kept passing.
    final routerSource = File(
      'lib/core/navigation/app_router.dart',
    ).readAsStringSync();
    expect(
      RegExp(r'await startupGateRedirect\(location\)').hasMatch(routerSource),
      isTrue,
      reason:
          'AppRouter.redirect must await startupGateRedirect so the '
          'integrity + minimum-version gates hold on deep-link cold starts',
    );
  });
}
