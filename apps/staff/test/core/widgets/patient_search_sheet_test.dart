import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/widgets/patient_search_sheet.dart';

void main() {
  const patient = {
    'id': 18,
    'uid': 'patient-18',
    'hospital_number': 'VH-000018',
    'name': 'Test Patient',
    'phone': '+911234567890',
  };

  group('patientSearchOpenRouteForRole', () {
    test('keeps front-office roles in the workbench patient context', () {
      final route = patientSearchOpenRouteForRole('RECEPTIONIST', patient);

      final uri = Uri.parse(route);
      expect(uri.path, '/front-office');
      expect(uri.queryParameters['patient_uid'], 'patient-18');
      expect(uri.queryParameters['patient_id'], '18');
      expect(uri.queryParameters['hospital_number'], 'VH-000018');
      expect(uri.queryParameters['name'], 'Test Patient');
      expect(uri.queryParameters['phone'], '+911234567890');
    });

    test('opens clinical timeline for clinical roles', () {
      final route = patientSearchOpenRouteForRole('DOCTOR', patient);

      final uri = Uri.parse(route);
      expect(uri.path, '/emr/timeline/patient-18');
      expect(uri.queryParameters['name'], 'Test Patient');
    });
  });

  testWidgets('pick-only mode returns the selected patient', (tester) async {
    Map<String, dynamic>? selected;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => ElevatedButton(
              onPressed: () async {
                selected = await showModalBottomSheet<Map<String, dynamic>>(
                  context: context,
                  isScrollControlled: true,
                  builder: (_) => PatientSearchSheet(
                    pickOnly: true,
                    search: (_) async => const [
                      {
                        'uid': 'a9999999-9999-4999-8999-999999999a03',
                        'hospital_number': 'VH-000018',
                        'name': 'Blood Test Patient',
                      },
                    ],
                  ),
                );
              },
              child: const Text('Open patient picker'),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('Open patient picker'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'Blood');
    await tester.pump(const Duration(milliseconds: 301));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Blood Test Patient'));
    await tester.pumpAndSettle();

    expect(selected?['uid'], 'a9999999-9999-4999-8999-999999999a03');
  });

  testWidgets('pick-only mode does not expose the full patient summary', (
    tester,
  ) async {
    var summaryOpened = false;
    PatientSearchSheet.summaryOpener = (_, {required patientUid, patientName}) {
      summaryOpened = true;
    };
    addTearDown(() => PatientSearchSheet.summaryOpener = null);

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: PatientSearchSheet(
            pickOnly: true,
            search: (_) async => const [
              {
                'uid': 'a9999999-9999-4999-8999-999999999a03',
                'name': 'Blood Test Patient',
              },
            ],
          ),
        ),
      ),
    );

    await tester.enterText(find.byType(TextField), 'Blood');
    await tester.pump(const Duration(milliseconds: 301));
    await tester.pumpAndSettle();

    expect(find.byIcon(Icons.assignment_ind_outlined), findsNothing);
    expect(summaryOpened, isFalse);
  });

  testWidgets('a stale failed lookup cannot replace newer results', (
    tester,
  ) async {
    final first = Completer<List<Map<String, dynamic>>>();
    final second = Completer<List<Map<String, dynamic>>>();

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: PatientSearchSheet(
            search: (query) => query == 'Blood' ? first.future : second.future,
          ),
        ),
      ),
    );

    await tester.enterText(find.byType(TextField), 'Blood');
    await tester.pump(const Duration(milliseconds: 301));
    await tester.enterText(find.byType(TextField), 'Blood Test');
    await tester.pump(const Duration(milliseconds: 301));

    second.complete(const [
      {
        'uid': 'a9999999-9999-4999-8999-999999999a03',
        'name': 'Blood Test Patient',
      },
    ]);
    await tester.pump();
    first.completeError(Exception('stale backend failure'));
    await tester.pumpAndSettle();

    expect(find.text('Blood Test Patient'), findsOneWidget);
    expect(find.text('stale backend failure'), findsNothing);
  });
}
