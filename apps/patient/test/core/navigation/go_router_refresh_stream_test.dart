import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:vhhealth/core/navigation/go_router_refresh_stream.dart';

void main() {
  group('GoRouterRefreshStream', () {
    test('notifies listeners on every stream event', () async {
      final controller = StreamController<int>();
      final refresh = GoRouterRefreshStream(controller.stream);
      var notifications = 0;
      refresh.addListener(() => notifications++);

      controller.add(1);
      controller.add(2);
      await Future<void>.delayed(Duration.zero);

      expect(notifications, 2);

      await controller.close();
      refresh.dispose();
    });

    test('stops notifying after dispose', () async {
      final controller = StreamController<int>();
      final refresh = GoRouterRefreshStream(controller.stream);
      var notifications = 0;
      refresh.addListener(() => notifications++);

      controller.add(1);
      await Future<void>.delayed(Duration.zero);
      expect(notifications, 1);

      refresh.dispose();
      controller.add(2);
      await Future<void>.delayed(Duration.zero);

      expect(notifications, 1);
      await controller.close();
    });
  });

  group('GoRouter with GoRouterRefreshStream (app_router wiring shape)', () {
    testWidgets(
      'auth-state stream event re-runs redirect and lands on /login — '
      'exactly what happens when LogoutService signs out of Firebase',
      (tester) async {
        // Stand-in for FirebaseAuth.instance.authStateChanges(): the real
        // stream cannot be used in tests without a Firebase app, but the
        // mechanism under test (stream event → refreshListenable →
        // redirect re-evaluation) is identical.
        final authStateChanges = StreamController<Object?>.broadcast();
        var isLoggedIn = true;

        final router = GoRouter(
          initialLocation: '/home',
          refreshListenable: GoRouterRefreshStream(authStateChanges.stream),
          redirect: (context, state) {
            if (!isLoggedIn && state.matchedLocation != '/login') {
              return '/login';
            }
            return null;
          },
          routes: [
            GoRoute(
              path: '/home',
              builder: (context, state) => const Text('home-screen'),
            ),
            GoRoute(
              path: '/login',
              builder: (context, state) => const Text('login-screen'),
            ),
          ],
        );
        addTearDown(() {
          router.dispose();
          authStateChanges.close();
        });

        await tester.pumpWidget(MaterialApp.router(routerConfig: router));
        expect(find.text('home-screen'), findsOneWidget);

        // Simulate LogoutService: session signals die, then Firebase
        // signs out and its auth-state stream emits.
        isLoggedIn = false;
        authStateChanges.add(null);
        await tester.pumpAndSettle();

        expect(find.text('login-screen'), findsOneWidget);
        expect(find.text('home-screen'), findsNothing);
      },
    );

    testWidgets(
      'without a refresh event the redirect does not re-run (the pre-fix '
      'stranding behavior)',
      (tester) async {
        final authStateChanges = StreamController<Object?>.broadcast();
        var isLoggedIn = true;

        final router = GoRouter(
          initialLocation: '/home',
          refreshListenable: GoRouterRefreshStream(authStateChanges.stream),
          redirect: (context, state) {
            if (!isLoggedIn && state.matchedLocation != '/login') {
              return '/login';
            }
            return null;
          },
          routes: [
            GoRoute(
              path: '/home',
              builder: (context, state) => const Text('home-screen'),
            ),
            GoRoute(
              path: '/login',
              builder: (context, state) => const Text('login-screen'),
            ),
          ],
        );
        addTearDown(() {
          router.dispose();
          authStateChanges.close();
        });

        await tester.pumpWidget(MaterialApp.router(routerConfig: router));

        // Session dies but nothing pokes the router.
        isLoggedIn = false;
        await tester.pumpAndSettle();

        expect(find.text('home-screen'), findsOneWidget);
      },
    );
  });
}
