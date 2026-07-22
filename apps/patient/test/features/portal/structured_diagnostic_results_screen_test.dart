import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:vhhealth/features/portal/models/structured_diagnostic_result.dart';
import 'package:vhhealth/features/portal/screens/structured_diagnostic_results_screen.dart';
import 'package:vhhealth/features/portal/services/structured_diagnostic_results_repository.dart';
import 'package:vhhealth/generated/app_localizations.dart';

void main() {
  testWidgets('shows a released signed report and its signed addendum', (
    tester,
  ) async {
    final result = _sampleResult();
    final repository = _FakeRepository([result]);
    final router = _router(repository);
    addTearDown(router.dispose);

    await tester.pumpWidget(_Harness(router));
    await tester.pumpAndSettle();

    expect(find.text('CT chest'), findsOneWidget);
    expect(find.textContaining('Imaging report'), findsOneWidget);

    await tester.tap(find.text('CT chest'));
    await tester.pumpAndSettle();

    expect(repository.detailRequests, 1);
    expect(find.text('No acute chest abnormality.'), findsOneWidget);
    expect(find.text('Signed addendum'), findsOneWidget);
    expect(find.text('Correction: small benign scar noted.'), findsOneWidget);
    expect(
      find.textContaining('discuss this report with your doctor'),
      findsOneWidget,
    );
  });

  testWidgets('shows a patient-safe empty state', (tester) async {
    final repository = _FakeRepository(const []);
    final router = _router(repository);
    addTearDown(router.dispose);

    await tester.pumpWidget(_Harness(router));
    await tester.pumpAndSettle();

    expect(find.text('No released reports yet'), findsOneWidget);
    expect(find.textContaining('Clinician-signed reports'), findsOneWidget);
  });
}

GoRouter _router(StructuredDiagnosticResultsRepository repository) {
  return GoRouter(
    initialLocation: '/portal/diagnostic-results',
    routes: [
      GoRoute(
        path: '/portal/diagnostic-results',
        builder: (_, _) =>
            StructuredDiagnosticResultsScreen(repository: repository),
      ),
      GoRoute(
        path: '/portal/diagnostic-results/:id',
        builder: (_, state) {
          final args = state.extra is StructuredDiagnosticResultDetailRouteArgs
              ? state.extra! as StructuredDiagnosticResultDetailRouteArgs
              : null;
          return StructuredDiagnosticResultDetailScreen(
            resultId: state.pathParameters['id']!,
            initialResult: args?.initialResult,
            repository: args?.repository ?? repository,
          );
        },
      ),
    ],
  );
}

class _Harness extends StatelessWidget {
  const _Harness(this.router);

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

class _FakeRepository implements StructuredDiagnosticResultsRepository {
  _FakeRepository(this.results);

  final List<StructuredDiagnosticResult> results;
  int detailRequests = 0;

  @override
  Future<StructuredDiagnosticResultsPage> listResults() async {
    return StructuredDiagnosticResultsPage(results: results);
  }

  @override
  Future<StructuredDiagnosticResult> getResult(String id) async {
    detailRequests += 1;
    return results.singleWhere((result) => result.id == id);
  }
}

StructuredDiagnosticResult _sampleResult() {
  return StructuredDiagnosticResult(
    id: '33333333-3333-4333-8333-333333333333',
    resultType: 'radiology',
    title: 'CT chest',
    sourceVersion: 2,
    signedAt: DateTime.utc(2026, 7, 22, 8),
    releasedToPatientAt: DateTime.utc(2026, 7, 22, 9),
    amended: true,
    reportText: 'No acute chest abnormality.',
    addenda: [
      StructuredDiagnosticAddendum(
        version: 2,
        text: 'Correction: small benign scar noted.',
        signedAt: DateTime.utc(2026, 7, 22, 8, 30),
      ),
    ],
  );
}
