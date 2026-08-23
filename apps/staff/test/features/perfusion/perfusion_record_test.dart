import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/perfusion/screens/perfusion_record_screen.dart';

// The finalize precondition copy must mirror the backend refusal verbatim
// (PERFUSION_SIGNOFF_REVIEWS_REQUIRED in
// apps/backend/src/services/theatre/ctvsPerfusionService.js).
const serverFinalizeRefusal =
    'Perfusionist sign-off, surgeon review, and anesthesia review are '
    'required before finalize';

const record = <String, dynamic>{
  'id': 12,
  'ot_schedule_id': 44,
  'patient_uid': '22222222-2222-4222-8222-222222222222',
  'status': 'recorded',
  'bypass_started_at': '2026-08-23T03:10:00.000Z',
  'bypass_ended_at': '2026-08-23T04:42:00.000Z',
  'cross_clamp_started_at': '2026-08-23T03:25:00.000Z',
  'cross_clamp_ended_at': '2026-08-23T04:20:00.000Z',
  'act_baseline_seconds': 130,
  'act_peak_seconds': 480,
  'act_last_seconds': 140,
  'temperature_min_c': 28.5,
  'temperature_max_c': 36.8,
  'complications': null,
};

void main() {
  void useTallSurface(WidgetTester tester) {
    tester.view.physicalSize = const Size(1400, 4600);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
  }

  testWidgets('perfusion records for a theatre case render from mock', (
    tester,
  ) async {
    useTallSurface(tester);
    int? requestedOtScheduleId;
    await tester.pumpWidget(
      MaterialApp(
        home: PerfusionRecordScreen(
          theatreCaseRef: '44',
          loadRecords: ({int? otScheduleId}) async {
            requestedOtScheduleId = otScheduleId;
            return const [record];
          },
          loadDeviceLinks: ({required int perfusionRecordId}) async => const [],
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(requestedOtScheduleId, 44);
    expect(find.byKey(const ValueKey('perfusion-record-12')), findsOneWidget);
    expect(find.text('#12 · recorded'), findsOneWidget);
  });

  testWidgets('signoff then finalize fire the right POSTs in order', (
    tester,
  ) async {
    useTallSurface(tester);
    final calls = <String>[];
    Map<String, dynamic>? signoffBody;
    await tester.pumpWidget(
      MaterialApp(
        home: PerfusionRecordScreen(
          theatreCaseRef: '44',
          loadRecords: ({int? otScheduleId}) async => const [record],
          loadDeviceLinks: ({required int perfusionRecordId}) async => const [],
          submitSignoff:
              ({
                required int perfusionRecordId,
                required Map<String, dynamic> body,
              }) async {
                calls.add('signoff:$perfusionRecordId');
                signoffBody = body;
                return {
                  'id': 7,
                  'perfusion_record_id': perfusionRecordId,
                  'perfusionist_signed_by':
                      '33333333-3333-4333-8333-333333333333',
                  'surgeon_reviewed_by': body['surgeon_reviewed_by'],
                  'anesthesia_reviewed_by': body['anesthesia_reviewed_by'],
                  'status': 'ready_for_finalize',
                  'finalized_at': null,
                };
              },
          finalizeSignoff: ({required int signoffId}) async {
            calls.add('finalize:$signoffId');
            return {
              'id': signoffId,
              'perfusion_record_id': 12,
              'perfusionist_signed_by': '33333333-3333-4333-8333-333333333333',
              'surgeon_reviewed_by': '44444444-4444-4444-8444-444444444444',
              'anesthesia_reviewed_by': '55555555-5555-4555-8555-555555555555',
              'status': 'finalized',
              'finalized_at': '2026-08-23T05:00:00.000Z',
            };
          },
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('perfusion-record-12')));
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byKey(const ValueKey('perfusion-surgeon-uid')),
      '44444444-4444-4444-8444-444444444444',
    );
    await tester.enterText(
      find.byKey(const ValueKey('perfusion-anesthesia-uid')),
      '55555555-5555-4555-8555-555555555555',
    );

    // Step 1: sign off (separate confirm dialog).
    await tester.tap(find.byKey(const ValueKey('perfusion-signoff')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('perfusion-signoff-confirm')));
    await tester.pumpAndSettle();

    expect(calls, ['signoff:12']);
    expect(
      signoffBody?['surgeon_reviewed_by'],
      '44444444-4444-4444-8444-444444444444',
    );
    expect(
      signoffBody?['anesthesia_reviewed_by'],
      '55555555-5555-4555-8555-555555555555',
    );
    // The client never claims the perfusionist signature itself — the
    // server stamps it from the record/actor.
    expect(signoffBody?.containsKey('perfusionist_signed_by'), isFalse);
    // Refusal copy clears once the sign-off is ready for finalize.
    expect(find.text(serverFinalizeRefusal), findsNothing);

    // Step 2: finalize (its own confirm dialog, never collapsed into step 1).
    await tester.tap(find.byKey(const ValueKey('perfusion-finalize')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('perfusion-finalize-confirm')));
    await tester.pumpAndSettle();

    expect(calls, ['signoff:12', 'finalize:7']);

    // Post-finalize the record is read-only.
    expect(
      find.byKey(const ValueKey('perfusion-finalized-banner')),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('perfusion-signoff')), findsNothing);
    expect(find.byKey(const ValueKey('perfusion-finalize')), findsNothing);
    final addLink = tester.widget<FilledButton>(
      find.byKey(const ValueKey('perfusion-add-device-link')),
    );
    expect(addLink.onPressed, isNull);
  });

  testWidgets('finalize is blocked before signoff with the server refusal '
      'verbatim', (tester) async {
    useTallSurface(tester);
    var finalizeCalls = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: PerfusionRecordScreen(
          theatreCaseRef: '44',
          loadRecords: ({int? otScheduleId}) async => const [record],
          loadDeviceLinks: ({required int perfusionRecordId}) async => const [],
          finalizeSignoff: ({required int signoffId}) async {
            finalizeCalls += 1;
            return const {};
          },
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('perfusion-record-12')));
    await tester.pumpAndSettle();

    // The server refusal is mirrored verbatim while no sign-off exists.
    expect(find.text(serverFinalizeRefusal), findsOneWidget);

    final finalize = tester.widget<FilledButton>(
      find.byKey(const ValueKey('perfusion-finalize')),
    );
    expect(finalize.onPressed, isNull);

    await tester.tap(
      find.byKey(const ValueKey('perfusion-finalize')),
      warnIfMissed: false,
    );
    await tester.pumpAndSettle();

    expect(finalizeCalls, 0);
    expect(
      find.byKey(const ValueKey('perfusion-finalize-confirm')),
      findsNothing,
    );
  });
}
