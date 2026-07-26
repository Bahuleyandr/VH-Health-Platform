import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/services/stemi_pathway_api_service.dart';
import 'package:vhhealth_staff/features/emergency/screens/ed_trauma_workbench_screen.dart';

void main() {
  final workbenchList = find.byKey(
    const ValueKey('ed-trauma-workbench-scroll'),
  );
  final workbenchScroll = find
      .descendant(of: workbenchList, matching: find.byType(Scrollable))
      .first;

  testWidgets('ED owner requests a receiving-role destination handoff', (
    tester,
  ) async {
    int? visitId;
    String? postedDestination;
    String? postedRole;
    String? postedReason;
    await tester.pumpWidget(
      MaterialApp(
        home: EdTraumaWorkbenchScreen(
          loadPolicy: () async => {
            'active': true,
            'canonical_triage_scale': 'esi',
          },
          loadDestinationHandoffs: () async => const [],
          requestDestinationHandoff:
              ({
                required emergencyVisitId,
                required destination,
                required intendedRecipientRole,
                required reason,
              }) async {
                visitId = emergencyVisitId;
                postedDestination = destination;
                postedRole = intendedRecipientRole;
                postedReason = reason;
                return const {};
              },
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byKey(const ValueKey('ed-handoff-visit-id')),
      '314',
    );
    await tester.enterText(
      find.byKey(const ValueKey('ed-handoff-role')),
      'icu_nurse',
    );
    await tester.enterText(
      find.byKey(const ValueKey('ed-handoff-reason')),
      'Needs ICU monitoring',
    );
    final request = find.byKey(const ValueKey('ed-handoff-request'));
    await tester.scrollUntilVisible(request, 250, scrollable: workbenchScroll);
    await tester.ensureVisible(request);
    await tester.pumpAndSettle();
    await tester.tap(request);
    await tester.pumpAndSettle();
    await tester.drag(workbenchList, const Offset(0, 1000));
    await tester.pumpAndSettle();

    expect(visitId, 314);
    expect(postedDestination, 'ward');
    expect(postedRole, 'ICU_NURSE');
    expect(postedReason, 'Needs ICU monitoring');
    expect(find.text('Destination handoff requested'), findsOneWidget);
  });

  testWidgets('exact receiving role can accept its queued ED handoff', (
    tester,
  ) async {
    String? postedDecision;
    await tester.pumpWidget(
      MaterialApp(
        home: EdTraumaWorkbenchScreen(
          loadPolicy: () async => {
            'active': true,
            'canonical_triage_scale': 'esi',
          },
          loadDestinationHandoffs: () async => [
            {
              'id': '550e8400-e29b-41d4-a716-446655440000',
              'emergency_visit_id': 314,
              'status': 'requested',
              'destination': 'icu',
              'intended_recipient_role': 'ICU_NURSE',
              'can_decide': true,
              'can_reroute': false,
              'decline_reason': null,
            },
          ],
          decideDestinationHandoff:
              ({
                required emergencyVisitId,
                required handoffId,
                required decision,
                reason,
              }) async {
                expect(emergencyVisitId, 314);
                expect(handoffId, '550e8400-e29b-41d4-a716-446655440000');
                postedDecision = decision;
                return const {};
              },
        ),
      ),
    );
    await tester.pumpAndSettle();

    final accept = find.byKey(
      const ValueKey('ed-handoff-accept-550e8400-e29b-41d4-a716-446655440000'),
    );
    await tester.scrollUntilVisible(accept, 250, scrollable: workbenchScroll);
    await tester.ensureVisible(accept);
    await tester.pumpAndSettle();
    await tester.tap(accept);
    await tester.pumpAndSettle();
    await tester.drag(workbenchList, const Offset(0, 1000));
    await tester.pumpAndSettle();

    expect(postedDecision, 'accept');
    expect(find.text('Destination handoff accepted'), findsOneWidget);
  });

  testWidgets('Code STEMI action posts the ED patient and visit context', (
    tester,
  ) async {
    Map<String, dynamic>? postedBody;
    await tester.pumpWidget(
      MaterialApp(
        home: EdTraumaWorkbenchScreen(
          loadPolicy: () async => {
            'active': true,
            'canonical_triage_scale': 'esi',
          },
          createStemiActivation: (body) async {
            postedBody = body;
            return {'id': 77, 'status': 'activated'};
          },
        ),
      ),
    );
    await tester.pump();
    await tester.pump();

    await tester.enterText(
      find.byKey(const ValueKey('stemi-ed-visit-id')),
      '314',
    );
    await tester.enterText(
      find.byKey(const ValueKey('stemi-patient-uid')),
      '11111111-1111-4111-8111-111111111111',
    );
    final activate = find.byKey(const ValueKey('code-stemi-activate'));
    await tester.scrollUntilVisible(activate, 250, scrollable: workbenchScroll);
    await tester.ensureVisible(activate);
    await tester.pumpAndSettle();
    await tester.tap(activate);
    await tester.pump();
    await tester.pump();

    expect(postedBody, {
      'patient_uid': '11111111-1111-4111-8111-111111111111',
      'emergency_visit_id': 314,
      'activation_source': 'clinician',
    });
    expect(find.text('Code STEMI activated'), findsOneWidget);
  });

  testWidgets('Code STEMI action validates patient and ED visit context', (
    tester,
  ) async {
    var createCalls = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: EdTraumaWorkbenchScreen(
          loadPolicy: () async => {
            'active': true,
            'canonical_triage_scale': 'esi',
          },
          createStemiActivation: (body) async {
            createCalls += 1;
            return const {};
          },
        ),
      ),
    );
    await tester.pump();
    await tester.pump();

    final activate = find.byKey(const ValueKey('code-stemi-activate'));
    await tester.scrollUntilVisible(activate, 250, scrollable: workbenchScroll);
    await tester.ensureVisible(activate);
    await tester.pumpAndSettle();
    await tester.tap(activate);
    await tester.pump();
    await tester.drag(workbenchList, const Offset(0, 800));
    await tester.pump();

    expect(createCalls, 0);
    expect(find.text('Patient UID is required'), findsOneWidget);
  });

  testWidgets('Code STEMI API failures render localized safe copy', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: EdTraumaWorkbenchScreen(
          loadPolicy: () async => {
            'active': true,
            'canonical_triage_scale': 'esi',
          },
          createStemiActivation: (_) async {
            throw const StemiPathwayApiException();
          },
        ),
      ),
    );
    await tester.pump();
    await tester.pump();

    await tester.enterText(
      find.byKey(const ValueKey('stemi-ed-visit-id')),
      '314',
    );
    await tester.enterText(
      find.byKey(const ValueKey('stemi-patient-uid')),
      '11111111-1111-4111-8111-111111111111',
    );
    final activate = find.byKey(const ValueKey('code-stemi-activate'));
    await tester.scrollUntilVisible(activate, 250, scrollable: workbenchScroll);
    await tester.ensureVisible(activate);
    await tester.pumpAndSettle();
    await tester.tap(activate);
    await tester.pumpAndSettle();
    await tester.drag(workbenchList, const Offset(0, 800));
    await tester.pump();

    expect(find.text('Code STEMI could not be activated'), findsOneWidget);
    expect(find.textContaining('StemiPathwayApiException'), findsNothing);
  });
}
