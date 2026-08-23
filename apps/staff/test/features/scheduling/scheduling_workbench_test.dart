// Scheduling Workbench (roadmap D2) pins:
//   * the Slot Grid tab renders status chips straight from the mocked
//     GET /scheduling/slots response (no synthesized slots);
//   * tapping an open slot and confirming POSTs the tapped slot's payload
//     to /scheduling/slot-holds (doctor/date/slot window/source channel)
//     with a non-empty idempotency_key, and the returned hold — with its
//     TTL — is surfaced;
//   * the Waitlist tab's fill action POSTs doctor+date to
//     /scheduling/waitlist/fill and renders the returned offers verbatim.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_staff/features/scheduling/screens/scheduling_workbench_screen.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
    VHHttpClient.resetClientForTesting();
  });

  tearDown(VHHttpClient.resetClientForTesting);

  final today = DateTime.now().toIso8601String().substring(0, 10);

  http.Response ok(Object data) => http.Response(
    jsonEncode({'success': true, 'data': data}),
    200,
    headers: {'content-type': 'application/json'},
  );

  Map<String, dynamic> slot(
    String start,
    String end, {
    List<int> bookedIds = const [],
    int? holdId,
    bool available = true,
  }) {
    return {
      'template_id': 11,
      'source': 'template',
      'start': start,
      'end': end,
      'location': 'OPD-2',
      'counter_location': null,
      'room_resource_id': null,
      'booked_appointment_ids': bookedIds,
      'active_hold_id': holdId,
      'blocked_by_exception_id': null,
      'block_reason': null,
      'available': available,
    };
  }

  Map<String, dynamic> grid() {
    return {
      'doctor_id': 7,
      'date': today,
      'on_leave': false,
      'capacity': 3,
      'booked_count': 1,
      'free_count': 1,
      'held_count': 1,
      'overbook_allowance': 1,
      'overbook_basis': {
        'scored_appointments': 1,
        'expected_no_shows': 0.4,
        'suggested_allowance': 1,
        'policy_reason': 'policy_enabled',
        'max_fraction': 0.15,
        'max_slots': 2,
      },
      'overbook_policy': {'id': 3, 'enabled': true},
      'slots': [
        slot('09:00', '09:15'),
        slot('09:15', '09:30', holdId: 77, available: false),
        slot('09:30', '09:45', bookedIds: [301], available: false),
      ],
    };
  }

  Future<void> loadSlotGrid(WidgetTester tester) async {
    await tester.pumpWidget(
      const MaterialApp(home: SchedulingWorkbenchScreen()),
    );
    await tester.enterText(find.byType(TextField).first, '7');
    await tester.tap(find.widgetWithText(FilledButton, 'Search'));
    await tester.pump();
    await tester.pump();
  }

  group('SchedulingWorkbenchScreen slot grid', () {
    testWidgets('renders status chips from the mocked GET /slots grid', (
      tester,
    ) async {
      Map<String, String>? slotsQuery;
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          if (request.method == 'GET' &&
              request.url.path.endsWith('/scheduling/slots')) {
            slotsQuery = request.url.queryParameters;
            return ok(grid());
          }
          fail('unexpected request: ${request.method} ${request.url}');
        }),
      );

      await loadSlotGrid(tester);

      expect(slotsQuery, isNotNull);
      expect(slotsQuery!['doctor_id'], '7');
      expect(slotsQuery!['date'], today);

      // One chip per slot in the response — open, held, booked.
      expect(find.text('09:00'), findsOneWidget);
      expect(find.text('09:15'), findsOneWidget);
      expect(find.text('09:30'), findsOneWidget);
      // Grid summary comes from the response counts.
      expect(find.textContaining('Overbook allowance: 1'), findsOneWidget);
    });

    testWidgets('hold flow POSTs the tapped slot to /scheduling/slot-holds', (
      tester,
    ) async {
      String? postedPath;
      String? postedBody;
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          if (request.method == 'GET' &&
              request.url.path.endsWith('/scheduling/slots')) {
            return ok(grid());
          }
          if (request.method == 'POST' &&
              request.url.path.endsWith('/scheduling/slot-holds')) {
            postedPath = request.url.path;
            postedBody = request.body;
            return ok({
              'hold': {
                'id': 501,
                'doctor_id': 7,
                'appointment_date': today,
                'slot_start': '09:00:00',
                'slot_end': '09:15:00',
                'status': 'held',
                'expires_at': '2026-08-23T10:10:00.000Z',
                'idempotent': false,
              },
            });
          }
          fail('unexpected request: ${request.method} ${request.url}');
        }),
      );

      await loadSlotGrid(tester);

      // Tap the open 09:00 slot chip → hold dialog → confirm.
      await tester.tap(find.text('09:00'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Confirm'));
      await tester.pump();
      await tester.pump();

      expect(postedPath, endsWith('/scheduling/slot-holds'));
      final body = jsonDecode(postedBody!) as Map<String, dynamic>;
      expect(body['doctor_id'], 7);
      expect(body['date'], today);
      expect(body['slot_start'], '09:00');
      expect(body['slot_end'], '09:15');
      expect(body['source_channel'], 'staff');
      expect(body['idempotency_key'], isA<String>());
      expect((body['idempotency_key'] as String).trim(), isNotEmpty);

      // The created hold (with its expiry TTL) is surfaced for
      // confirm/release follow-up.
      await tester.pump();
      expect(find.textContaining('#501'), findsOneWidget);
      expect(find.textContaining('2026-08-23T10:10:00.000Z'), findsOneWidget);
      expect(find.widgetWithText(OutlinedButton, 'Release'), findsOneWidget);
    });
  });

  group('SchedulingWorkbenchScreen waitlist', () {
    testWidgets('fill POSTs doctor+date and renders the returned offers', (
      tester,
    ) async {
      String? postedBody;
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          if (request.method == 'POST' &&
              request.url.path.endsWith('/scheduling/waitlist/fill')) {
            postedBody = request.body;
            return ok({
              'offers': [
                {
                  'waitlist_id': 12,
                  'patient_uid': 'pt-uuid-1',
                  'slot': {'date': today, 'start': '10:00'},
                },
              ],
              'free_slots_remaining': 3,
            });
          }
          fail('unexpected request: ${request.method} ${request.url}');
        }),
      );

      await tester.pumpWidget(
        const MaterialApp(home: SchedulingWorkbenchScreen()),
      );
      await tester.tap(find.text('Waitlist'));
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextField).first, '7');
      await tester.tap(find.text('Fill from waitlist'));
      await tester.pump();
      await tester.pump();

      expect(jsonDecode(postedBody!), {'doctor_id': 7, 'date': today});
      expect(find.textContaining('Offers: 1'), findsOneWidget);
      expect(find.textContaining('#12'), findsOneWidget);
      expect(find.textContaining('pt-uuid-1'), findsOneWidget);
      expect(find.textContaining('10:00'), findsOneWidget);
    });
  });
}
