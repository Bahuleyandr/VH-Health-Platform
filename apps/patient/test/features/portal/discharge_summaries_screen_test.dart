import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/features/portal/models/discharge_summary.dart';
import 'package:vhhealth/features/portal/screens/discharge_summaries_screen.dart';
import 'package:vhhealth/features/portal/services/discharge_summaries_repository.dart';
import 'package:vhhealth/generated/app_localizations.dart';

void main() {
  testWidgets('shows discharge summary rows and read-only detail sections', (
    tester,
  ) async {
    final summary = _sampleSummary();
    final repository = _FakeDischargeSummariesRepository([summary]);
    var pdfOpens = 0;

    await tester.pumpWidget(
      _LocalizedHarness(
        child: DischargeSummariesList(
          repository: repository,
          pdfOpener: (_) async {
            pdfOpens += 1;
          },
        ),
      ),
    );

    await tester.pumpAndSettle();

    expect(find.text('Acute gastroenteritis'), findsOneWidget);
    expect(find.textContaining('Discharged:'), findsOneWidget);
    expect(find.textContaining('Ward:'), findsOneWidget);

    await tester.tap(find.text('Acute gastroenteritis'));
    await tester.pumpAndSettle();

    expect(repository.detailRequests, 1);
    expect(find.text('Summary sections'), findsOneWidget);
    expect(find.text('Diagnosis'), findsWidgets);
    expect(find.text('Acute gastroenteritis, improved'), findsOneWidget);
    expect(find.text('Medicines on discharge'), findsOneWidget);
    expect(find.text('ORS for 3 days'), findsOneWidget);

    await tester.tap(find.text('Open PDF'));
    await tester.pumpAndSettle();

    expect(pdfOpens, 1);
  });

  testWidgets('shows localized empty state when no summaries are returned', (
    tester,
  ) async {
    await tester.pumpWidget(
      _LocalizedHarness(
        child: DischargeSummariesList(
          repository: _FakeDischargeSummariesRepository(const []),
        ),
      ),
    );

    await tester.pumpAndSettle();

    expect(find.text('No discharge summaries yet'), findsOneWidget);
    expect(
      find.textContaining(
        'Signed discharge summaries from hospital admissions',
      ),
      findsOneWidget,
    );
  });
}

class _LocalizedHarness extends StatelessWidget {
  const _LocalizedHarness({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: Scaffold(body: child),
    );
  }
}

class _FakeDischargeSummariesRepository
    implements DischargeSummariesRepository {
  _FakeDischargeSummariesRepository(this.summaries);

  final List<DischargeSummary> summaries;
  int detailRequests = 0;

  @override
  Future<DischargeSummariesPage> listSummaries() async =>
      DischargeSummariesPage(summaries: summaries);

  @override
  Future<DischargeSummary> getSummary(int id) async {
    detailRequests += 1;
    return summaries.firstWhere((summary) => summary.id == id);
  }
}

DischargeSummary _sampleSummary() {
  return DischargeSummary(
    id: 42,
    admissionId: 7,
    primaryDiagnosis: 'Acute gastroenteritis',
    status: 'signed',
    patientName: 'Test Patient',
    hospitalNumber: 'VH-123',
    admittedAt: DateTime.utc(2026, 6, 28, 5, 30),
    dischargedAt: DateTime.utc(2026, 7, 1, 7, 45),
    wardAtDischarge: 'Ward 3A',
    signedByName: 'Dr Rao',
    signedAt: DateTime.utc(2026, 7, 1, 8, 30),
    sections: const [
      DischargeSummarySection(
        key: 'diagnosis',
        title: 'Diagnosis',
        body: 'Acute gastroenteritis, improved',
        translations: {},
        displayOrder: 1,
      ),
      DischargeSummarySection(
        key: 'medications',
        title: 'Medicines on discharge',
        body: 'ORS for 3 days',
        translations: {},
        displayOrder: 2,
      ),
    ],
  );
}
