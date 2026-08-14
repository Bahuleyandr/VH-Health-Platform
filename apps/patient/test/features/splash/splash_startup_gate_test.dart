// test/features/splash/splash_startup_gate_test.dart
//
// The splash consumes the same single-flight StartupGateService evaluation as
// the router-level cold-start guard, and remains the surface where a block is
// shown: the integrity blocker dialog and the update-required screen. These
// tests drive the REAL SplashScreen (auto-advance fires the tap handler) with
// only the gate probes injected.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:vhhealth/core/services/minimum_version_gate_service.dart';
import 'package:vhhealth/core/services/startup_gate_service.dart';
import 'package:vhhealth/features/splash/screens/splash_screen.dart';
import 'package:vhhealth/generated/app_localizations.dart';
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

/// Fires the 1800ms auto-advance timer, then bounded pumps for the async gate
/// evaluation + setState. pumpAndSettle is unusable here: the splash logo's
/// pulse animation repeats forever.
Future<void> _autoAdvance(WidgetTester tester) async {
  await tester.pump(const Duration(milliseconds: 1800));
  await tester.pump();
  await tester.pump();
  await tester.pump();
}

void main() {
  tearDown(StartupGateService.resetForTesting);

  testWidgets(
    'a minimum-version block holds the splash on the update-required screen',
    (tester) async {
      var versionCalls = 0;
      StartupGateService.integrityCheck = () async => _integrityOk;
      StartupGateService.versionCheck = () async {
        versionCalls++;
        return _versionResult(updateRequired: true);
      };

      await tester.pumpWidget(
        const MaterialApp(
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
          home: SplashScreen(),
        ),
      );
      await _autoAdvance(tester);

      expect(versionCalls, 1);
      expect(find.byIcon(Icons.system_update_alt), findsOneWidget);
    },
  );

  testWidgets('an integrity hard-block surfaces the blocker dialog', (
    tester,
  ) async {
    StartupGateService.integrityCheck = () async => _integrityBlocked;
    StartupGateService.versionCheck = () async =>
        _versionResult(updateRequired: false);

    await tester.pumpWidget(
      const MaterialApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: SplashScreen(),
      ),
    );
    await _autoAdvance(tester);

    expect(find.byType(AlertDialog), findsOneWidget);
    expect(find.textContaining('rooted_or_jailbroken'), findsOneWidget);
  });

  testWidgets('passing gates let the splash proceed off the splash route', (
    tester,
  ) async {
    StartupGateService.integrityCheck = () async => _integrityOk;
    StartupGateService.versionCheck = () async =>
        _versionResult(updateRequired: false);

    // No Firebase app is available in unit tests, so the tap handler's auth
    // probe throws and the splash takes its default fallback — /login. What
    // matters here is that a PASSING gate does not strand the user on splash.
    final router = GoRouter(
      initialLocation: '/',
      routes: [
        GoRoute(path: '/', builder: (_, _) => const SplashScreen()),
        GoRoute(
          path: '/login',
          builder: (_, _) => const Scaffold(body: Text('login-screen')),
        ),
      ],
    );
    addTearDown(router.dispose);

    await tester.pumpWidget(
      MaterialApp.router(
        routerConfig: router,
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
      ),
    );
    await _autoAdvance(tester);
    await tester.pump(const Duration(milliseconds: 400));

    expect(find.text('login-screen'), findsOneWidget);
    expect(StartupGateService.hasPassed, isTrue);
  });
}
