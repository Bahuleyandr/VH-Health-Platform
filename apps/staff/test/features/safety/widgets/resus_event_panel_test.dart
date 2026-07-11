import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/safety/widgets/resus_event_panel.dart';

Map<String, dynamic> _detail({
  String status = 'active',
  String? teamLeaderUid,
  String? recorderUid,
  List<Map<String, dynamic>> roles = const [],
}) {
  return {
    'event': {
      'id': 7,
      'event_kind': 'code_blue',
      'trigger_source': 'critical_vital',
      'status': status,
      'ward_snapshot': 'ICU-A',
      'bed_snapshot': 'B12',
      'reason': 'SpO2 62%',
      'is_drill': false,
      'started_at': '2026-07-09T11:00:00.000Z',
      'ended_at': status == 'active' ? null : '2026-07-09T11:25:00.000Z',
      'outcome': status == 'active' ? null : 'rosc',
      'team_leader_uid': teamLeaderUid,
      'recorder_uid': recorderUid,
    },
    'timeline': [
      {
        'seq': 1,
        'entry_type': 'compressions_started',
        'occurred_at': '2026-07-09T11:00:30.000Z',
      },
      {
        'seq': 2,
        'entry_type': 'shock',
        'occurred_at': '2026-07-09T11:02:00.000Z',
        'rhythm': 'vf',
        'energy_joules': 200,
      },
      {
        'seq': 3,
        'entry_type': 'medication',
        'occurred_at': '2026-07-09T11:03:00.000Z',
        'medication_name': 'Adrenaline',
        'dose': '1 mg',
        'route': 'IV',
      },
    ],
    'team_roles': roles,
    'medication_links': const [],
    'device_links': const [],
    'qa_review': null,
  };
}

Widget _wrap(Widget child) {
  return MaterialApp(
    home: Scaffold(body: SingleChildScrollView(child: child)),
  );
}

void main() {
  testWidgets('renders persisted event header with ward/bed/reason snapshot', (
    tester,
  ) async {
    await tester.pumpWidget(_wrap(ResusEventPanel(detail: _detail())));

    expect(find.text('Code blue'), findsOneWidget);
    expect(find.textContaining('ICU-A'), findsOneWidget);
    expect(find.textContaining('B12'), findsOneWidget);
    expect(find.textContaining('SpO2 62%'), findsOneWidget);
    expect(find.text('Active'), findsOneWidget);
  });

  testWidgets('renders ordered timeline with shock energy and medication', (
    tester,
  ) async {
    await tester.pumpWidget(_wrap(ResusEventPanel(detail: _detail())));

    expect(find.text('#1'), findsOneWidget);
    expect(find.text('#2'), findsOneWidget);
    expect(find.text('#3'), findsOneWidget);
    expect(find.text('Compressions started'), findsOneWidget);
    expect(find.text('Shock (defibrillation)'), findsOneWidget);
    expect(find.textContaining('200 J'), findsOneWidget);
    expect(find.textContaining('Adrenaline'), findsOneWidget);
  });

  testWidgets(
    'shows finalize gate hint when ended without leader and recorder',
    (tester) async {
      await tester.pumpWidget(
        _wrap(ResusEventPanel(detail: _detail(status: 'ended'))),
      );

      expect(
        find.text('Finalization needs a documented team leader and recorder.'),
        findsOneWidget,
      );
    },
  );

  testWidgets('hides finalize gate hint when leader and recorder recorded', (
    tester,
  ) async {
    await tester.pumpWidget(
      _wrap(
        ResusEventPanel(
          detail: _detail(
            status: 'ended',
            teamLeaderUid: 'uid-1',
            recorderUid: 'uid-2',
            roles: [
              {
                'role': 'team_leader',
                'staff_name': 'Dr. Lead',
                'signed_at': '2026-07-09T11:30:00.000Z',
              },
              {
                'role': 'recorder',
                'staff_name': 'Nurse Rec',
                'signed_at': null,
              },
            ],
          ),
        ),
      ),
    );

    expect(
      find.text('Finalization needs a documented team leader and recorder.'),
      findsNothing,
    );
    expect(find.textContaining('Dr. Lead'), findsOneWidget);
    expect(find.text('Signed'), findsOneWidget);
    expect(find.text('Not signed'), findsOneWidget);
  });
}
