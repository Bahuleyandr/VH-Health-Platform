import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/services/stemi_pathway_api_service.dart';
import 'package:vhhealth_staff/features/emergency/screens/ed_trauma_workbench_screen.dart';

void main() {
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
    await tester.ensureVisible(activate);
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
    await tester.ensureVisible(activate);
    await tester.tap(activate);
    await tester.pump();
    await tester.drag(find.byType(ListView), const Offset(0, 800));
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
    await tester.ensureVisible(activate);
    await tester.tap(activate);
    await tester.pumpAndSettle();
    await tester.drag(find.byType(ListView), const Offset(0, 800));
    await tester.pump();

    expect(find.text('Code STEMI could not be activated'), findsOneWidget);
    expect(find.textContaining('StemiPathwayApiException'), findsNothing);
  });
}
