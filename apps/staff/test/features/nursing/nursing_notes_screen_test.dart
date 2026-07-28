import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vhhealth_staff/core/providers/theme_provider.dart';
import 'package:vhhealth_staff/features/nursing/screens/nursing_notes_screen.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

const _nursingNoteCategories = <String>[
  'Observation',
  'Medication Note',
  'Post-Procedure',
  'Intake/Output',
  'Patient Complaint',
  'Wound Care',
  'Shift Handover',
  'Emergency Note',
  'Other',
];

Future<void> _pumpNursingNotesScreen(
  WidgetTester tester, {
  required NursingNoteCreator createNote,
  bool isOnline = false,
}) async {
  SharedPreferences.setMockInitialValues({});
  const secureStorage = MethodChannel(
    'plugins.it_nomads.com/flutter_secure_storage',
  );
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(secureStorage, (_) async => null);
  addTearDown(
    () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(secureStorage, null),
  );

  final router = GoRouter(
    routes: [
      GoRoute(
        path: '/',
        builder: (_, _) => NursingNotesScreen(
          isOnline: () => isOnline,
          createNote: createNote,
        ),
      ),
      GoRoute(path: '/dashboard', builder: (_, _) => const SizedBox.shrink()),
    ],
  );
  addTearDown(router.dispose);

  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(900, 1200);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);

  await tester.pumpWidget(
    ChangeNotifierProvider(
      create: (_) => ThemeProvider(),
      child: MaterialApp.router(routerConfig: router),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  Widget recentTab({
    required RecentNursingNotesLoader loader,
    String patientUid = 'patient-1',
  }) {
    return MaterialApp(
      home: Scaffold(
        body: SizedBox(
          width: 520,
          height: 640,
          child: RecentNursingNotesTab(
            patientUid: patientUid,
            loadNotes: loader,
            pageSize: 1,
          ),
        ),
      ),
    );
  }

  testWidgets('loads recent nursing notes and fetches the next page', (
    tester,
  ) async {
    final calls = <int>[];
    Future<Map<String, dynamic>> loader(
      String patientUid, {
      int page = 1,
      int limit = 10,
      String? noteType,
    }) async {
      calls.add(page);
      expect(patientUid, 'patient-1');
      expect(noteType, 'nursing_assessment');
      expect(limit, 1);
      return {
        'notes': [
          {
            'id': page,
            'note_type': 'nursing_assessment',
            'content': {
              'free_text': page == 1
                  ? 'Patient slept well overnight.'
                  : 'Patient walked with assistance.',
              'note_category': 'Observation',
            },
            'author_name': 'Nurse A',
            'created_at': page == 1
                ? '2026-07-01T10:00:00Z'
                : '2026-07-01T09:30:00Z',
          },
        ],
        'pagination': {
          'page': page,
          'limit': 1,
          'total': 2,
          'totalPages': 2,
          'hasNext': page == 1,
        },
      };
    }

    await tester.pumpWidget(recentTab(loader: loader));
    await tester.pumpAndSettle();

    expect(calls, [1]);
    expect(find.text('Patient slept well overnight.'), findsOneWidget);
    expect(find.text('Load more'), findsOneWidget);

    await tester.tap(find.text('Load more'));
    await tester.pumpAndSettle();

    expect(calls, [1, 2]);
    expect(find.text('Patient walked with assistance.'), findsOneWidget);
    expect(find.text('Load more'), findsNothing);
  });

  testWidgets('uses the shared empty state when no recent notes exist', (
    tester,
  ) async {
    Future<Map<String, dynamic>> loader(
      String patientUid, {
      int page = 1,
      int limit = 10,
      String? noteType,
    }) async {
      return {
        'notes': const [],
        'pagination': {
          'page': 1,
          'limit': limit,
          'total': 0,
          'totalPages': 1,
          'hasNext': false,
        },
      };
    }

    await tester.pumpWidget(recentTab(loader: loader));
    await tester.pumpAndSettle();

    expect(find.text('Recent Notes'), findsOneWidget);
    expect(
      find.text('No recent nursing notes are recorded for this patient yet.'),
      findsOneWidget,
    );
    expect(find.byType(CircularProgressIndicator), findsNothing);
  });

  test('extracts nested notes and pagination from EMR response wrappers', () {
    final response = {
      'data': {
        'notes': [
          {'id': 1, 'content': 'note'},
        ],
        'pagination': {'page': 1, 'totalPages': 2},
      },
    };

    expect(recentNursingNotesFromResponse(response), hasLength(1));
    expect(recentNursingNotesHasNextPage(response), isTrue);
  });

  for (final category in _nursingNoteCategories) {
    testWidgets(
      'offline $category uses nursing note forms without submit or reset',
      (tester) async {
        final submittedBodies = <Map<String, dynamic>>[];
        await _pumpNursingNotesScreen(
          tester,
          createNote: (body) async {
            submittedBodies.add(body);
            return const {};
          },
        );

        final fields = find.byType(TextFormField);
        await tester.enterText(fields.at(0), '9876543210');
        await tester.enterText(
          fields.at(1),
          'Patient remains stable during this observation.',
        );
        await tester.tap(find.byType(DropdownButtonFormField<String>));
        await tester.pumpAndSettle();
        await tester.tap(find.text(category).last);
        await tester.pumpAndSettle();

        final saveButton = find.byType(ElevatedButton);
        await tester.ensureVisible(saveButton);
        await tester.pumpAndSettle();
        await tester.tap(saveButton);
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 300));

        const exactFallback =
            'This action was not saved for automatic sync. Use the '
            "department's nursing note forms and follow the downtime "
            'reconciliation procedure. Keep the entered information open '
            'until it has been transferred to paper.';
        final strings = AppStrings.forLocale(const Locale('en'));
        expect(
          strings.offlineClinicalFallbackMessage(
            strings.offlineClinicalFallbackNursingNoteForms,
          ),
          exactFallback,
        );
        expect(find.text(exactFallback), findsOneWidget);
        expect(submittedBodies, isEmpty);

        await tester.tap(find.text(strings.offlineClinicalFallbackKeepOpen));
        await tester.pumpAndSettle();

        final retainedFields = tester.widgetList<TextFormField>(
          find.byType(TextFormField),
        );
        expect(retainedFields.elementAt(0).controller!.text, '9876543210');
        expect(
          retainedFields.elementAt(1).controller!.text,
          'Patient remains stable during this observation.',
        );
        expect(find.text(category), findsOneWidget);
        expect(submittedBodies, isEmpty);
        expect(find.byType(SnackBar), findsNothing);
      },
    );
  }

  testWidgets('online nursing note still submits and resets the form', (
    tester,
  ) async {
    final submittedBodies = <Map<String, dynamic>>[];
    await _pumpNursingNotesScreen(
      tester,
      isOnline: true,
      createNote: (body) async {
        submittedBodies.add(body);
        return const {'id': 1};
      },
    );

    final fields = find.byType(TextFormField);
    await tester.enterText(fields.at(0), '9876543210');
    await tester.enterText(
      fields.at(1),
      'Patient remains stable during this observation.',
    );
    await tester.tap(find.byType(DropdownButtonFormField<String>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Observation').last);
    await tester.pumpAndSettle();

    final saveButton = find.byType(ElevatedButton);
    await tester.ensureVisible(saveButton);
    await tester.pumpAndSettle();
    await tester.tap(saveButton);
    await tester.pumpAndSettle();

    expect(submittedBodies, [
      {
        'phone': '9876543210',
        'note_type': 'Observation',
        'content': {
          'free_text': 'Patient remains stable during this observation.',
        },
        'priority': 'normal',
      },
    ]);
    final resetFields = tester.widgetList<TextFormField>(
      find.byType(TextFormField),
    );
    expect(resetFields.elementAt(0).controller!.text, isEmpty);
    expect(resetFields.elementAt(1).controller!.text, isEmpty);
    expect(find.text('Observation'), findsNothing);
    expect(find.text('Nursing note saved successfully'), findsOneWidget);
  });
}
