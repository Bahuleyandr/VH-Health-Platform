import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/emergency/widgets/ed_continuity_panel.dart';

void main() {
  Map<String, dynamic> continuity({
    String status = 'awaiting_disposition',
    bool branchComplete = false,
  }) {
    return {
      'mode': 'active',
      'continuity': {
        'emergency_visit_id': 73,
        'visit_status': status,
        'disposition': null,
        'branch_closure_complete': branchComplete,
        'accepted_handoff_valid': false,
        'identity_resolved_or_attested': true,
        'recovery_complete': false,
        'bed_pending': false,
      },
      'closure_history': <Map<String, dynamic>>[],
      'recovery_contacts': <Map<String, dynamic>>[],
    };
  }

  Widget app(Widget child) => MaterialApp(
    home: Scaffold(body: SingleChildScrollView(child: child)),
  );

  Future<void> loadVisit(WidgetTester tester) async {
    await tester.enterText(
      find.byKey(const ValueKey('ed-continuity-visit-id')),
      '73',
    );
    await tester.tap(find.byKey(const ValueKey('ed-continuity-load')));
    await tester.pumpAndSettle();
  }

  Future<void> enterByLabel(
    WidgetTester tester,
    String label,
    String value,
  ) async {
    final field = find.widgetWithText(TextField, label);
    await tester.ensureVisible(field);
    await tester.enterText(field, value);
  }

  testWidgets('records patient-safe discharge closure evidence', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1200, 2200);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    Map<String, dynamic>? recorded;
    await tester.pumpWidget(
      app(
        EdContinuityPanel(
          loadContinuity: (_) async => continuity(),
          recordClosure: ({required emergencyVisitId, required body}) async {
            expect(emergencyVisitId, 73);
            recorded = body;
            return {'closure_evidence': body};
          },
        ),
      ),
    );

    await loadVisit(tester);
    expect(find.textContaining('Awaiting Disposition'), findsOneWidget);
    expect(find.text('Branch closure complete'), findsOneWidget);

    await enterByLabel(tester, 'Exact follow-up plan ID', '91');
    await enterByLabel(tester, 'Step label', 'Review pending result');
    await enterByLabel(
      tester,
      "Doctor's reason medication reconciliation is not applicable",
      'No medicines were prescribed',
    );

    final save = find.byKey(const ValueKey('ed-continuity-record-closure'));
    await tester.ensureVisible(save);
    await tester.tap(save);
    await tester.pumpAndSettle();

    expect(recorded, isNotNull);
    expect(recorded, containsPair('closure_kind', 'discharge'));
    expect(recorded, containsPair('follow_up_plan_id', 91));
    expect(
      recorded?['medication_not_applicable_reason'],
      'No medicines were prescribed',
    );
    expect(recorded?['patient_safe_next_steps'], [
      {'label': 'Review pending result', 'status': 'planned'},
    ]);
    expect(find.text('ED closure evidence recorded'), findsOneWidget);
  });

  testWidgets('records a LAMA contact attempt without exposing staff notes', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1200, 2200);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    Map<String, dynamic>? closureBody;
    Map<String, dynamic>? recoveryBody;
    await tester.pumpWidget(
      app(
        EdContinuityPanel(
          loadContinuity: (_) async =>
              continuity(status: 'left_against_advice'),
          recordClosure: ({required emergencyVisitId, required body}) async {
            closureBody = body;
            return {'closure_evidence': body};
          },
          recordRecovery: ({required emergencyVisitId, required body}) async {
            recoveryBody = body;
            return {'recovery_contact': body};
          },
        ),
      ),
    );

    await loadVisit(tester);
    final closureKind = find.byKey(
      const ValueKey('ed-continuity-closure-kind'),
    );
    await tester.ensureVisible(closureKind);
    await tester.tap(closureKind);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Left Against Medical Advice').last);
    await tester.pumpAndSettle();

    await enterByLabel(tester, 'Exact follow-up plan ID', '92');
    await enterByLabel(tester, 'Step label', 'Return for urgent review');
    await enterByLabel(
      tester,
      "Doctor's reason medication reconciliation is not applicable",
      'No medicines were prescribed',
    );
    await enterByLabel(tester, 'Clinical risk code', 'high_risk');
    await enterByLabel(
      tester,
      'Clinical risk summary',
      'Patient left before recommended monitoring was complete',
    );
    final saveClosure = find.byKey(
      const ValueKey('ed-continuity-record-closure'),
    );
    await tester.ensureVisible(saveClosure);
    await tester.tap(saveClosure);
    await tester.pumpAndSettle();

    expect(
      closureBody,
      containsPair('closure_kind', 'left_against_medical_advice'),
    );
    expect(closureBody, containsPair('risk_classification_code', 'high_risk'));

    await enterByLabel(
      tester,
      'Patient-safe summary',
      'We called and explained when to return',
    );
    await enterByLabel(
      tester,
      'Private staff notes',
      'Internal risk discussion',
    );
    final saveRecovery = find.byKey(
      const ValueKey('ed-continuity-record-recovery'),
    );
    await tester.ensureVisible(saveRecovery);
    await tester.tap(saveRecovery);
    await tester.pumpAndSettle();

    expect(recoveryBody, containsPair('event_kind', 'attempt'));
    expect(recoveryBody, containsPair('contact_channel', 'phone'));
    expect(
      recoveryBody,
      containsPair(
        'patient_safe_summary',
        'We called and explained when to return',
      ),
    );
    expect(
      recoveryBody,
      containsPair('staff_notes', 'Internal risk discussion'),
    );
    expect(find.text('ED recovery evidence recorded'), findsOneWidget);
  });
}
