import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/cath_lab/screens/cath_lab_screen.dart';
import 'package:vhhealth_staff/features/cath_lab/models/cath_report_models.dart';
import 'package:vhhealth_staff/features/cath_lab/services/cath_lab_api_service.dart';
import 'package:vhhealth_staff/features/cath_lab/widgets/cath_case_reports_panel.dart';

void main() {
  test('CathLabCaseSummary parses backend counters defensively', () {
    final parsed = CathLabCaseSummary.fromJson({
      'id': '42',
      'patient_uid': '11111111-1111-4111-8111-111111111111',
      'patient_name': 'Asha Rao',
      'requested_procedure': 'Primary PCI',
      'status': 'ready',
      'urgency': 'emergency',
      'lab_room': 'CL-1',
      'planned_start_at': '2026-07-09T08:30:00.000Z',
      'readiness_total': '8',
      'readiness_cleared': 8,
      'procedure_count': '1',
      'dose_record_count': 1,
      'active_post_order_count': '2',
      'device_link_count': 1,
      'signed_report_count': '1',
      'report_tat_minutes': '24',
    });

    expect(parsed.id, 42);
    expect(parsed.patientName, 'Asha Rao');
    expect(parsed.readinessComplete, isTrue);
    expect(parsed.procedureCount, 1);
    expect(parsed.activePostOrderCount, 2);
    expect(parsed.signedReportCount, 1);
    expect(parsed.reportTatMinutes, 24);
  });

  testWidgets('cath-lab screen renders the case worklist and stage tabs', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: CathLabScreen(
          loadCases: (_) async => [
            const CathLabCaseSummary(
              id: 42,
              patientUid: '11111111-1111-4111-8111-111111111111',
              patientName: 'Asha Rao',
              requestedProcedure: 'Primary PCI',
              status: 'ready',
              urgency: 'emergency',
              labRoom: 'CL-1',
              plannedStartAt: null,
              readinessTotal: 8,
              readinessCleared: 8,
              procedureCount: 1,
              doseRecordCount: 1,
              activePostOrderCount: 2,
              deviceLinkCount: 1,
            ),
          ],
        ),
      ),
    );
    await tester.pump();

    expect(find.text('Cath Lab'), findsOneWidget);
    expect(find.text('Primary PCI'), findsOneWidget);
    expect(find.text('Asha Rao'), findsOneWidget);
    expect(find.text('Emergency'), findsOneWidget);

    await tester.tap(find.text('Readiness'));
    await tester.pumpAndSettle();
    expect(find.text('Ready for procedure'), findsOneWidget);
    expect(find.text('8/8 checks clear'), findsOneWidget);

    await tester.tap(find.text('Procedure'));
    await tester.pumpAndSettle();
    expect(find.text('1 logs'), findsOneWidget);
    expect(find.text('1 device links'), findsOneWidget);

    await tester.tap(find.text('Post-orders'));
    await tester.pumpAndSettle();
    expect(find.text('2 active orders'), findsOneWidget);
  });

  testWidgets('cath-lab screen shows an empty state for a selected day', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(home: CathLabScreen(loadCases: (_) async => const [])),
    );
    await tester.pump();

    expect(find.text('No Cath Lab cases'), findsOneWidget);
  });

  testWidgets('reports tab expands a case-level report list', (tester) async {
    const cathCase = CathLabCaseSummary(
      id: 42,
      patientUid: '11111111-1111-4111-8111-111111111111',
      patientName: 'Asha Rao',
      requestedProcedure: 'Primary PCI',
      status: 'completed',
      urgency: 'emergency',
      labRoom: 'CL-1',
      plannedStartAt: null,
      readinessTotal: 8,
      readinessCleared: 8,
      procedureCount: 1,
      doseRecordCount: 1,
      activePostOrderCount: 0,
      deviceLinkCount: 1,
    );
    await tester.pumpWidget(
      MaterialApp(
        home: CathLabScreen(
          loadCases: (_) async => const [cathCase],
          loadRole: () async => 'DOCTOR',
          reportDependencies: CathReportDependencies(
            loadReports: (_) async => const [
              CathProcedureReport(
                id: 91,
                caseId: 42,
                patientUid: '11111111-1111-4111-8111-111111111111',
                reportType: 'ptca',
                status: 'preliminary',
                narrativeSections: {'findings': 'Successful PCI to LAD'},
                codedFields: {'stent_count': 1},
              ),
            ],
            loadViewerLink: (_) async =>
                const CathViewerLink(status: 'pacs_not_configured'),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.ensureVisible(find.text('Reports'));
    await tester.tap(find.text('Reports'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('cath-report-expand-42')));
    await tester.pumpAndSettle();

    expect(find.text('Preliminary'), findsOneWidget);
    expect(find.text('Successful PCI to LAD'), findsOneWidget);
  });
}
