import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/oncology/screens/oncology_screen.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('renders tumor-board queue and toxicity history', (tester) async {
    final api = _FakeOncologyApiClient();
    await tester.pumpWidget(_host(api));
    await tester.pumpAndSettle();

    expect(find.text('Oncology'), findsOneWidget);
    expect(find.text('Breast'), findsOneWidget);
    expect(find.text('Confirm systemic therapy sequence'), findsOneWidget);

    await tester.tap(find.text('Toxicity'));
    await tester.pumpAndSettle();
    await tester.drag(find.byType(ListView).last, const Offset(0, -500));
    await tester.pumpAndSettle();

    expect(find.text('Neuropathy'), findsOneWidget);
    expect(find.text('Capture Toxicity'), findsOneWidget);
  });

  testWidgets('submits toxicity capture with source metadata', (tester) async {
    final api = _FakeOncologyApiClient();
    await tester.pumpWidget(_host(api));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Toxicity'));
    await tester.pumpAndSettle();

    await tester.enterText(
      find.widgetWithText(TextField, 'Patient UID'),
      'fa130000-0000-4000-8000-000000000001',
    );
    await tester.enterText(
      find.widgetWithText(TextField, 'Toxicity term'),
      'Mucositis',
    );
    await tester.enterText(
      find.widgetWithText(TextField, 'CTCAE source'),
      'Hospital supplied CTCAE reference',
    );
    await tester.enterText(
      find.widgetWithText(TextField, 'CTCAE version'),
      'v5.0-owner',
    );
    await tester.drag(find.byType(ListView).last, const Offset(0, -800));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Save toxicity'));
    await tester.pumpAndSettle();

    expect(api.createdInputs, hasLength(1));
    expect(api.createdInputs.single.term, 'Mucositis');
    expect(api.createdInputs.single.sourceVersion, 'v5.0-owner');
    expect(find.text('Toxicity event saved'), findsOneWidget);
  });
}

Widget _host(OncologyApiClient api) {
  return MaterialApp(
    debugShowCheckedModeBanner: false,
    supportedLocales: AppStrings.supportedLocales,
    localizationsDelegates: const [
      GlobalMaterialLocalizations.delegate,
      GlobalWidgetsLocalizations.delegate,
      GlobalCupertinoLocalizations.delegate,
    ],
    home: OncologyScreen(apiClient: api),
  );
}

class _FakeOncologyApiClient implements OncologyApiClient {
  final createdInputs = <OncologyToxicityInput>[];
  var toxicity = <OncologyToxicityEvent>[
    const OncologyToxicityEvent(
      id: 7,
      patientUid: 'fa130000-0000-4000-8000-000000000001',
      patientName: 'NL13 Patient',
      term: 'Neuropathy',
      grade: 2,
      source: 'Hospital supplied CTCAE reference',
      sourceVersion: 'v5.0-owner',
      actionTaken: 'monitor',
      signoffStatus: 'signed',
    ),
  ];

  @override
  Future<OncologyToxicityEvent> createToxicityEvent(
    OncologyToxicityInput input,
  ) async {
    createdInputs.add(input);
    final event = OncologyToxicityEvent(
      id: 8,
      patientUid: input.patientUid,
      term: input.term,
      grade: input.grade,
      source: input.source,
      sourceVersion: input.sourceVersion,
      actionTaken: input.actionTaken,
      signoffStatus: input.signoff ? 'signed' : 'draft',
    );
    toxicity = [event, ...toxicity];
    return event;
  }

  @override
  Future<List<OncologyToxicityEvent>> fetchToxicityEvents() async => toxicity;

  @override
  Future<List<OncologyTumorBoardCase>> fetchTumorBoardQueue() async => const [
    OncologyTumorBoardCase(
      id: 42,
      patientUid: 'fa130000-0000-4000-8000-000000000001',
      patientName: 'NL13 Patient',
      cancerSite: 'Breast',
      question: 'Confirm systemic therapy sequence',
      priority: 'urgent',
      discussionState: 'queued',
      tCategory: 'cT2',
      nCategory: 'cN1',
      mCategory: 'M0',
    ),
  ];
}
