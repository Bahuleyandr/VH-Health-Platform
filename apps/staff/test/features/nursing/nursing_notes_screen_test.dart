import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/nursing/screens/nursing_notes_screen.dart';

void main() {
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
}
