import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:vhhealth/features/portal/models/lab_result.dart';
import 'package:vhhealth/features/portal/screens/lab_results_screen.dart';
import 'package:vhhealth/features/portal/services/lab_results_repository.dart';
import 'package:vhhealth/generated/app_localizations.dart';

void main() {
  testWidgets('shows lab result detail with a trend chart', (tester) async {
    final result = _sampleResult();
    final repository = _FakeLabResultsRepository(
      results: [result],
      detailResult: result,
      trend: _sampleTrend(),
    );
    final router = _labResultsRouter(repository);
    addTearDown(router.dispose);

    await tester.pumpWidget(_RouterHarness(router: router));

    await tester.pumpAndSettle();

    expect(find.text('Hemoglobin'), findsOneWidget);
    expect(find.text('13.1'), findsOneWidget);
    expect(find.text('g/dL'), findsOneWidget);

    await tester.tap(find.text('Hemoglobin'));
    await tester.pumpAndSettle();

    expect(repository.detailRequests, 1);
    expect(repository.trendRequests, 1);
    expect(repository.lastTrendMonths, 24);
    expect(find.text('Trend'), findsOneWidget);
    expect(find.text('Last 24 months'), findsOneWidget);
    expect(find.text('Latest'), findsOneWidget);
    expect(find.text('13.1 g/dL'), findsWidgets);
    expect(find.text('Range'), findsOneWidget);
    expect(find.text('11.9 - 13.1 g/dL'), findsOneWidget);
    expect(find.text('3 results'), findsOneWidget);
  });

  testWidgets('shows a friendly empty state for short trend series', (
    tester,
  ) async {
    final result = _sampleResult();
    final repository = _FakeLabResultsRepository(
      results: [result],
      detailResult: result,
      trend: _sampleTrend(points: const [12.4]),
    );
    final router = _labResultsRouter(repository);
    addTearDown(router.dispose);

    await tester.pumpWidget(_RouterHarness(router: router));

    await tester.pumpAndSettle();
    await tester.tap(find.text('Hemoglobin'));
    await tester.pumpAndSettle();

    expect(repository.trendRequests, 1);
    expect(find.text('Trend'), findsOneWidget);
    expect(find.text('Not enough trend data yet'), findsOneWidget);
    expect(
      find.textContaining('At least two released numeric results'),
      findsOneWidget,
    );
  });

  testWidgets('shows localized empty state when no lab results are returned', (
    tester,
  ) async {
    await tester.pumpWidget(
      _LocalizedHarness(
        child: LabResultsList(
          repository: _FakeLabResultsRepository(
            results: const [],
            detailResult: _sampleResult(),
            trend: _sampleTrend(),
          ),
        ),
      ),
    );

    await tester.pumpAndSettle();

    expect(find.text('No lab results yet'), findsOneWidget);
    expect(
      find.textContaining('Released lab results will appear here'),
      findsOneWidget,
    );
  });
}

GoRouter _labResultsRouter(_FakeLabResultsRepository repository) {
  return GoRouter(
    initialLocation: '/portal/lab-results',
    routes: [
      GoRoute(
        path: '/portal/lab-results',
        builder: (_, _) =>
            Scaffold(body: LabResultsList(repository: repository)),
      ),
      GoRoute(
        path: '/portal/lab-results/:id',
        builder: (_, state) {
          final args = state.extra is LabResultDetailRouteArgs
              ? state.extra! as LabResultDetailRouteArgs
              : null;
          return LabResultDetailScreen(
            resultId: int.parse(state.pathParameters['id']!),
            initialResult: args?.initialResult,
            repository: args?.repository ?? repository,
          );
        },
      ),
    ],
  );
}

class _RouterHarness extends StatelessWidget {
  const _RouterHarness({required this.router});

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

class _FakeLabResultsRepository implements LabResultsRepository {
  _FakeLabResultsRepository({
    required this.results,
    required this.detailResult,
    required this.trend,
  });

  final List<LabResult> results;
  final LabResult detailResult;
  final LabResultTrend trend;
  int detailRequests = 0;
  int trendRequests = 0;
  int? lastTrendMonths;

  @override
  Future<LabResultsPage> listResults() async =>
      LabResultsPage(results: results);

  @override
  Future<LabResult> getResult(int id) async {
    detailRequests += 1;
    return detailResult;
  }

  @override
  Future<LabResultTrend> getTrend(LabResult result, {int months = 24}) async {
    trendRequests += 1;
    lastTrendMonths = months;
    return trend;
  }
}

LabResult _sampleResult() {
  return LabResult(
    id: 9,
    testName: 'Hemoglobin',
    testCode: 'HB',
    loincCode: '718-7',
    observationTime: DateTime.utc(2026, 7, 1, 8, 30),
    valueNumeric: 13.1,
    unit: 'g/dL',
    referenceRange: '12-16',
    abnormalFlag: null,
    signedOffAt: DateTime.utc(2026, 7, 1, 9),
    releasedToPatientAt: DateTime.utc(2026, 7, 2, 9),
  );
}

LabResultTrend _sampleTrend({List<double> points = const [11.9, 12.4, 13.1]}) {
  return LabResultTrend(
    testCode: 'HB',
    loincCode: '718-7',
    testName: 'Hemoglobin',
    unit: 'g/dL',
    months: 24,
    count: points.length,
    min: points.reduce((a, b) => a < b ? a : b),
    max: points.reduce((a, b) => a > b ? a : b),
    points: [
      for (var i = 0; i < points.length; i++)
        LabTrendPoint(
          id: i + 1,
          at: DateTime.utc(2026, 5 + i, 1, 8, 30),
          value: points[i],
        ),
    ],
  );
}
