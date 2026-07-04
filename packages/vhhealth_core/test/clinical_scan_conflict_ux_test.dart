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
  final transfusionConflict = <String, dynamic>{
    'id': 31,
    'endpoint': '/blood-bank/42/verify-bedside',
    'method': 'POST',
    'context_label': 'Transfusion verification #42',
    'conflict_reason': 'Patient identity mismatch',
    'created_at': DateTime(2026, 7, 4, 9, 0).millisecondsSinceEpoch,
  };

  final specimenConflict = <String, dynamic>{
    'id': 32,
    'endpoint': '/lab/samples/77/collect',
    'method': 'POST',
    'context_label': 'Specimen collection #77',
    'conflict_reason': 'Specimen order already collected',
    'created_at': DateTime(2026, 7, 4, 9, 5).millisecondsSinceEpoch,
  };

  testWidgets('transfusion conflicts use clinical not-recorded copy', (
    tester,
  ) async {
    await _pumpRow(tester, conflict: transfusionConflict);

    expect(
      find.textContaining(
        'Transfusion verification not recorded on the server',
      ),
      findsOneWidget,
    );
    expect(find.textContaining('Patient identity mismatch'), findsOneWidget);
  });

  testWidgets('transfusion discard requires confirmation', (tester) async {
    var discarded = false;
    await _pumpRow(
      tester,
      conflict: transfusionConflict,
      onDiscard: () => discarded = true,
    );

    await tester.tap(find.text('Discard'));
    await tester.pumpAndSettle();

    expect(
      find.textContaining('Discard transfusion verification?'),
      findsOneWidget,
    );

    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(discarded, isFalse);
  });

  testWidgets('specimen conflicts use clinical not-recorded copy', (
    tester,
  ) async {
    await _pumpRow(tester, conflict: specimenConflict);

    expect(
      find.textContaining('Specimen collection not recorded on the server'),
      findsOneWidget,
    );
    expect(
      find.textContaining('Specimen order already collected'),
      findsOneWidget,
    );
  });

  testWidgets('specimen discard requires confirmation', (tester) async {
    var discarded = false;
    await _pumpRow(
      tester,
      conflict: specimenConflict,
      onDiscard: () => discarded = true,
    );

    await tester.tap(find.text('Discard'));
    await tester.pumpAndSettle();

    expect(find.textContaining('Discard specimen collection?'), findsOneWidget);

    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(discarded, isFalse);
  });
}
