import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:vhhealth_staff/core/navigation/app_router.dart';
import 'package:vhhealth_staff/features/nursing/screens/mar_scan_screen.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  final route = appRouter.configuration.routes
      .whereType<ShellRoute>()
      .expand((shell) => shell.routes)
      .whereType<GoRoute>()
      .singleWhere((candidate) => candidate.name == 'mar-scan');

  for (final segment in [
    'abc',
    '0',
    '-7',
    '+7',
    '07',
    '7suffix',
    '7.0',
    '2147483648',
    '999999999999999999999999999999',
    '%2B7',
    '%207',
    '7%20',
    '7%0A',
    '7%0D',
    '7%09',
    '7%2F8',
    '%2F7',
    '%EF%BC%97',
  ]) {
    testWidgets('declared MAR route rejects $segment', (tester) async {
      final router = GoRouter(
        routes: [route],
        initialLocation: '/mar/scan/$segment',
      );
      addTearDown(router.dispose);

      await tester.pumpWidget(MaterialApp.router(routerConfig: router));
      await tester.pumpAndSettle();

      expect(find.byType(MarScanScreen), findsNothing);
      expect(find.textContaining('Page not found: '), findsOneWidget);
      expect(find.text('Go Home'), findsOneWidget);
    });
  }

  testWidgets('malformed MAR route preserves Go Home navigation', (
    tester,
  ) async {
    final router = GoRouter(
      routes: [
        route,
        GoRoute(
          path: '/dashboard',
          builder: (context, state) => const Scaffold(body: Text('Dashboard')),
        ),
      ],
      initialLocation: '/mar/scan/abc',
    );
    addTearDown(router.dispose);

    await tester.pumpWidget(MaterialApp.router(routerConfig: router));
    await tester.pumpAndSettle();

    expect(find.byType(MarScanScreen), findsNothing);
    expect(find.text('Page not found: /mar/scan/abc'), findsOneWidget);
    await tester.tap(find.text('Go Home'));
    await tester.pumpAndSettle();
    expect(find.text('Dashboard'), findsOneWidget);
  });

  testWidgets('malformed MAR route IDs show the route error, not the scanner', (
    tester,
  ) async {
    for (final rawMaId in <String?>[
      null,
      '',
      'abc',
      '0',
      '-7',
      '+7',
      '07',
      ' 7',
      '7 ',
      '7\n',
      '7\r',
      '7\t',
      '7.0',
      '2147483648',
      '999999999999999999999999999999',
    ]) {
      final route = '/mar/scan/${rawMaId ?? ''}';
      await tester.pumpWidget(
        MaterialApp(
          home: buildMarScanScreenForRoute(rawMaId: rawMaId, route: route),
        ),
      );

      expect(find.byType(MarScanScreen), findsNothing, reason: route);
      expect(find.text('Page not found: $route'), findsOneWidget);
      expect(find.text('Go Home'), findsOneWidget);
    }
  });

  test('valid MAR route IDs reach the scanner unchanged', () {
    for (final maId in [1, 42, 2147483647]) {
      final screen = buildMarScanScreenForRoute(
        rawMaId: '$maId',
        route: '/mar/scan/$maId',
      );

      expect(screen, isA<MarScanScreen>());
      expect((screen as MarScanScreen).maId, maId);
    }
  });

  for (final maId in [1, 42, 2147483647]) {
    testWidgets('declared MAR route preserves valid ID $maId', (tester) async {
      Widget? screen;
      final router = GoRouter(
        routes: [
          GoRoute(
            path: route.path,
            name: route.name,
            pageBuilder: (context, state) {
              final page =
                  route.pageBuilder!(context, state) as NoTransitionPage;
              screen = page.child;
              return const NoTransitionPage(child: SizedBox());
            },
          ),
        ],
        initialLocation: '/mar/scan/$maId',
      );
      addTearDown(router.dispose);

      await tester.pumpWidget(MaterialApp.router(routerConfig: router));
      await tester.pumpAndSettle();

      expect(screen, isA<MarScanScreen>());
      expect((screen! as MarScanScreen).maId, maId);
    });
  }
}
