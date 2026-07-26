import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/services/realtime_client.dart';
import 'package:vhhealth_staff/features/theatre/screens/theatre_screen.dart';

void main() {
  testWidgets(
    'WHO sign-in requires every confirmation before it records evidence',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(1000, 1000));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      String? recordedPhase;
      Map<String, dynamic>? recordedEvidence;
      final schedule = <String, dynamic>{
        'id': 42,
        'patient_uid': '11111111-1111-4111-8111-111111111111',
        'procedure_name': 'Appendectomy',
        'procedure_code': 'PROC-42',
        'ot_room': 'OT-1',
        'scheduled_date': '2026-07-26',
        'scheduled_time': '10:00',
        'estimated_duration': 60,
        'surgeon': '22222222-2222-4222-8222-222222222222',
        'anesthetist': '33333333-3333-4333-8333-333333333333',
        'status': 'pre_op',
        'consent_obtained': true,
        'blood_arranged': true,
      };

      await tester.pumpWidget(
        MaterialApp(
          home: TheatreScreen(
            loadSchedule: ({required String date}) async => [schedule],
            loadAvailability: (_) async => const [],
            realtimeEvents: (_) => const Stream<RealtimeEvent>.empty(),
            recordSafetyPhase: (scheduleId, phase, evidence) async {
              expect(scheduleId, 42);
              recordedPhase = phase;
              recordedEvidence = evidence;
              return {'status': 'complete'};
            },
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Appendectomy'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('WHO sign-in'));
      await tester.pumpAndSettle();

      final complete = find.byKey(const ValueKey('complete-who-sign_in'));
      expect(tester.widget<ElevatedButton>(complete).onPressed, isNull);

      for (var index = 0; index < 5; index++) {
        await tester.tap(find.byKey(ValueKey('who-sign_in-$index')));
        await tester.pump();
      }

      expect(tester.widget<ElevatedButton>(complete).onPressed, isNotNull);
      await tester.tap(complete);
      await tester.pumpAndSettle();

      expect(recordedPhase, 'sign_in');
      expect(recordedEvidence, containsPair('all_items_confirmed', true));
      expect(recordedEvidence, containsPair('status', 'complete'));
      expect(recordedEvidence?['outstanding_items'], isEmpty);
      expect(recordedEvidence?['items'], hasLength(5));
      expect(recordedEvidence?['items'].first['item'], 'identity');
      expect(
        (recordedEvidence?['items'] as List).every(
          (item) => (item as Map<String, dynamic>)['confirmed'] == true,
        ),
        isTrue,
      );
    },
  );
}
