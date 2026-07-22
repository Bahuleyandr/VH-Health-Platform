import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_staff/features/radiology/screens/radiology_screen.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
    VHHttpClient.resetClientForTesting();
    VHHttpClient.onSessionExpired = null;
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        expect(request.method, 'GET');
        expect(request.url.path, endsWith('/radiology/worklist'));
        return http.Response(
          jsonEncode({
            'success': true,
            'data': {
              'orders': [
                {
                  'id': 42,
                  'patient_uid': '11111111-1111-4111-8111-111111111111',
                  'modality': 'CT',
                  'body_part': 'Chest',
                  'priority': 'routine',
                  'status': 'completed',
                  'report': 'Signed report',
                  'report_signed_off_at': '2026-07-22T10:00:00.000Z',
                  'result_classification': 'critical',
                  'report_generation_version': 2,
                  'diagnostic_generation_id':
                      '33333333-3333-4333-8333-333333333333',
                  'patient_release_hold': false,
                  'patient_release_doctor_reviewed': false,
                  'created_at': '2026-07-22T09:00:00.000Z',
                },
              ],
            },
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );
  });

  tearDown(() {
    VHHttpClient.resetClientForTesting();
    VHHttpClient.onSessionExpired = null;
  });

  testWidgets(
    'shows signed classification, generation, and structured addendum form',
    (tester) async {
      await tester.pumpWidget(const MaterialApp(home: RadiologyScreen()));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Study - CT'));
      await tester.pumpAndSettle();

      expect(find.text('Result classification'), findsOneWidget);
      expect(find.text('Critical'), findsOneWidget);
      expect(find.text('Signed result version'), findsOneWidget);
      expect(find.text('2'), findsOneWidget);
      expect(find.text('Add addendum'), findsOneWidget);
      expect(
        find.text('Awaiting doctor review before patient release'),
        findsOneWidget,
      );
      expect(find.text('Release to patient now'), findsNothing);

      await tester.ensureVisible(find.text('Add addendum'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Add addendum'));
      await tester.pumpAndSettle();

      expect(find.text('Addendum'), findsOneWidget);
      expect(find.text('Clinical significance'), findsOneWidget);
      expect(
        find.byType(DropdownButtonFormField<String>),
        findsAtLeastNWidgets(2),
      );
      expect(find.text('Submit'), findsOneWidget);
    },
  );
}
