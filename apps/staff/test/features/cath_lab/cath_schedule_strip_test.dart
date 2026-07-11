import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/cath_lab/services/cath_lab_api_service.dart';
import 'package:vhhealth_staff/features/cath_lab/widgets/cath_schedule_strip.dart';

CathScheduleStrip _strip({
  List<CathScheduleBooking> bookings = const [],
  List<CathScheduleEmergency> emergencies = const [],
  bool hasSoftConflict = false,
}) {
  return CathScheduleStrip(
    date: '2026-08-03',
    bookings: bookings,
    emergencies: emergencies,
    hasSoftConflict: hasSoftConflict,
  );
}

CathScheduleBooking _booking({bool softConflict = false}) {
  return CathScheduleBooking(
    linkId: 1,
    caseId: 42,
    resourceName: 'Cath Room 1',
    patientName: 'Asha Rao',
    requestedProcedure: 'Elective PCI',
    caseStatus: 'scheduled',
    urgency: 'elective',
    softConflict: softConflict,
    conflictingEmergencyCaseIds: softConflict ? const [77] : const [],
    startsAt: DateTime.utc(2026, 8, 3, 4, 30),
    endsAt: DateTime.utc(2026, 8, 3, 5, 30),
  );
}

Future<void> _pump(
  WidgetTester tester,
  Future<CathScheduleStrip> Function(DateTime) loader,
) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: CathScheduleStripSection(
          date: DateTime(2026, 8, 3),
          loadStrip: loader,
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  test('CathScheduleStrip parses the backend payload defensively', () {
    final parsed = CathScheduleStrip.fromJson({
      'date': '2026-08-03',
      'has_soft_conflict': true,
      'bookings': [
        {
          'link_id': '9',
          'case_id': '42',
          'resource_name': 'Cath Room 1',
          'patient_name': 'Asha Rao',
          'requested_procedure': 'Elective PCI',
          'case_status': 'scheduled',
          'urgency': 'elective',
          'soft_conflict': true,
          'conflicting_emergency_case_ids': ['77', 78],
          'starts_at': '2026-08-03T04:30:00.000Z',
          'ends_at': '2026-08-03T05:30:00.000Z',
        },
      ],
      'emergencies': [
        {
          'id': 77,
          'status': 'in_progress',
          'requested_procedure': 'Primary PCI',
          'patient_name': 'Ravi K',
          'actual_start_at': '2026-08-03T05:00:00.000Z',
        },
      ],
    });

    expect(parsed.hasSoftConflict, isTrue);
    expect(parsed.bookings, hasLength(1));
    expect(parsed.bookings.first.linkId, 9);
    expect(parsed.bookings.first.softConflict, isTrue);
    expect(parsed.bookings.first.conflictingEmergencyCaseIds, [77, 78]);
    expect(parsed.emergencies, hasLength(1));
    expect(parsed.emergencies.first.caseId, 77);
  });

  testWidgets('renders booked slots with room and patient context', (
    tester,
  ) async {
    await _pump(tester, (_) async => _strip(bookings: [_booking()]));

    expect(find.text('Room schedule'), findsOneWidget);
    expect(find.text('Cath Room 1'), findsOneWidget);
    expect(find.text('Asha Rao · Elective PCI'), findsOneWidget);
    expect(find.byIcon(Icons.warning_amber_rounded), findsNothing);
  });

  testWidgets('flags soft conflicts and surfaces the emergency banner', (
    tester,
  ) async {
    await _pump(
      tester,
      (_) async => _strip(
        bookings: [_booking(softConflict: true)],
        emergencies: [
          CathScheduleEmergency(
            caseId: 77,
            status: 'in_progress',
            requestedProcedure: 'Primary PCI',
            patientName: 'Ravi K',
            startedAt: DateTime.utc(2026, 8, 3, 5, 0),
          ),
        ],
        hasSoftConflict: true,
      ),
    );

    expect(
      find.text('Emergency case in progress — booked slots may shift'),
      findsOneWidget,
    );
    // Header badge + per-booking badge both warn, and the booking row stays.
    expect(find.byIcon(Icons.warning_amber_rounded), findsNWidgets(2));
    expect(find.text('Cath Room 1'), findsOneWidget);
    expect(find.textContaining('Primary PCI'), findsOneWidget);
  });

  testWidgets('shows the empty state when nothing is booked', (tester) async {
    await _pump(tester, (_) async => _strip());
    expect(find.text('No room bookings for this date'), findsOneWidget);
  });

  testWidgets('shows the failure state and retries on demand', (tester) async {
    var calls = 0;
    await _pump(tester, (_) async {
      calls += 1;
      if (calls == 1) throw Exception('offline');
      return _strip(bookings: [_booking()]);
    });

    expect(find.text("Couldn't load the room schedule"), findsOneWidget);
    await tester.tap(find.text('Refresh'));
    await tester.pumpAndSettle();
    expect(find.text('Cath Room 1'), findsOneWidget);
    expect(calls, 2);
  });
}
