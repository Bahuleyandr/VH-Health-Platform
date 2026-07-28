import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/widgets/offline_sync_badge.dart';

Future<void> _pumpConflict(
  WidgetTester tester, {
  required String endpoint,
  required String method,
  required VoidCallback onDiscard,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: ConflictRow(
          conflict: {
            'id': 1,
            'endpoint': endpoint,
            'method': method,
            'context_label': 'Clinical item',
            'conflict_reason': 'Server rejected the write',
            'created_at': DateTime(2026, 7, 28, 10).millisecondsSinceEpoch,
          },
          onDiscard: onDiscard,
          onRetry: () {},
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  group('clinicalDiscardGuardFor', () {
    final protected = <(String, String, ClinicalDiscardGuard)>[
      ('POST', '/prescriptions/create', ClinicalDiscardGuard.prescription),
      ('post', '/emr/orders', ClinicalDiscardGuard.order),
      (
        'POST',
        '/clinical/mar/12/administer-with-scan',
        ClinicalDiscardGuard.mar,
      ),
      ('POST', '/lab/samples/34/collect', ClinicalDiscardGuard.specimen),
      (
        'POST',
        '/blood-bank/56/verify-bedside',
        ClinicalDiscardGuard.transfusion,
      ),
      ('POST', '/emr/notes', ClinicalDiscardGuard.notes),
      ('PUT', '/emr/notes/draft', ClinicalDiscardGuard.notes),
      ('PATCH', '/emr/notes/19', ClinicalDiscardGuard.notes),
      ('DELETE', '/emr/notes/19', ClinicalDiscardGuard.notes),
      ('POST', '/health/records', ClinicalDiscardGuard.vitals),
    ];

    for (final (method, endpoint, guard) in protected) {
      test('$method $endpoint requires ${guard.name} confirmation', () {
        expect(clinicalDiscardGuardFor(method, endpoint), guard);
      });
    }

    test('does not widen to wrong methods or lookalike routes', () {
      expect(clinicalDiscardGuardFor('GET', '/emr/notes'), isNull);
      expect(clinicalDiscardGuardFor('POST', '/emr/notes-lookalike'), isNull);
      expect(clinicalDiscardGuardFor('POST', '/health/records/19'), isNull);
      expect(
        clinicalDiscardGuardFor(
          'POST',
          '/clinical/mar/-1/administer-with-scan',
        ),
        isNull,
      );
      expect(
        clinicalDiscardGuardFor(
          'POST',
          '/blood-bank/4/verify-bedside?force=true',
        ),
        isNull,
      );
    });
  });

  testWidgets('vitals cancellation deletes nothing and confirm deletes once', (
    tester,
  ) async {
    var discardCount = 0;
    await _pumpConflict(
      tester,
      endpoint: '/health/records',
      method: 'POST',
      onDiscard: () => discardCount++,
    );

    await tester.tap(find.text('Discard'));
    await tester.pumpAndSettle();

    expect(
      find.text(
        'Vitals not recorded on the server — review needed. Review the patient chart before discarding.',
      ),
      findsOneWidget,
    );
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(discardCount, 0);

    await tester.tap(find.text('Discard'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Discard after reconciliation'));
    await tester.pumpAndSettle();
    expect(discardCount, 1);
  });

  testWidgets('all mutating notes routes use the exact clinical framing', (
    tester,
  ) async {
    var discardCount = 0;
    await _pumpConflict(
      tester,
      endpoint: '/emr/notes/draft',
      method: 'PUT',
      onDiscard: () => discardCount++,
    );

    expect(
      find.textContaining(
        'Note data on this device is not reconciled with the server. Review before discarding.',
      ),
      findsOneWidget,
    );
    await tester.tap(find.text('Discard'));
    await tester.pumpAndSettle();
    expect(
      find.text(
        'Note data on this device is not reconciled with the server. Review before discarding.',
      ),
      findsOneWidget,
    );
    await tester.tap(find.text('Discard after reconciliation'));
    await tester.pumpAndSettle();
    expect(discardCount, 1);
  });
}
