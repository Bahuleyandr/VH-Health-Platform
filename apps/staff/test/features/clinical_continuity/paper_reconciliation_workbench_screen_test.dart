import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth_core/api/vhhealth_api.dart';
import 'package:vhhealth_core/vhhealth_core.dart';
import 'package:vhhealth_staff/core/providers/theme_provider.dart';
import 'package:vhhealth_staff/features/clinical_continuity/screens/paper_reconciliation_workbench_screen.dart';

void main() {
  testWidgets(
    'renders the inert Staff workbench from the shared typed contract',
    (tester) async {
      await tester.pumpWidget(
        _host(
          PaperReconciliationWorkbenchScreen(client: _FakeClient(_workbench())),
        ),
      );
      await tester.pump();

      expect(find.byKey(const Key('paper-reconciliation-workbench')), findsOne);
      expect(find.byKey(const Key('continuity-incident-selector')), findsOne);
      expect(find.byKey(const Key('record-paper-fact')), findsOne);
      expect(find.text('Paper facts'), findsOne);
      expect(find.text('Assigned reconciliation work'), findsOne);
      expect(find.textContaining('VALIDATION ONLY'), findsOne);
      expect(find.textContaining('activate', findRichText: true), findsNothing);

      final banner = find.byWidgetPredicate(
        (widget) =>
            widget is Semantics &&
            widget.properties.label?.contains('VALIDATION ONLY') == true,
      );
      expect(banner, findsOne);
    },
  );

  testWidgets('remains scrollable at 200 percent text scale', (tester) async {
    await tester.pumpWidget(
      _host(
        PaperReconciliationWorkbenchScreen(client: _FakeClient(_workbench())),
        textScale: 2,
      ),
    );
    await tester.pump();
    await tester.drag(
      find.byKey(const Key('paper-reconciliation-workbench')),
      const Offset(0, -250),
    );
    await tester.pump();

    expect(tester.takeException(), isNull);
    expect(find.byKey(const Key('paper-reconciliation-workbench')), findsOne);
  });
}

Widget _host(Widget child, {double textScale = 1}) {
  return ChangeNotifierProvider<ThemeProvider>(
    create: (_) => ThemeProvider(),
    child: MaterialApp(
      builder: (context, built) => MediaQuery(
        data: MediaQuery.of(
          context,
        ).copyWith(textScaler: TextScaler.linear(textScale)),
        child: built!,
      ),
      home: child,
    ),
  );
}

ClinicalContinuityWorkbench _workbench() {
  return ClinicalContinuityWorkbench(
    incidents: [
      ClinicalContinuityIncident(
        id: '11111111-1111-4111-8111-111111111111',
        facilityId: 17,
        packetId: '22222222-2222-4222-8222-222222222222',
        commanderUid: '33333333-3333-4333-8333-333333333333',
        commanderRole: 'CMO',
        lifecycleState: ClinicalContinuityIncidentState.reconciling,
        version: 7,
        declaredAt: DateTime.parse('2026-08-01T01:00:00.000Z'),
      ),
    ],
    packets: const [],
    paperRanges: const [],
    paperItems: const [],
    reconciliationItems: const [],
    temporaryIdentities: const [],
    deviceOffsets: const [],
    interfaces: const [],
  );
}

class _FakeClient extends ClinicalContinuityReconciliationClient {
  _FakeClient(this.workbench);

  final ClinicalContinuityWorkbench workbench;

  @override
  Future<ClinicalContinuityWorkbench> loadWorkbench() async => workbench;
}
