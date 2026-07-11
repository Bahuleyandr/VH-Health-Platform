import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/cath_lab/models/cath_report_models.dart';
import 'package:vhhealth_staff/features/cath_lab/services/cath_lab_api_service.dart';
import 'package:vhhealth_staff/features/cath_lab/widgets/cath_case_reports_panel.dart';

const _cathCase = CathLabCaseSummary(
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

CathProcedureReport _report(String status) => CathProcedureReport(
  id: 91,
  caseId: 42,
  patientUid: _cathCase.patientUid,
  reportType: 'ptca',
  status: status,
  narrativeSections: const {'findings': 'Successful PCI to LAD'},
  codedFields: const {'stent_count': 1},
);

CathReportDependencies _dependencies({
  required CathProcedureReport report,
  CathReportAddendumCreator? addAddendum,
  CathViewerLink viewer = const CathViewerLink(status: 'pacs_not_configured'),
}) {
  return CathReportDependencies(
    loadReports: (_) async => [report],
    loadViewerLink: (_) async => viewer,
    addAddendum: addAddendum,
  );
}

Widget _wrap(Widget child) {
  return MaterialApp(
    home: Scaffold(body: SingleChildScrollView(child: child)),
  );
}

void main() {
  test('cath report role predicates match the owner access matrix', () {
    expect(cathReportCanEditForRole('RECEPTIONIST'), isTrue);
    expect(cathReportCanEditForRole('CATH_LAB_INCHARGE'), isTrue);
    expect(cathReportCanEditForRole('CATH_LAB_IN_CHARGE'), isTrue);
    expect(cathReportCanEditForRole('TECHNICIAN'), isFalse);
    expect(cathReportCanSignForRole('CONSULTANT'), isTrue);
    expect(cathReportCanSignForRole('CONSULTANT_PHYSICIAN'), isTrue);
    expect(cathReportCanSignForRole('RECEPTIONIST'), isFalse);
    expect(cathImagesCanOpenForRole('TECHNICIAN'), isTrue);
    expect(cathImagesCanOpenForRole('CATH_LAB_TECHNICIAN'), isTrue);
    expect(cathImagesCanOpenForRole('NURSING_STAFF'), isTrue);
    expect(cathImagesCanOpenForRole('RECEPTIONIST'), isFalse);
  });

  testWidgets('sign action is visible only to doctor-family roles', (
    tester,
  ) async {
    final preliminary = _report('preliminary');
    await tester.pumpWidget(
      _wrap(
        CathCaseReportsPanel(
          key: const ValueKey('doctor-panel'),
          cathCase: _cathCase,
          role: 'DOCTOR',
          initiallyExpanded: true,
          dependencies: _dependencies(report: preliminary),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('cath-report-sign-91')), findsOneWidget);

    await tester.pumpWidget(
      _wrap(
        CathCaseReportsPanel(
          key: const ValueKey('reception-panel'),
          cathCase: _cathCase,
          role: 'RECEPTIONIST',
          initiallyExpanded: true,
          dependencies: _dependencies(report: preliminary),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('cath-report-sign-91')), findsNothing);
  });

  testWidgets('signed report addendum flow submits reason and narrative', (
    tester,
  ) async {
    CathReportAddendumDraft? submitted;
    await tester.pumpWidget(
      _wrap(
        CathCaseReportsPanel(
          cathCase: _cathCase,
          role: 'DOCTOR',
          initiallyExpanded: true,
          dependencies: _dependencies(
            report: _report('signed'),
            addAddendum: (reportId, draft) async {
              expect(reportId, 91);
              submitted = draft;
              return const CathReportAddendum(
                id: 7,
                reason: 'Clarification',
                narrative: 'Corrected target vessel.',
              );
            },
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('cath-report-addendum-91')));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const ValueKey('cath-report-addendum-reason')),
      'Clarification',
    );
    await tester.enterText(
      find.byKey(const ValueKey('cath-report-addendum-narrative')),
      'Corrected target vessel.',
    );
    await tester.tap(find.byKey(const ValueKey('cath-report-addendum-submit')));
    await tester.pumpAndSettle();

    expect(submitted, isNotNull);
    expect(submitted!.reason, 'Clarification');
    expect(submitted!.narrative, 'Corrected target vessel.');
  });

  testWidgets('Open images is hidden when PACS is not configured', (
    tester,
  ) async {
    await tester.pumpWidget(
      _wrap(
        CathCaseReportsPanel(
          cathCase: _cathCase,
          role: 'DOCTOR',
          initiallyExpanded: true,
          dependencies: _dependencies(report: _report('signed')),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Open images'), findsNothing);
    expect(find.byKey(const ValueKey('cath-report-images-42')), findsNothing);
  });

  testWidgets(
    'cached viewer link is cleared when the role loses image access',
    (tester) async {
      var role = 'DOCTOR';
      late StateSetter setHostState;
      await tester.pumpWidget(
        _wrap(
          StatefulBuilder(
            builder: (context, setState) {
              setHostState = setState;
              return CathCaseReportsPanel(
                cathCase: _cathCase,
                role: role,
                initiallyExpanded: true,
                dependencies: _dependencies(
                  report: _report('signed'),
                  viewer: CathViewerLink(
                    status: 'available',
                    url: Uri.parse('https://viewer.example.test/study'),
                  ),
                ),
              );
            },
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('cath-report-images-42')),
        findsOneWidget,
      );

      setHostState(() => role = 'RECEPTIONIST');
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('cath-report-images-42')), findsNothing);
    },
  );
}
