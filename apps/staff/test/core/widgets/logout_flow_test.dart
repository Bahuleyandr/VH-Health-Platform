import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth_staff/core/providers/session_timeout_provider.dart';
import 'package:vhhealth_staff/core/services/auth_service.dart';
import 'package:vhhealth_staff/core/widgets/logout_flow.dart';

void main() {
  test(
    'forced server-expiry flow preserves count and performs one handoff',
    () async {
      var cleanupCalls = 0;
      var stopCalls = 0;
      var navigationCalls = 0;
      int? reportedCount;

      await ForcedLogoutFlow.run(
        forcedLogout: () async {
          cleanupCalls += 1;
          return 4;
        },
        stopSessionTracking: () => stopCalls += 1,
        navigateToLogin: () => navigationCalls += 1,
        reportPreservedItems: (count) => reportedCount = count,
      );

      expect(cleanupCalls, 1);
      expect(stopCalls, 1);
      expect(navigationCalls, 1);
      expect(reportedCount, 4);
    },
  );

  test('HTTP and realtime expiry callbacks share one forced cleanup', () async {
    final release = Completer<void>();
    var cleanupCalls = 0;
    var navigationCalls = 0;
    var reportCalls = 0;

    Future<int> cleanup() async {
      cleanupCalls += 1;
      await release.future;
      return 2;
    }

    final httpExpiry = ForcedLogoutFlow.run(
      forcedLogout: cleanup,
      navigateToLogin: () => navigationCalls += 1,
      reportPreservedItems: (_) => reportCalls += 1,
    );
    final realtimeExpiry = ForcedLogoutFlow.run(
      forcedLogout: cleanup,
      navigateToLogin: () => navigationCalls += 1,
      reportPreservedItems: (_) => reportCalls += 1,
    );

    expect(cleanupCalls, 1);
    release.complete();
    await Future.wait([httpExpiry, realtimeExpiry]);
    expect(cleanupCalls, 1);
    expect(navigationCalls, 1);
    expect(reportCalls, 1);
  });

  testWidgets('cancel performs no logout operation', (tester) async {
    var logoutCalls = 0;
    await tester.pumpWidget(
      _logoutHost(
        logoutOperation: () async {
          logoutCalls += 1;
          return const StaffLogoutResult.signedOut();
        },
      ),
    );

    await tester.tap(find.text('Start logout'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();

    expect(logoutCalls, 0);
    expect(find.text('Home'), findsOneWidget);
  });

  testWidgets(
    'blocked logout shows approved clinical copy and stays signed in',
    (tester) async {
      var syncOpenCalls = 0;
      await tester.pumpWidget(
        _logoutHost(
          logoutOperation: () async => const StaffLogoutResult.blocked(3),
          syncStatusOpener: (_) async {
            syncOpenCalls += 1;
          },
        ),
      );

      await tester.tap(find.text('Start logout'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Logout'));
      await tester.pumpAndSettle();

      expect(
        find.text('Sign out blocked — offline clinical work needs review'),
        findsOneWidget,
      );
      expect(
        find.text(
          'You have 3 unresolved offline clinical item(s). To prevent loss or '
          'recording under the wrong staff account, you cannot sign out yet. '
          'Open Sync status and follow the reconciliation handoff.',
        ),
        findsOneWidget,
      );

      await tester.tap(find.text('Stay signed in'));
      await tester.pumpAndSettle();
      expect(syncOpenCalls, 0);
      expect(find.text('Home'), findsOneWidget);
    },
  );

  testWidgets('blocked logout opens Sync status only from review action', (
    tester,
  ) async {
    var syncOpenCalls = 0;
    await tester.pumpWidget(
      _logoutHost(
        logoutOperation: () async => const StaffLogoutResult.blocked(1),
        syncStatusOpener: (_) async {
          syncOpenCalls += 1;
        },
      ),
    );

    await tester.tap(find.text('Start logout'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Logout'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Review offline work'));
    await tester.pumpAndSettle();

    expect(syncOpenCalls, 1);
    expect(find.text('Home'), findsOneWidget);
  });

  testWidgets('successful logout stops tracking and navigates to login', (
    tester,
  ) async {
    final timeout = SessionTimeoutProvider(
      timeoutDuration: const Duration(hours: 1),
    )..startTracking();
    addTearDown(timeout.dispose);
    final router = GoRouter(
      routes: [
        GoRoute(
          path: '/',
          builder: (context, state) => Scaffold(
            body: ElevatedButton(
              onPressed: () => LogoutFlow.start(
                context,
                confirmationTitle: 'Confirm',
                confirmationBody: 'Confirm body',
                logoutOperation: () async =>
                    const StaffLogoutResult.signedOut(),
              ),
              child: const Text('Start logout'),
            ),
          ),
        ),
        GoRoute(
          path: '/login',
          builder: (context, state) =>
              const Scaffold(body: Text('Login destination')),
        ),
      ],
    );
    addTearDown(router.dispose);

    await tester.pumpWidget(
      ChangeNotifierProvider<SessionTimeoutProvider>.value(
        value: timeout,
        child: MaterialApp.router(routerConfig: router),
      ),
    );
    await tester.tap(find.text('Start logout'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Logout'));
    await tester.pumpAndSettle();

    expect(timeout.isTracking, isFalse);
    expect(find.text('Login destination'), findsOneWidget);
  });
}

Widget _logoutHost({
  required StaffLogoutOperation logoutOperation,
  StaffSyncStatusOpener? syncStatusOpener,
}) {
  return MaterialApp(
    home: Scaffold(
      body: Builder(
        builder: (context) => Column(
          children: [
            const Text('Home'),
            ElevatedButton(
              onPressed: () => LogoutFlow.start(
                context,
                confirmationTitle: 'Confirm',
                confirmationBody: 'Confirm body',
                logoutOperation: logoutOperation,
                syncStatusOpener: syncStatusOpener,
              ),
              child: const Text('Start logout'),
            ),
          ],
        ),
      ),
    ),
  );
}
