import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/widgets/offline_sync_badge.dart';

/// Pumps a single [ConflictRow] inside a minimal MaterialApp so we can drive
/// its row UI (clinical copy + confirm-on-discard) without faking the whole
/// ConnectivitySyncService singleton (a DB-backed ChangeNotifier). The row is
/// a pure widget: it takes the conflict map + onDiscard/onRetry callbacks.
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
  final marConflict = <String, dynamic>{
    'id': 7,
    'endpoint': '/clinical/mar/11/administer-with-scan',
    'method': 'POST',
    'context_label': 'Administer Paracetamol 500mg',
    'conflict_reason': 'Order discontinued',
    'created_at': DateTime(2026, 6, 27, 10, 0).millisecondsSinceEpoch,
  };

  final nonMarConflict = <String, dynamic>{
    'id': 8,
    'endpoint': '/clinical/vitals/22',
    'method': 'POST',
    'context_label': 'Vitals for bed 4',
    'conflict_reason': 'Resource was modified on the server',
    'created_at': DateTime(2026, 6, 27, 10, 5).millisecondsSinceEpoch,
  };

  group('ConflictRow — MAR conflict', () {
    testWidgets('shows the clinical not-recorded copy + the reason', (
      tester,
    ) async {
      await _pumpRow(tester, conflict: marConflict);

      // Clinical framing: the administration was NOT recorded on the server,
      // the drug WAS given offline, and the server reason is shown.
      expect(find.textContaining('not recorded on the server'), findsOneWidget);
      expect(find.textContaining('given offline'), findsOneWidget);
      expect(find.textContaining('Order discontinued'), findsOneWidget);
    });

    testWidgets(
      'Discard opens a confirmation dialog; cancel does NOT discard',
      (tester) async {
        var discarded = false;
        await _pumpRow(
          tester,
          conflict: marConflict,
          onDiscard: () => discarded = true,
        );

        await tester.tap(find.text('Discard'));
        await tester.pumpAndSettle();

        // A confirmation dialog must appear for a MAR conflict.
        expect(
          find.textContaining('Discard this administration record?'),
          findsOneWidget,
        );

        // Cancel → callback NOT fired.
        await tester.tap(find.text('Cancel'));
        await tester.pumpAndSettle();
        expect(discarded, isFalse);
      },
    );

    testWidgets('confirming the dialog fires onDiscard exactly once', (
      tester,
    ) async {
      var discardCount = 0;
      await _pumpRow(
        tester,
        conflict: marConflict,
        onDiscard: () => discardCount++,
      );

      await tester.tap(find.text('Discard'));
      await tester.pumpAndSettle();

      // Tap the destructive Discard inside the dialog (the second 'Discard').
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
        conflict: marConflict,
        onRetry: () => retried = true,
      );

      await tester.tap(find.text('Retry'));
      await tester.pumpAndSettle();

      expect(retried, isTrue);
      // No confirmation dialog for retry.
      expect(
        find.textContaining('Discard this administration record?'),
        findsNothing,
      );
    });
  });

  group('ConflictRow — non-MAR conflict', () {
    testWidgets('shows the generic reason, not the clinical copy', (
      tester,
    ) async {
      await _pumpRow(tester, conflict: nonMarConflict);

      // Generic reason text is rendered verbatim.
      expect(find.text('Resource was modified on the server'), findsOneWidget);
      // The MAR-specific clinical phrasing must NOT appear.
      expect(find.textContaining('given offline'), findsNothing);
      expect(find.textContaining('not recorded on the server'), findsNothing);
    });

    testWidgets('Discard fires immediately (no MAR confirmation dialog)', (
      tester,
    ) async {
      var discarded = false;
      await _pumpRow(
        tester,
        conflict: nonMarConflict,
        onDiscard: () => discarded = true,
      );

      await tester.tap(find.text('Discard'));
      await tester.pumpAndSettle();

      expect(discarded, isTrue);
      expect(
        find.textContaining('Discard this administration record?'),
        findsNothing,
      );
    });
  });
}
