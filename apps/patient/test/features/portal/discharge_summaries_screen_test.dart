import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
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
    final router = _dischargeSummariesRouter(
      repository: repository,
      pdfOpener: (_) async {
        pdfOpens += 1;
      },
    );
    addTearDown(router.dispose);

    await tester.pumpWidget(_LocalizedHarness(router: router));

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
    final router = _dischargeSummariesRouter(
      repository: _FakeDischargeSummariesRepository(const []),
    );
    addTearDown(router.dispose);

    await tester.pumpWidget(_LocalizedHarness(router: router));

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
  const _LocalizedHarness({required this.router});

  final GoRouter router;

  @override
  Widget build(BuildContext context) {
    return MaterialApp.router(
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      routerConfig: router,
    );
  }
}

GoRouter _dischargeSummariesRouter({
  required DischargeSummariesRepository repository,
  DischargeSummaryPdfOpener? pdfOpener,
}) {
  final openPdf = pdfOpener ?? (_) async {};
  return GoRouter(
    initialLocation: '/portal/discharge-summaries',
    routes: [
      GoRoute(
        path: '/portal/discharge-summaries',
        builder: (_, _) => Scaffold(
          body: DischargeSummariesList(
            repository: repository,
            pdfOpener: openPdf,
          ),
        ),
      ),
      GoRoute(
        path: '/portal/discharge-summaries/:id',
        builder: (_, state) {
          final extra = state.extra;
          final args = extra is DischargeSummaryDetailRouteArgs ? extra : null;
          return DischargeSummaryDetailRouteScreen(
            summaryId: int.parse(state.pathParameters['id']!),
            initialSummary: args?.initialSummary,
            repository: args?.repository ?? repository,
            pdfOpener: args?.pdfOpener ?? openPdf,
          );
        },
      ),
    ],
  );
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
