import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/navigation/app_router.dart';
import 'package:vhhealth_staff/features/nursing/screens/mar_scan_screen.dart';

void main() {
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
}
