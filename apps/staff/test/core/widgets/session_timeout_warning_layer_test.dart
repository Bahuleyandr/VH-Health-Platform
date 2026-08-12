import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth_staff/core/providers/session_timeout_provider.dart';
import 'package:vhhealth_staff/core/widgets/session_timeout_warning_layer.dart';

void main() {
  testWidgets(
    'idle timeout blocks the patient surface while cleanup is still pending',
    (tester) async {
      final cleanupStarted = Completer<void>();
      final releaseCleanup = Completer<void>();
      var patientSurfaceTaps = 0;
      final timeout = SessionTimeoutProvider(
        timeoutDuration: const Duration(milliseconds: 10),
        beforeTimeoutCleanup: () async {
          cleanupStarted.complete();
          await releaseCleanup.future;
        },
        onTimeoutCleanup: () async {},
      );
      addTearDown(timeout.dispose);
      final router = GoRouter(
        routes: [
          GoRoute(
            path: '/',
            builder: (context, state) => Scaffold(
              body: TextButton(
                onPressed: () => patientSurfaceTaps += 1,
                child: const Text('Patient chart'),
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
          child: MaterialApp.router(
            routerConfig: router,
            builder: (context, child) => SessionTimeoutWarningLayer(
              navigateToLogin: () => router.go('/login'),
              child: child ?? const SizedBox.shrink(),
            ),
          ),
        ),
      );
      timeout.startTracking();
      await tester.pump(const Duration(milliseconds: 20));
      await cleanupStarted.future;
      await tester.pump();

      expect(find.byKey(staffSessionLockSurfaceKey), findsOneWidget);
      expect(find.text('Session locked'), findsOneWidget);
      await tester.tap(find.text('Patient chart'), warnIfMissed: false);
      expect(patientSurfaceTaps, 0);
      expect(find.text('Login destination'), findsNothing);

      releaseCleanup.complete();
      await tester.pumpAndSettle();

      expect(find.text('Login destination'), findsOneWidget);
      expect(find.byKey(staffSessionLockSurfaceKey), findsNothing);
    },
  );
}
