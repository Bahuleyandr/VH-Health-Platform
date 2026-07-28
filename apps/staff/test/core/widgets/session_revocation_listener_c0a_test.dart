import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth_staff/core/providers/session_timeout_provider.dart';
import 'package:vhhealth_staff/core/widgets/session_revocation_listener.dart';

void main() {
  testWidgets('forced revocation reports preserved count and routes to login', (
    tester,
  ) async {
    final events = StreamController<dynamic>.broadcast();
    addTearDown(events.close);
    final timeout = SessionTimeoutProvider(
      timeoutDuration: const Duration(hours: 1),
    )..startTracking();
    addTearDown(timeout.dispose);
    var forcedLogoutCalls = 0;
    final router = GoRouter(
      routes: [
        GoRoute(
          path: '/',
          builder: (context, state) => const Scaffold(body: Text('Home')),
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
        child: MaterialApp.router(
          routerConfig: router,
          builder: (context, child) => SessionRevocationListener(
            revocationEvents: events.stream,
            forcedLogout: () async {
              forcedLogoutCalls += 1;
              return 2;
            },
            navigateToLogin: () => router.go('/login'),
            child: child ?? const SizedBox.shrink(),
          ),
        ),
      ),
    );
    await tester.pump();

    events.add({'reason': 'new_login_elsewhere'});
    await tester.pumpAndSettle();

    expect(forcedLogoutCalls, 1);
    expect(timeout.isTracking, isFalse);
    expect(find.text('Login destination'), findsOneWidget);
    expect(
      find.text(
        '2 unresolved offline clinical item(s) remain encrypted on this '
        'device for later reconciliation.',
      ),
      findsOneWidget,
    );
  });

  testWidgets('duplicate in-flight events invoke forced cleanup once', (
    tester,
  ) async {
    final events = StreamController<dynamic>.broadcast();
    addTearDown(events.close);
    final timeout = SessionTimeoutProvider(
      timeoutDuration: const Duration(hours: 1),
    )..startTracking();
    addTearDown(timeout.dispose);
    final releaseCleanup = Completer<void>();
    var forcedLogoutCalls = 0;
    final router = GoRouter(
      routes: [
        GoRoute(
          path: '/',
          builder: (context, state) => const Scaffold(body: Text('Home')),
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
        child: MaterialApp.router(
          routerConfig: router,
          builder: (context, child) => SessionRevocationListener(
            revocationEvents: events.stream,
            forcedLogout: () async {
              forcedLogoutCalls += 1;
              await releaseCleanup.future;
              return 1;
            },
            navigateToLogin: () => router.go('/login'),
            child: child ?? const SizedBox.shrink(),
          ),
        ),
      ),
    );
    await tester.pump();

    events
      ..add(const {'reason': 'new_login_elsewhere'})
      ..add(const {'reason': 'new_login_elsewhere'});
    await tester.pump();
    expect(forcedLogoutCalls, 1);

    releaseCleanup.complete();
    await tester.pumpAndSettle();
    expect(forcedLogoutCalls, 1);
  });
}
