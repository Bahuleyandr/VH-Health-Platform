import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth_staff/core/providers/message_unread_provider.dart';
import 'package:vhhealth_staff/core/providers/notification_provider.dart';
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
    final notifications = _TrackingNotificationProvider();
    addTearDown(timeout.dispose);
    addTearDown(notifications.dispose);
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
      MultiProvider(
        providers: [
          ChangeNotifierProvider<SessionTimeoutProvider>.value(value: timeout),
          ChangeNotifierProvider<NotificationProvider>.value(
            value: notifications,
          ),
        ],
        child: MaterialApp.router(routerConfig: router),
      ),
    );
    await tester.tap(find.text('Start logout'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Logout'));
    await tester.pumpAndSettle();

    expect(timeout.isTracking, isFalse);
    expect(notifications.endCalls, 1);
    expect(notifications.lastUnregisterBackend, isFalse);
    expect(find.text('Login destination'), findsOneWidget);
  });

  testWidgets(
    'successful logout clears captured providers after host disposal',
    (tester) async {
      final releaseLogout = Completer<void>();
      final timeout = SessionTimeoutProvider(
        timeoutDuration: const Duration(hours: 1),
      )..startTracking();
      final messages = MessageUnreadProvider()..setUnreadCountFromServer(5);
      addTearDown(timeout.dispose);
      addTearDown(messages.dispose);

      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider<SessionTimeoutProvider>.value(
              value: timeout,
            ),
            ChangeNotifierProvider<MessageUnreadProvider>.value(
              value: messages,
            ),
          ],
          child: MaterialApp(
            home: Scaffold(
              body: Builder(
                builder: (context) => ElevatedButton(
                  onPressed: () => unawaited(
                    LogoutFlow.start(
                      context,
                      confirmationTitle: 'Confirm',
                      confirmationBody: 'Confirm body',
                      logoutOperation: () async {
                        await releaseLogout.future;
                        return const StaffLogoutResult.signedOut();
                      },
                    ),
                  ),
                  child: const Text('Start logout'),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Start logout'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Logout'));
      await tester.pump();

      await tester.pumpWidget(const MaterialApp(home: SizedBox.shrink()));
      releaseLogout.complete();
      await tester.pump();

      expect(timeout.isTracking, isFalse);
      expect(messages.unreadCount, 0);
    },
  );

  testWidgets(
    'idle teardown unregisters notifications while auth is available',
    (tester) async {
      final notifications = _TrackingNotificationProvider();
      late BuildContext hostContext;
      addTearDown(notifications.dispose);

      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider<NotificationProvider>.value(
              value: notifications,
            ),
          ],
          child: MaterialApp(
            home: Builder(
              builder: (context) {
                hostContext = context;
                return const SizedBox.shrink();
              },
            ),
          ),
        ),
      );

      await stopStaffRealtimePollers(
        hostContext,
        unregisterNotificationBackend: true,
      );

      expect(notifications.endCalls, 1);
      expect(notifications.lastUnregisterBackend, isTrue);
    },
  );

  testWidgets(
    'combined logout failure preserves live-bearer recovery guidance',
    (tester) async {
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
                      const StaffLogoutResult.signedOut(
                        serverRevocationFailed: true,
                        notificationTeardownFailed: true,
                      ),
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

      await tester.pumpWidget(MaterialApp.router(routerConfig: router));
      await tester.tap(find.text('Start logout'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Logout'));
      await tester.pumpAndSettle();

      expect(find.text('Login destination'), findsOneWidget);
      expect(
        find.textContaining('server did not confirm the session was revoked'),
        findsOneWidget,
      );
      expect(
        find.textContaining('previous notification channel was removed'),
        findsOneWidget,
      );
      expect(find.textContaining('sign in and out again'), findsOneWidget);
    },
  );
}

class _TrackingNotificationProvider extends NotificationProvider {
  int endCalls = 0;
  bool? lastUnregisterBackend;

  @override
  Future<void> endAuthenticatedSession({bool unregisterBackend = true}) async {
    endCalls += 1;
    lastUnregisterBackend = unregisterBackend;
  }
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
