import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/main.dart';

void main() {
  testWidgets('held staff web surface exposes no clinical sign-in', (
    tester,
  ) async {
    await tester.pumpWidget(const StaffWebActivationHeldApp());

    expect(find.text('Staff Web is not activated'), findsOneWidget);
    expect(find.byType(TextField), findsNothing);
    expect(find.byType(ElevatedButton), findsNothing);
  });

  test('web hold is evaluated before reconciliation and offline startup', () {
    final source = File('lib/main.dart').readAsStringSync();
    final hold = source.indexOf('if (kIsWeb)');
    final reconciliation = source.indexOf(
      'C0AReconciliationConfig.registerBeforeQueueStartup()',
    );
    final connectivity = source.indexOf(
      'ConnectivitySyncService.instance.startListening()',
    );

    expect(hold, greaterThanOrEqualTo(0));
    expect(hold, lessThan(reconciliation));
    expect(hold, lessThan(connectivity));
  });
}
