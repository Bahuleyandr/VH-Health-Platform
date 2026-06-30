import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/widgets/offline_sync_badge.dart';

Future<void> _pumpRow(
  WidgetTester tester, {
  required Map<String, dynamic> conflict,
  VoidCallback? onDiscard,
  VoidCallback? onRetry,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: ConflictRow(
          conflict: conflict,
          onDiscard: onDiscard ?? () {},
          onRetry: onRetry ?? () {},
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  final orderConflict = <String, dynamic>{
    'id': 12,
    'endpoint': '/emr/orders',
    'method': 'POST',
    'context_label': 'Medication order — Paracetamol',
    'conflict_reason': 'Allergy conflict: penicillin',
    'created_at': DateTime(2026, 6, 27, 11, 0).millisecondsSinceEpoch,
  };

  testWidgets('shows the not-placed clinical copy + the server reason', (
    tester,
  ) async {
    await _pumpRow(tester, conflict: orderConflict);
    expect(find.textContaining('not placed on the server'), findsOneWidget);
    expect(find.textContaining('Allergy conflict: penicillin'), findsOneWidget);
  });

  testWidgets('Discard opens a confirmation dialog; cancel does NOT discard', (
    tester,
  ) async {
    var discarded = false;
    await _pumpRow(
      tester,
      conflict: orderConflict,
      onDiscard: () => discarded = true,
    );

    await tester.tap(find.text('Discard'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Discard medication order?'), findsOneWidget);

    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(discarded, isFalse);
  });

  testWidgets('confirming the dialog fires onDiscard exactly once', (
    tester,
  ) async {
    var discardCount = 0;
    await _pumpRow(
      tester,
      conflict: orderConflict,
      onDiscard: () => discardCount++,
    );

    await tester.tap(find.text('Discard'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(TextButton, 'Discard').last);
    await tester.pumpAndSettle();
    expect(discardCount, 1);
  });

  testWidgets('Retry fires onRetry without a confirmation dialog', (
    tester,
  ) async {
    var retried = false;
    await _pumpRow(
      tester,
      conflict: orderConflict,
      onRetry: () => retried = true,
    );

    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();
    expect(retried, isTrue);
    expect(find.textContaining('Discard medication order?'), findsNothing);
  });
}
