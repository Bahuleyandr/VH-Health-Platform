import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:vhhealth/core/navigation/app_router.dart';

void main() {
  testWidgets(
    'AppRouter redirects an allowlisted custom URI through GoRouter',
    (tester) async {
      final router = GoRouter(
        initialLocation: 'vhhealth://app/appointments',
        redirect: (_, state) => AppRouter.customSchemeRedirect(state.uri),
        routes: [
          GoRoute(path: '/', builder: (_, _) => const Text('splash')),
          GoRoute(
            path: '/appointments',
            builder: (_, _) => const Text('appointments'),
          ),
        ],
      );
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

  testWidgets('AppRouter sends a malformed custom URI to inert splash', (
    tester,
  ) async {
    final router = GoRouter(
      initialLocation: 'vhhealth://app/admin/users',
      redirect: (_, state) => AppRouter.customSchemeRedirect(state.uri),
      routes: [GoRoute(path: '/', builder: (_, _) => const Text('splash'))],
    );
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
}
