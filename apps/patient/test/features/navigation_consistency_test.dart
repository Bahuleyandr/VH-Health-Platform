import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth/features/investigations/widgets/investigation_bookings_tab.dart';
import 'package:vhhealth/features/portal/models/discharge_summary.dart';
import 'package:vhhealth/features/portal/models/lab_result.dart';
import 'package:vhhealth/features/portal/screens/bill_detail_screen.dart';
import 'package:vhhealth/features/portal/screens/discharge_summaries_screen.dart';
import 'package:vhhealth/features/portal/screens/lab_results_screen.dart';
import 'package:vhhealth/features/portal/screens/tpa_claims_screen.dart';
import 'package:vhhealth/features/portal/services/discharge_summaries_repository.dart';
import 'package:vhhealth/features/portal/services/lab_results_repository.dart';
import 'package:vhhealth/features/your_health/models/consultation_note.dart';
import 'package:vhhealth/features/your_health/models/patient_explainer.dart';
import 'package:vhhealth/features/your_health/services/consultation_notes_repository.dart';
import 'package:vhhealth/features/your_health/services/patient_explainers_repository.dart';
import 'package:vhhealth/features/your_health/widgets/consultation_notes_tab.dart';
import 'package:vhhealth/features/your_health/widgets/explanations_tab.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth_core/services/http_client.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(_installSecureStorageFake);

  tearDown(() {
    VHHttpClient.resetClientForTesting();
  });

  testWidgets('TPA claim cards navigate through the declared detail route', (
    tester,
  ) async {
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        expect(request.url.path, endsWith('/portal/tpa/claims'));
        return http.Response(
          '{"data":[{"id":17,"claim_number":"TPA-17","status":"APPROVED","claim_type":"cashless","claimed_amount":10000,"approved_amount":9000,"paid_amount":8500}]}',
          200,
        );
      }),
    );

    final router = GoRouter(
      initialLocation: '/portal/tpa/claims',
      routes: [
        GoRoute(
          path: '/portal/tpa/claims',
          builder: (_, _) => const TpaClaimsScreen(),
        ),
        GoRoute(
          path: '/portal/tpa/claims/:id',
          builder: (_, state) =>
              Text('claim route ${state.pathParameters['id']}'),
        ),
      ],
    );
    addTearDown(router.dispose);

    await tester.pumpWidget(_RouterHarness(router: router));
    await tester.pumpAndSettle();

    await tester.tap(find.text('TPA-17'));
    await tester.pumpAndSettle();

    expect(find.text('claim route 17'), findsOneWidget);
  });

  testWidgets('bill detail claim CTA uses the declared TPA detail route', (
    tester,
  ) async {
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        expect(request.url.path, endsWith('/portal/bills/42'));
        return http.Response(
          '{"data":{"invoice":{"invoice_number":"INV-42","subtotal":1000,"total_amount":1000,"amount_paid":1000,"amount_due":0},"items":[],"payments":[],"tpa_breakdown":{"summary":{"hospital_billed":1000,"tpa_approved":900,"tpa_paid":850},"claim":{"id":17,"claim_number":"TPA-17","status":"APPROVED"},"line_decisions":[]}}}',
          200,
        );
      }),
    );

    final router = GoRouter(
      initialLocation: '/portal/bills/42',
      routes: [
        GoRoute(
          path: '/portal/bills/:id',
          builder: (_, state) => BillDetailScreen(
            invoiceId: int.parse(state.pathParameters['id']!),
          ),
        ),
        GoRoute(
          path: '/portal/tpa/claims/:id',
          builder: (_, state) =>
              Text('claim route ${state.pathParameters['id']}'),
        ),
      ],
    );
    addTearDown(router.dispose);

    await tester.pumpWidget(_RouterHarness(router: router));
    await tester.pumpAndSettle();

    await tester.scrollUntilVisible(
      find.text('View full insurance claim'),
      120,
    );
    await tester.tap(find.text('View full insurance claim'));
    await tester.pumpAndSettle();

    expect(find.text('claim route 17'), findsOneWidget);
  });

  testWidgets('investigation booking CTA uses the declared booking route', (
    tester,
  ) async {
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        expect(request.url.path, endsWith('/investigations/bookings/my'));
        return http.Response('{"data":[]}', 200);
      }),
    );

    final router = GoRouter(
      initialLocation: '/investigations',
      routes: [
        GoRoute(
          path: '/investigations',
          builder: (_, _) => const Scaffold(body: InvestigationBookingsTab()),
        ),
        GoRoute(
          path: '/book-investigation',
          builder: (_, _) => const Text('book investigation route'),
        ),
      ],
    );
    addTearDown(router.dispose);

    await tester.pumpWidget(_RouterHarness(router: router));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Book Investigation'));
    await tester.pumpAndSettle();

    expect(find.text('book investigation route'), findsOneWidget);
  });

  testWidgets('lab result cards navigate through the declared detail route', (
    tester,
  ) async {
    final repository = _FakeLabResultsRepository(
      result: const LabResult(id: 31, testName: 'Glucose', valueNumeric: 98),
    );

    final router = GoRouter(
      initialLocation: '/portal/lab-results',
      routes: [
        GoRoute(
          path: '/portal/lab-results',
          builder: (_, _) =>
              Scaffold(body: LabResultsList(repository: repository)),
        ),
        GoRoute(
          path: '/portal/lab-results/:id',
          builder: (_, state) =>
              Text('lab result route ${state.pathParameters['id']}'),
        ),
      ],
    );
    addTearDown(router.dispose);

    await tester.pumpWidget(_RouterHarness(router: router));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Glucose'));
    await tester.pumpAndSettle();

    expect(find.text('lab result route 31'), findsOneWidget);
  });

  testWidgets('explanation cards navigate through the declared detail route', (
    tester,
  ) async {
    final explainer = _explainer(44, 'Medication explainer');
    final repository = _FakePatientExplainersRepository(explainer: explainer);

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
          builder: (_, state) =>
              Text('explanation route ${state.pathParameters['id']}'),
        ),
      ],
    );
    addTearDown(router.dispose);

    await tester.pumpWidget(_RouterHarness(router: router));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Medication explainer'));
    await tester.pumpAndSettle();

    expect(find.text('explanation route 44'), findsOneWidget);
  });

  testWidgets(
    'consultation note cards navigate through the declared detail route',
    (tester) async {
      final note = _note(57, 'Follow-up note');
      final repository = _FakeConsultationNotesRepository(note: note);

      final router = GoRouter(
        initialLocation: '/health',
        routes: [
          GoRoute(
            path: '/health',
            builder: (_, _) =>
                Scaffold(body: ConsultationNotesTab(repository: repository)),
          ),
          GoRoute(
            path: '/health/consultation-notes/:id',
            builder: (_, state) =>
                Text('consultation note route ${state.pathParameters['id']}'),
          ),
        ],
      );
      addTearDown(router.dispose);

      await tester.pumpWidget(_RouterHarness(router: router));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Follow-up note'));
      await tester.pumpAndSettle();

      expect(find.text('consultation note route 57'), findsOneWidget);
    },
  );

  testWidgets(
    'discharge summaries preserve route extras on detail navigation',
    (tester) async {
      final repository = _FakeDischargeSummariesRepository(
        listSummary: _summary(22, 'Cached discharge summary'),
        detailSummary: _summary(22, 'Fetched discharge summary'),
      );
      final openedPdfIds = <int>[];

      final router = GoRouter(
        initialLocation: '/portal/discharge-summaries',
        routes: [
          GoRoute(
            path: '/portal/discharge-summaries',
            builder: (_, _) => Scaffold(
              body: DischargeSummariesList(
                repository: repository,
                pdfOpener: (summary) async => openedPdfIds.add(summary.id),
              ),
            ),
          ),
          GoRoute(
            path: '/portal/discharge-summaries/:id',
            builder: (_, state) {
              final extra = state.extra;
              final args = extra is DischargeSummaryDetailRouteArgs
                  ? extra
                  : null;
              return DischargeSummaryDetailRouteScreen(
                summaryId: int.parse(state.pathParameters['id']!),
                initialSummary: args?.initialSummary,
                repository: args?.repository ?? repository,
                pdfOpener:
                    args?.pdfOpener ??
                    (summary) async => openedPdfIds.add(summary.id),
              );
            },
          ),
        ],
      );
      addTearDown(router.dispose);

      await tester.pumpWidget(_RouterHarness(router: router));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Cached discharge summary'));
      await tester.pumpAndSettle();

      expect(repository.requestedIds, [22]);
      expect(find.text('Fetched discharge summary'), findsWidgets);

      await tester.tap(find.text('Open PDF'));
      await tester.pumpAndSettle();
      expect(openedPdfIds, [22]);
    },
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

class _FakeDischargeSummariesRepository
    implements DischargeSummariesRepository {
  _FakeDischargeSummariesRepository({
    required this.listSummary,
    required this.detailSummary,
  });

  final DischargeSummary listSummary;
  final DischargeSummary detailSummary;
  final requestedIds = <int>[];

  @override
  Future<DischargeSummariesPage> listSummaries() async {
    return DischargeSummariesPage(summaries: [listSummary]);
  }

  @override
  Future<DischargeSummary> getSummary(int id) async {
    requestedIds.add(id);
    return detailSummary;
  }
}

class _FakeLabResultsRepository implements LabResultsRepository {
  const _FakeLabResultsRepository({required this.result});

  final LabResult result;

  @override
  Future<LabResultsPage> listResults() async {
    return LabResultsPage(results: [result]);
  }

  @override
  Future<LabResult> getResult(int id) async => result;

  @override
  Future<LabResultTrend> getTrend(LabResult result, {int months = 24}) {
    throw UnimplementedError();
  }
}

class _FakePatientExplainersRepository implements PatientExplainersRepository {
  const _FakePatientExplainersRepository({required this.explainer});

  final PatientExplainer explainer;

  @override
  Future<List<PatientExplainer>> listExplainers() async => [explainer];

  @override
  Future<PatientExplainer> getExplainer(int reviewId) async => explainer;
}

class _FakeConsultationNotesRepository implements ConsultationNotesRepository {
  const _FakeConsultationNotesRepository({required this.note});

  final ConsultationNote note;

  @override
  Future<ConsultationNotesPage> listNotes() async {
    return ConsultationNotesPage(notes: [note]);
  }

  @override
  Future<ConsultationNote> getNote(int id) async => note;
}

DischargeSummary _summary(int id, String diagnosis) {
  return DischargeSummary(
    id: id,
    admissionId: 100 + id,
    primaryDiagnosis: diagnosis,
    status: 'SIGNED',
    dischargedAt: DateTime(2026, 7, 4),
    sections: const [
      DischargeSummarySection(
        key: 'instructions',
        title: 'Instructions',
        body: 'Take rest',
        translations: {},
        displayOrder: 1,
      ),
    ],
  );
}

PatientExplainer _explainer(int id, String moduleName) {
  return PatientExplainer(
    reviewId: id,
    generationId: id + 1000,
    moduleKey: 'medication',
    moduleName: moduleName,
    publishedAt: DateTime(2026, 7, 4),
    draft: const PatientExplainerDraft(
      explanationSummary: 'Plain-language explanation',
      keyPoints: [],
      nextSteps: [],
      whenToSeekHelp: [],
      safetyFlags: [],
    ),
    sourceCitations: const [],
    modelTier: 'standard',
  );
}

ConsultationNote _note(int id, String title) {
  return ConsultationNote(
    id: id,
    noteType: 'consultation_note',
    title: title,
    authorRole: 'doctor',
    content: const {'summary': 'Continue current medication'},
    signedAt: DateTime(2026, 7, 4),
  );
}

void _installSecureStorageFake() {
  const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
  final store = <String, String>{'user_id': 'patient-1'};

  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(channel, (MethodCall call) async {
        final args = Map<String, dynamic>.from(call.arguments as Map);
        switch (call.method) {
          case 'read':
            return store[args['key']];
          case 'write':
            store[args['key']] = args['value'] as String;
            return null;
          case 'delete':
            store.remove(args['key']);
            return null;
          case 'readAll':
            return Map<String, String>.from(store);
          case 'deleteAll':
            store.clear();
            return null;
          case 'containsKey':
            return store.containsKey(args['key']);
          default:
            return null;
        }
      });
}
