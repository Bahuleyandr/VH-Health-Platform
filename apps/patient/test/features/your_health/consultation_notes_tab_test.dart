import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:vhhealth/features/your_health/models/consultation_note.dart';
import 'package:vhhealth/features/your_health/screens/your_health_screen.dart';
import 'package:vhhealth/features/your_health/services/consultation_notes_repository.dart';
import 'package:vhhealth/features/your_health/widgets/consultation_notes_tab.dart';
import 'package:vhhealth/generated/app_localizations.dart';

void main() {
  testWidgets('Your Health tabs label the section Consultation notes', (
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

    expect(find.text('Consultation notes'), findsOneWidget);
    expect(find.text('Clinical notes'), findsNothing);
  });

  testWidgets('shows consultation note rows and read-only detail sections', (
    tester,
  ) async {
    final note = _sampleNote();
    final repository = _FakeConsultationNotesRepository([note]);
    final router = GoRouter(
      initialLocation: '/health',
      routes: [
        GoRoute(
          path: '/health',
          builder: (_, _) => ConsultationNotesTab(repository: repository),
        ),
        GoRoute(
          path: '/health/consultation-notes/:id',
          builder: (_, state) {
            final args = state.extra is ConsultationNoteDetailRouteArgs
                ? state.extra! as ConsultationNoteDetailRouteArgs
                : null;
            return ConsultationNoteDetailScreen(
              noteId: int.parse(state.pathParameters['id']!),
              initialNote: args?.initialNote,
              repository: args?.repository ?? repository,
            );
          },
        ),
      ],
    );
    addTearDown(router.dispose);

    await tester.pumpWidget(_RouterHarness(router: router));

    await tester.pumpAndSettle();

    expect(find.text('Signed OP consultation'), findsOneWidget);
    expect(find.textContaining('Doctor role: Doctor'), findsOneWidget);
    expect(find.textContaining('Type: OP consultation'), findsOneWidget);

    await tester.tap(find.text('Signed OP consultation'));
    await tester.pumpAndSettle();

    expect(repository.detailRequests, 1);
    expect(find.text('Note details'), findsOneWidget);
    expect(find.text('Chief Complaint'), findsOneWidget);
    expect(find.text('Follow-up cough'), findsOneWidget);
    expect(find.text('Diagnosis'), findsOneWidget);
    expect(find.text('Resolving URTI'), findsOneWidget);
  });

  testWidgets('shows localized empty state when no notes are returned', (
    tester,
  ) async {
    await tester.pumpWidget(
      _LocalizedHarness(
        child: ConsultationNotesTab(
          repository: _FakeConsultationNotesRepository(const []),
        ),
      ),
    );

    await tester.pumpAndSettle();

    expect(find.text('No consultation notes yet'), findsOneWidget);
    expect(
      find.textContaining('Signed appointment notes from your doctor'),
      findsOneWidget,
    );
    expect(find.text('Clinical notes'), findsNothing);
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
      home: Scaffold(body: child),
    );
  }
}

class _FakeConsultationNotesRepository implements ConsultationNotesRepository {
  _FakeConsultationNotesRepository(this.notes);

  final List<ConsultationNote> notes;
  int detailRequests = 0;

  @override
  Future<ConsultationNotesPage> listNotes() async =>
      ConsultationNotesPage(notes: notes);

  @override
  Future<ConsultationNote> getNote(int id) async {
    detailRequests += 1;
    return notes.firstWhere((note) => note.id == id);
  }
}

ConsultationNote _sampleNote() {
  return ConsultationNote(
    id: 12,
    noteType: 'op_consultation',
    title: 'Signed OP consultation',
    authorRole: 'doctor',
    signedAt: DateTime.utc(2026, 7, 3, 8, 30),
    updatedAt: DateTime.utc(2026, 7, 3, 8, 45),
    content: const {
      'chief_complaint': 'Follow-up cough',
      'history': 'Improving',
      'examination': 'Chest clear',
      'diagnosis': 'Resolving URTI',
      'plan': 'Continue fluids',
    },
  );
}
