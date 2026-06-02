import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:vhhealth_staff/core/widgets/navigation_back_action.dart';

void main() {
  testWidgets('NavigationBackAction pops the GoRouter stack first', (
    tester,
  ) async {
    final router = GoRouter(
      initialLocation: '/first',
      routes: [
        GoRoute(
          path: '/first',
          builder: (context, state) => Scaffold(
            body: Center(
              child: ElevatedButton(
                onPressed: () => context.push('/second'),
                child: const Text('Open second'),
              ),
            ),
          ),
        ),
        GoRoute(
          path: '/second',
          builder: (context, state) => Scaffold(
            appBar: AppBar(leading: const NavigationBackAction()),
            body: const Center(child: Text('Second page')),
          ),
        ),
      ],
    );

    await tester.pumpWidget(MaterialApp.router(routerConfig: router));
    await tester.tap(find.text('Open second'));
    await tester.pumpAndSettle();

    expect(find.text('Second page'), findsOneWidget);

    await tester.tap(find.byTooltip('Back'));
    await tester.pumpAndSettle();

    expect(find.text('Open second'), findsOneWidget);
    expect(find.text('Second page'), findsNothing);
  });
}
