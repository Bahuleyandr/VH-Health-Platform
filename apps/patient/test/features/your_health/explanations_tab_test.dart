import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/widgets/biometric_gate.dart';
import 'package:go_router/go_router.dart';
import 'package:vhhealth/features/your_health/models/patient_explainer.dart';
import 'package:vhhealth/features/your_health/screens/your_health_screen.dart';
import 'package:vhhealth/features/your_health/services/patient_explainers_repository.dart';
import 'package:vhhealth/features/your_health/widgets/explanations_tab.dart';
import 'package:vhhealth/generated/app_localizations.dart';

void main() {
  // The detail screens are wrapped in BiometricGate (FL-H1). These tests
  // exercise the screens' content, not the gate (covered by
  // biometric_gate_test.dart), so grant access without the plugin channel.
  setUp(() {
    BiometricGate.debugDefaultAuthCheckOverride = (_) async => true;
  });
  tearDown(() {
    BiometricGate.debugDefaultAuthCheckOverride = null;
    BiometricGate.debugResetUnlockState();
  });

  testWidgets('Your Health tabs hide explanations when preview list is empty', (
    tester,
  ) async {
    await tester.pumpWidget(
      _LocalizedHarness(
        child: Builder(
          builder: (context) {
            final l10n = AppLocalizations.of(context)!;
            final tabs = buildYourHealthTabs(l10n, includeExplanations: false);
            return DefaultTabController(
              length: tabs.length,
              child: Scaffold(
                appBar: AppBar(bottom: TabBar(isScrollable: true, tabs: tabs)),
              ),
            );
          },
        ),
      ),
    );

    await tester.pumpAndSettle();

    expect(find.text('Explanations'), findsNothing);
    expect(find.text('Prescriptions'), findsOneWidget);
  });

  testWidgets('Explanations tab opens reviewed detail with safety guidance', (
    tester,
  ) async {
    final explainer = _sampleExplainer();
    final repository = _FakeExplainersRepository([explainer]);
    final router = GoRouter(
      initialLocation: '/health',
      routes: [
        GoRoute(
          path: '/health',
          builder: (_, _) => Scaffold(
            body: ExplanationsTab(
              explainers: [explainer],
              repository: repository,
              onRefresh: () async {},
            ),
          ),
        ),
        GoRoute(
          path: '/health/explanations/:id',
          builder: (_, state) {
            final args = state.extra is PatientExplainerDetailRouteArgs
                ? state.extra! as PatientExplainerDetailRouteArgs
                : null;
            return PatientExplainerDetailScreen(
              reviewId: int.parse(state.pathParameters['id']!),
              initialExplainer: args?.initialExplainer,
              repository: args?.repository ?? repository,
            );
          },
        ),
      ],
    );
    addTearDown(router.dispose);

    await tester.pumpWidget(_RouterHarness(router: router));

    await tester.pumpAndSettle();

    expect(find.text('Lab Result Patient Explanation'), findsOneWidget);
    expect(find.textContaining('Your blood test is stable'), findsOneWidget);

    await tester.tap(find.text('Lab Result Patient Explanation'));
    await tester.pumpAndSettle();

    expect(find.text('Explanation'), findsOneWidget);
    expect(find.text('Summary'), findsOneWidget);
    expect(find.text('Key points'), findsOneWidget);
    expect(find.text('Next steps'), findsOneWidget);
    expect(find.text('When to seek help'), findsOneWidget);
    expect(find.text('Review flag'), findsOneWidget);
    expect(find.text('Call the hospital if fever returns.'), findsOneWidget);
    expect(repository.detailRequests, 1);
  });
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
      home: child,
    );
  }
}

class _FakeExplainersRepository implements PatientExplainersRepository {
  _FakeExplainersRepository(this.explainers);

  final List<PatientExplainer> explainers;
  int detailRequests = 0;

  @override
  Future<List<PatientExplainer>> listExplainers() async => explainers;

  @override
  Future<PatientExplainer> getExplainer(int reviewId) async {
    detailRequests += 1;
    return explainers.firstWhere((explainer) => explainer.reviewId == reviewId);
  }
}

PatientExplainer _sampleExplainer() {
  return PatientExplainer(
    reviewId: 42,
    generationId: 7,
    moduleKey: 'lab_result_patient_explanation',
    moduleName: 'Lab Result Patient Explanation',
    publishedAt: DateTime.utc(2026, 7, 2, 10),
    modelTier: 'tier_e',
    sourceCitations: const [],
    draft: const PatientExplainerDraft(
      explanationSummary:
          'Your blood test is stable and no urgent action is needed.',
      keyPoints: ['Hemoglobin is in the expected range.'],
      nextSteps: ['Continue the current treatment plan.'],
      whenToSeekHelp: ['Call the hospital if fever returns.'],
      safetyFlags: [
        PatientExplainerSafetyFlag(
          severity: 'low',
          code: 'REVIEWED',
          message: 'Care team review completed.',
        ),
      ],
    ),
  );
}
