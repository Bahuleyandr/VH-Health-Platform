// B6 medication reconciliation flow pins:
//   * the decider gate mirrors backend medRecRoutes canDecide (doctor tiers +
//     ADMIN + pharmacy roles + SUPER_ADMIN) — everyone else is read-only;
//   * the list screen renders a patient's reconciliations (type, status,
//     counts) from the GET /med-rec/patient/:uid envelope;
//   * a per-item decision PATCHes /med-rec/:id/items/:itemId with the chosen
//     decision + reason (and the reason gate blocks an empty submit);
//   * a refused completion surfaces the server's AppError message verbatim
//     in a SnackBar.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_staff/features/med_rec/screens/med_rec_detail_screen.dart';
import 'package:vhhealth_staff/features/med_rec/screens/med_rec_screen.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  http.Response ok(Object data) => http.Response(
    jsonEncode({'success': true, 'data': data}),
    200,
    headers: {'content-type': 'application/json'},
  );

  http.Response refuse(String message, [int status = 409]) => http.Response(
    jsonEncode({'success': false, 'message': message}),
    status,
    headers: {'content-type': 'application/json'},
  );

  Map<String, dynamic> itemRow({
    required int id,
    required String name,
    String source = 'home',
    String? dose,
    String? route,
    String? frequency,
    String? decision,
    String? decisionReason,
    String discrepancy = 'unchanged',
  }) {
    return {
      'id': id,
      'medication_name': name,
      'dose': dose,
      'frequency': frequency,
      'route': route,
      'source': source,
      'source_ref': null,
      'decision': decision,
      'decision_reason': decisionReason,
      'new_instructions': null,
      'changed_dose': null,
      'changed_route': null,
      'changed_frequency': null,
      'safety_review_id': null,
      'discrepancy_type': discrepancy,
      'decided_by': null,
      'decided_at': null,
    };
  }

  Map<String, dynamic> recDetail({
    String id = 'rec-1',
    String recType = 'admission',
    String status = 'in_progress',
    List<Map<String, dynamic>>? items,
  }) {
    return {
      'id': id,
      'rec_type': recType,
      'status': status,
      'transfer_context': null,
      'notes': null,
      'started_at': '2026-08-20T10:00:00Z',
      'completed_at': status == 'completed' ? '2026-08-21T09:00:00Z' : null,
      'items':
          items ??
          [
            itemRow(
              id: 1,
              name: 'Warfarin 5mg',
              source: 'home',
              dose: '5mg',
              frequency: 'OD',
              discrepancy: 'omitted',
            ),
            itemRow(
              id: 2,
              name: 'Metformin 500mg',
              source: 'active_prescription',
              dose: '500mg',
              frequency: 'BD',
              decision: 'continue',
              decisionReason: 'Ongoing diabetes management',
            ),
          ],
    };
  }

  group('medRecCanDecideForRawRole', () {
    test('mirrors backend canDecide: doctor tiers + admin + pharmacy', () {
      for (final role in const [
        'DOCTOR',
        'DUTY_DOCTOR',
        'CONSULTANT',
        'JUNIOR_DOCTOR',
        'RESIDENT',
        'ADMIN',
        'PHARMACY_STAFF',
        'PHARMACY_INCHARGE',
        'SUPER_ADMIN',
      ]) {
        expect(medRecCanDecideForRawRole(role), isTrue, reason: role);
      }
      for (final role in const [
        'NURSING_STAFF',
        'NURSING_INCHARGE',
        'GENERAL_STAFF',
        'LAB_STAFF',
        '',
      ]) {
        expect(medRecCanDecideForRawRole(role), isFalse, reason: role);
      }
    });
  });

  group('MedRecScreen', () {
    setUp(() {
      FlutterSecureStorage.setMockInitialValues({
        'staff_role': 'NURSING_STAFF',
      });
      VHHttpClient.resetClientForTesting();
    });

    tearDown(VHHttpClient.resetClientForTesting);

    testWidgets('renders the reconciliation list from mocked responses', (
      tester,
    ) async {
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          if (request.method == 'GET' &&
              request.url.path.endsWith('/med-rec/patient/pat-1')) {
            return ok({
              'reconciliations': [
                {
                  'id': 'rec-1',
                  'rec_type': 'admission',
                  'status': 'in_progress',
                  'notes': 'Admitted via ED',
                  'started_at': '2026-08-20T10:00:00Z',
                  'completed_at': null,
                  'item_count': 5,
                  'undecided_count': 2,
                },
                {
                  'id': 'rec-0',
                  'rec_type': 'discharge',
                  'status': 'completed',
                  'notes': null,
                  'started_at': '2026-08-10T08:00:00Z',
                  'completed_at': '2026-08-10T11:00:00Z',
                  'item_count': 3,
                  'undecided_count': 0,
                },
              ],
              'count': 2,
            });
          }
          fail('unexpected request: ${request.method} ${request.url}');
        }),
      );

      await tester.pumpWidget(
        const MaterialApp(home: MedRecScreen(patientUid: 'pat-1')),
      );
      await tester.pumpAndSettle();

      expect(find.text('Admission reconciliation'), findsOneWidget);
      expect(find.text('In progress'), findsOneWidget);
      expect(find.textContaining('2 undecided'), findsOneWidget);
      expect(find.text('Discharge reconciliation'), findsOneWidget);
      expect(find.text('Completed'), findsOneWidget);
      expect(find.textContaining('all decided'), findsOneWidget);
      expect(find.text('Admitted via ED'), findsOneWidget);
      // NURSING_STAFF is not a decider — the start affordance stays hidden.
      expect(find.text('Start reconciliation'), findsNothing);
    });
  });

  group('MedRecDetailScreen', () {
    setUp(() {
      FlutterSecureStorage.setMockInitialValues({'staff_role': 'DOCTOR'});
      VHHttpClient.resetClientForTesting();
    });

    tearDown(VHHttpClient.resetClientForTesting);

    testWidgets('a decision PATCHes the chosen decision + reason', (
      tester,
    ) async {
      String? patchedPath;
      String? patchedBody;
      var stopped = false;
      List<Map<String, dynamic>> items() => [
        itemRow(
          id: 1,
          name: 'Warfarin 5mg',
          source: 'home',
          dose: '5mg',
          frequency: 'OD',
          discrepancy: 'omitted',
          decision: stopped ? 'stop' : null,
          decisionReason: stopped ? 'Cardiology advised - bleeding risk' : null,
        ),
        itemRow(
          id: 2,
          name: 'Metformin 500mg',
          source: 'active_prescription',
          dose: '500mg',
          frequency: 'BD',
          decision: 'continue',
          decisionReason: 'Ongoing diabetes management',
        ),
      ];
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          if (request.method == 'GET' &&
              request.url.path.endsWith('/med-rec/rec-1')) {
            return ok({'reconciliation': recDetail(items: items())});
          }
          if (request.method == 'PATCH' &&
              request.url.path.endsWith('/med-rec/rec-1/items/1')) {
            patchedPath = request.url.path;
            patchedBody = request.body;
            stopped = true;
            return ok({'item': items().first});
          }
          fail('unexpected request: ${request.method} ${request.url}');
        }),
      );

      await tester.pumpWidget(
        const MaterialApp(home: MedRecDetailScreen(recId: 'rec-1')),
      );
      await tester.pumpAndSettle();

      expect(find.text('Warfarin 5mg'), findsOneWidget);
      expect(find.text('OMITTED'), findsOneWidget);
      expect(find.text('Metformin 500mg'), findsOneWidget);
      expect(find.text('CONTINUE'), findsOneWidget);

      // The undecided item carries the 'Decide' control.
      await tester.tap(find.text('Decide'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Stop'));
      await tester.pumpAndSettle();

      // Reason is required for a stop — an empty submit is blocked.
      await tester.tap(find.widgetWithText(FilledButton, 'Save decision'));
      await tester.pumpAndSettle();
      expect(patchedBody, isNull);
      expect(find.textContaining('reason is required'), findsOneWidget);

      await tester.enterText(
        find.byType(TextField).first,
        'Cardiology advised - bleeding risk',
      );
      await tester.tap(find.widgetWithText(FilledButton, 'Save decision'));
      await tester.pumpAndSettle();

      expect(patchedPath, endsWith('/med-rec/rec-1/items/1'));
      expect(jsonDecode(patchedBody!), {
        'decision': 'stop',
        'reason': 'Cardiology advised - bleeding risk',
      });
      // Optimistic merge shows the decision without waiting for the re-fetch.
      expect(find.text('STOP'), findsOneWidget);
    });

    testWidgets('a refused completion surfaces the server message verbatim', (
      tester,
    ) async {
      const refusal =
          '1 high-alert medication discrepancy(ies) need an explicit, '
          'documented decision before completion';
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          if (request.method == 'GET' &&
              request.url.path.endsWith('/med-rec/rec-1')) {
            return ok({'reconciliation': recDetail()});
          }
          if (request.method == 'POST' &&
              request.url.path.endsWith('/med-rec/rec-1/complete')) {
            return refuse(refusal);
          }
          fail('unexpected request: ${request.method} ${request.url}');
        }),
      );

      await tester.pumpWidget(
        const MaterialApp(home: MedRecDetailScreen(recId: 'rec-1')),
      );
      await tester.pumpAndSettle();

      await tester.ensureVisible(find.text('Complete reconciliation'));
      await tester.tap(find.text('Complete reconciliation'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Confirm'));
      await tester.pumpAndSettle();

      expect(
        find.textContaining('high-alert medication discrepancy'),
        findsOneWidget,
      );
      // Still in progress — the decision controls stay live.
      expect(find.text('In progress'), findsOneWidget);
    });

    testWidgets('a completed reconciliation renders read-only', (tester) async {
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          if (request.method == 'GET' &&
              request.url.path.endsWith('/med-rec/rec-1')) {
            return ok({
              'reconciliation': recDetail(
                status: 'completed',
                items: [
                  itemRow(
                    id: 1,
                    name: 'Warfarin 5mg',
                    decision: 'stop',
                    decisionReason: 'Bleeding risk',
                  ),
                ],
              ),
            });
          }
          fail('unexpected request: ${request.method} ${request.url}');
        }),
      );

      await tester.pumpWidget(
        const MaterialApp(home: MedRecDetailScreen(recId: 'rec-1')),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('decisions are frozen'), findsOneWidget);
      expect(find.text('Decide'), findsNothing);
      expect(find.text('Change decision'), findsNothing);
      expect(find.text('Complete reconciliation'), findsNothing);
    });
  });
}
