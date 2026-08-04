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

  testWidgets('shows server-authorized I19 release and never exposes I18', (
    tester,
  ) async {
    final client = _FakeClient(_workbench(heldMessage: true));
    await tester.pumpWidget(
      _host(PaperReconciliationWorkbenchScreen(client: client)),
    );
    await tester.pumpAndSettle();

    const itemId = '44444444-4444-4444-8444-444444444444';
    expect(find.byKey(const Key('held-message-$itemId')), findsOne);
    expect(find.byKey(const Key('release-held-message-$itemId')), findsOne);
    expect(find.textContaining('I18'), findsNothing);

    final releaseButton = find.byKey(const Key('release-held-message-$itemId'));
    await tester.ensureVisible(releaseButton);
    await tester.pumpAndSettle();
    await tester.tap(releaseButton);
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const Key('held-release-detail')),
      'Owner evidence and runtime readiness were reconciled.',
    );
    await tester.tap(find.byKey(const Key('submit-held-release')));
    await tester.pumpAndSettle();

    expect(client.releasedItemId, itemId);
    expect(client.releaseIdempotencyKey, 'held-message-release:$itemId:v3');
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

ClinicalContinuityWorkbench _workbench({bool heldMessage = false}) {
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
    reconciliationItems: heldMessage
        ? [
            ClinicalContinuityReconciliationItem(
              id: '44444444-4444-4444-8444-444444444444',
              incidentId: '11111111-1111-4111-8111-111111111111',
              queueType: ClinicalContinuityQueueType.interface,
              disposition: ClinicalContinuityReconciliationItemDisposition.open,
              reasonCode: 'outbound_recovery_owner_reconciliation',
              safetyCritical: false,
              ownerPrincipal: 'role:admin',
              assignedToUid: '33333333-3333-4333-8333-333333333333',
              taskId: 47,
              taskStatus: 'open',
              interfaceItemKind:
                  ClinicalContinuityReconciliationItemInterfaceItemKind
                      .heldMessageRelease,
              interfaceFamily: ClinicalContinuityHeldMessageFamily.i19,
              nhcxMessageId: 47,
              holdReasonCode: 'outbound_recovery_owner_reconciliation',
              holdSafetyClass:
                  ClinicalContinuityHeldMessageSafetyClass.routineOperational,
              sourceStateFingerprint: List.filled(64, 'a').join(),
              sourceSafeEvidence: const {
                'status': 'recovery_pending',
                'cycle': 'claim',
              },
              canAttestRelease: false,
              canRelease: true,
              version: 3,
            ),
          ]
        : const [],
    temporaryIdentities: const [],
    deviceOffsets: const [],
    interfaces: const [],
    capabilities: const ClinicalContinuityWorkbench$Capabilities(
      canBind: false,
    ),
  );
}

class _FakeClient extends ClinicalContinuityReconciliationClient {
  _FakeClient(this.workbench);

  final ClinicalContinuityWorkbench workbench;
  String? releasedItemId;
  String? releaseIdempotencyKey;

  @override
  Future<ClinicalContinuityWorkbench> loadWorkbench() async => workbench;

  @override
  Future<ClinicalContinuityHeldMessageCommandResult> releaseHeldMessage({
    required String itemId,
    required ClinicalContinuityHeldMessageReleaseRequest request,
    required String idempotencyKey,
  }) async {
    releasedItemId = itemId;
    releaseIdempotencyKey = idempotencyKey;
    return const ClinicalContinuityHeldMessageCommandResult(
      disposition:
          ClinicalContinuityHeldMessageCommandResultDisposition.applied,
      networkSendPerformed: false,
    );
  }
}
