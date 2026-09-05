import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/services/realtime_client.dart';
import 'package:vhhealth_staff/core/config/staff_role_contract.g.dart';
import 'package:vhhealth_staff/core/services/stemi_pathway_api_service.dart';
import 'package:vhhealth_staff/features/cath_lab/screens/cath_lab_screen.dart';
import 'package:vhhealth_staff/features/cath_lab/models/cath_consumable_models.dart';
import 'package:vhhealth_staff/features/cath_lab/models/cath_report_models.dart';
import 'package:vhhealth_staff/features/cath_lab/services/cath_lab_api_service.dart';
import 'package:vhhealth_staff/features/cath_lab/widgets/cath_case_reports_panel.dart';

void main() {
  test('consumable capture role gate matches the backend workflow gate', () {
    for (final rawRole in canonicalStaffRoleCodes) {
      expect(
        cathConsumablesCanAddForRole(rawRole),
        canonicalCathLabWorkflowRoleCodes.contains(rawRole),
        reason: rawRole,
      );
    }
    expect(cathConsumablesCanAddForRole('CATHLAB_STAFF'), isTrue);
    expect(cathConsumablesCanAddForCaseStatus('scheduled'), isFalse);
    expect(cathConsumablesCanAddForCaseStatus('readiness_pending'), isFalse);
    expect(cathConsumablesCanAddForCaseStatus('ready'), isTrue);
    expect(cathConsumablesCanAddForCaseStatus('in_progress'), isTrue);
    expect(cathConsumablesCanAddForCaseStatus('completed'), isTrue);
    expect(cathConsumablesCanAddForCaseStatus('cancelled'), isTrue);
  });

  test('CathLabCaseSummary parses backend counters defensively', () {
    final parsed = CathLabCaseSummary.fromJson({
      'id': '42',
      'patient_uid': '11111111-1111-4111-8111-111111111111',
      'patient_name': 'Asha Rao',
      'requested_procedure': 'Primary PCI',
      'status': 'ready',
      'urgency': 'emergency',
      'lab_room': 'CL-1',
      'planned_start_at': '2026-07-09T08:30:00.000Z',
      'readiness_total': '8',
      'readiness_cleared': 8,
      'procedure_count': '1',
      'dose_record_count': 1,
      'active_post_order_count': '2',
      'device_link_count': 1,
      'signed_report_count': '1',
      'report_tat_minutes': '24',
    });

    expect(parsed.id, 42);
    expect(parsed.patientName, 'Asha Rao');
    expect(parsed.readinessComplete, isTrue);
    expect(parsed.procedureCount, 1);
    expect(parsed.activePostOrderCount, 2);
    expect(parsed.signedReportCount, 1);
    expect(parsed.reportTatMinutes, 24);
    // The case LIST carries no reuse decoration: absent must stay null, which
    // is a different fact from a resolved `unknown` serology status.
    expect(parsed.reuseRestriction, isNull);

    final decorated = CathLabCaseSummary.fromJson({
      'id': 42,
      'reuse_restriction': {
        'status': 'restricted',
        'reasons': ['HBsAg reactive 2026-08-12'],
        'validity_days': 90,
      },
    });
    expect(decorated.reuseRestriction!.isRestricted, isTrue);
    expect(decorated.reuseRestriction!.reasons, ['HBsAg reactive 2026-08-12']);
  });

  test(
    'StemiActivationSummary parses clocks, Cath case, and team ack rows',
    () {
      final parsed = StemiActivationSummary.fromJson({
        'id': '77',
        'patient_uid': '11111111-1111-4111-8111-111111111111',
        'cath_case_id': '42',
        'activation_source': 'clinician',
        'status': 'lab_notified',
        'activated_at': '2026-07-11T10:00:00.000Z',
        'metadata': {'targets_pending': true},
        'sla_instances': [
          {
            'rule_code': 'stemi_door_to_ecg',
            'status': 'completed',
            'started_at': '2026-07-11T10:00:00.000Z',
            'completed_at': '2026-07-11T10:05:00.000Z',
          },
          {
            'rule_code': 'stemi_door_to_lab',
            'status': 'active',
            'metadata': {'clock_start_pending': true},
          },
          {
            'rule_code': 'stemi_door_to_balloon',
            'status': 'active',
            'metadata': {'targets_pending': true},
          },
        ],
        'team_acknowledgements': [
          {
            'id': '8',
            'activation_id': 77,
            'staff_uid': 'staff-1',
            'role_code': 'CATH_LAB_STAFF',
            'notification_status': 'notified',
          },
        ],
      });

      expect(parsed.id, 77);
      expect(parsed.cathLabCaseId, 42);
      expect(parsed.targetsPending, isTrue);
      expect(parsed.slaFor('stemi_door_to_lab')!.clockStartPending, isTrue);
      expect(
        parsed
            .slaFor('stemi_door_to_ecg')!
            .elapsedAt(DateTime.utc(2026, 7, 11, 10, 10)),
        const Duration(minutes: 5),
      );
      expect(parsed.acknowledgementFor('STAFF-1')!.isAcknowledged, isFalse);
    },
  );

  test('STEMI payload rejects a successful malformed envelope', () {
    expect(
      () => parseStemiActivationPayload({'count': 0}),
      throwsA(isA<StemiPathwayApiException>()),
    );
  });

  test('STEMI payload rejects missing, duplicate, and extra clocks', () {
    for (final ruleCodes in <List<String>>[
      ['stemi_door_to_ecg', 'stemi_door_to_balloon'],
      [
        'stemi_door_to_ecg',
        'stemi_door_to_lab',
        'stemi_door_to_balloon',
        'stemi_door_to_balloon',
      ],
      [
        'stemi_door_to_ecg',
        'stemi_door_to_lab',
        'stemi_door_to_balloon',
        'owner_defined_clock',
      ],
    ]) {
      expect(
        () => parseStemiActivationPayload(_stemiPayload(ruleCodes)),
        throwsA(isA<StemiPathwayApiException>()),
      );
    }
  });

  testWidgets('cath-lab screen renders the case worklist and stage tabs', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: CathLabScreen(
          currentStaffUid: 'staff-1',
          loadStemiActivations: () async => const [],
          realtimeEvents: (_) => const Stream<RealtimeEvent>.empty(),
          loadCases: (_) async => [
            const CathLabCaseSummary(
              id: 42,
              patientUid: '11111111-1111-4111-8111-111111111111',
              patientName: 'Asha Rao',
              requestedProcedure: 'Primary PCI',
              status: 'ready',
              urgency: 'emergency',
              labRoom: 'CL-1',
              plannedStartAt: null,
              readinessTotal: 8,
              readinessCleared: 8,
              procedureCount: 1,
              doseRecordCount: 1,
              activePostOrderCount: 2,
              deviceLinkCount: 1,
            ),
          ],
        ),
      ),
    );
    await tester.pump();

    expect(find.text('Cath Lab'), findsOneWidget);
    expect(find.text('Primary PCI'), findsOneWidget);
    expect(find.text('Asha Rao'), findsOneWidget);
    expect(find.text('Emergency'), findsOneWidget);

    await tester.tap(find.text('Readiness'));
    await tester.pumpAndSettle();
    expect(find.text('Ready for procedure'), findsOneWidget);
    expect(find.text('8/8 checks clear'), findsOneWidget);

    await tester.tap(find.text('Procedure'));
    await tester.pumpAndSettle();
    expect(find.text('1 logs'), findsOneWidget);
    expect(find.text('1 device links'), findsOneWidget);

    await tester.tap(find.text('Post-orders'));
    await tester.pumpAndSettle();
    expect(find.text('2 active orders'), findsOneWidget);
  });

  testWidgets('case header carries the blood-borne restriction strip', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: CathLabScreen(
          currentStaffUid: 'staff-1',
          loadStemiActivations: () async => const [],
          realtimeEvents: (_) => const Stream<RealtimeEvent>.empty(),
          loadCases: (_) async => [
            const CathLabCaseSummary(
              id: 42,
              patientUid: '11111111-1111-4111-8111-111111111111',
              patientName: 'Asha Rao',
              requestedProcedure: 'Primary PCI',
              status: 'ready',
              urgency: 'emergency',
              labRoom: 'CL-1',
              plannedStartAt: null,
              readinessTotal: 8,
              readinessCleared: 8,
              procedureCount: 1,
              doseRecordCount: 1,
              activePostOrderCount: 2,
              deviceLinkCount: 1,
              reuseRestriction: CathReuseRestriction(
                status: 'restricted',
                reasons: ['HBsAg reactive 2026-08-12'],
                validityDays: 90,
              ),
            ),
          ],
        ),
      ),
    );
    await tester.pump();

    await tester.tap(find.text('Readiness'));
    await tester.pumpAndSettle();

    expect(
      find.byKey(const ValueKey('cath-case-reuse-restriction-42')),
      findsOneWidget,
    );
    expect(
      find.text('Devices used in this case will be discarded, not reprocessed'),
      findsOneWidget,
    );
    expect(find.text('HBsAg reactive 2026-08-12'), findsOneWidget);
  });

  testWidgets('a case with no reuse decoration shows no restriction strip', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: CathLabScreen(
          currentStaffUid: 'staff-1',
          loadStemiActivations: () async => const [],
          realtimeEvents: (_) => const Stream<RealtimeEvent>.empty(),
          loadCases: (_) async => [
            const CathLabCaseSummary(
              id: 42,
              patientUid: '11111111-1111-4111-8111-111111111111',
              patientName: 'Asha Rao',
              requestedProcedure: 'Primary PCI',
              status: 'ready',
              urgency: 'emergency',
              labRoom: 'CL-1',
              plannedStartAt: null,
              readinessTotal: 8,
              readinessCleared: 8,
              procedureCount: 1,
              doseRecordCount: 1,
              activePostOrderCount: 2,
              deviceLinkCount: 1,
            ),
          ],
        ),
      ),
    );
    await tester.pump();

    await tester.tap(find.text('Readiness'));
    await tester.pumpAndSettle();

    expect(
      find.byKey(const ValueKey('cath-case-reuse-restriction-42')),
      findsNothing,
    );
  });

  testWidgets('cath-lab screen shows an empty state for a selected day', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: CathLabScreen(
          currentStaffUid: 'staff-1',
          loadCases: (_) async => const [],
          loadStemiActivations: () async => const [],
          realtimeEvents: (_) => const Stream<RealtimeEvent>.empty(),
        ),
      ),
    );
    await tester.pump();

    expect(find.text('No Cath Lab cases'), findsOneWidget);
  });

  testWidgets('incoming STEMI card shows clocks and durable ack roster', (
    tester,
  ) async {
    final releaseAck = Completer<void>();
    var acknowledgeCalls = 0;
    var acknowledged = false;

    await tester.pumpWidget(
      MaterialApp(
        home: CathLabScreen(
          currentStaffUid: 'staff-1',
          now: () => DateTime.utc(2026, 7, 11, 10, 10, 30),
          loadCases: (_) async => const [],
          loadStemiActivations: () async => [
            _stemiActivation(acknowledged: acknowledged),
          ],
          acknowledgeStemiActivation: (_) async {
            acknowledgeCalls += 1;
            await releaseAck.future;
            acknowledged = true;
          },
          realtimeEvents: (_) => const Stream<RealtimeEvent>.empty(),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();

    expect(find.text('Incoming Code STEMI activations'), findsOneWidget);
    expect(find.text('Door-to-ECG'), findsOneWidget);
    expect(find.text('Door-to-lab'), findsOneWidget);
    expect(find.text('Door-to-balloon'), findsOneWidget);
    expect(find.text('00:05:00'), findsOneWidget);
    expect(find.text('00:10:30'), findsNWidgets(2));
    expect(find.text('Targets pending'), findsNWidgets(2));
    expect(find.textContaining('Cath Lab Staff'), findsOneWidget);
    expect(find.textContaining('Cath Lab Incharge'), findsOneWidget);
    expect(find.text('Pending'), findsNWidgets(2));

    final acknowledge = find.byKey(const ValueKey('stemi-ack-77'));
    await tester.ensureVisible(acknowledge);
    await tester.tap(acknowledge);
    await tester.pump();
    await tester.tap(acknowledge, warnIfMissed: false);
    await tester.pump();
    expect(acknowledgeCalls, 1);

    releaseAck.complete();
    await tester.pump();
    await tester.pump();

    expect(find.text('Acknowledged'), findsOneWidget);
    expect(find.byKey(const ValueKey('stemi-ack-77')), findsNothing);
  });

  testWidgets('prehospital STEMI clocks wait for door time without running', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: CathLabScreen(
          currentStaffUid: 'staff-1',
          now: () => DateTime.utc(2026, 7, 11, 10, 10, 30),
          loadCases: (_) async => const [],
          loadStemiActivations: () async => [
            _stemiActivation(acknowledged: false, clockStartPending: true),
          ],
          realtimeEvents: (_) => const Stream<RealtimeEvent>.empty(),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();

    expect(find.text('Door time pending'), findsNWidgets(3));
    expect(find.text('--:--:--'), findsNWidgets(3));

    await tester.pump(const Duration(seconds: 2));

    expect(find.text('Door time pending'), findsNWidgets(3));
    expect(find.text('--:--:--'), findsNWidgets(3));
  });

  testWidgets(
    'failed ACK hydration keeps cards visibly stale and reports the saved ACK',
    (tester) async {
      var loads = 0;
      var acknowledgeCalls = 0;
      await tester.pumpWidget(
        MaterialApp(
          home: CathLabScreen(
            currentStaffUid: 'staff-1',
            loadCases: (_) async => const [],
            loadStemiActivations: () async {
              loads += 1;
              if (loads == 1) {
                return [_stemiActivation(acknowledged: false)];
              }
              throw Exception('synthetic refresh failure');
            },
            acknowledgeStemiActivation: (_) async {
              acknowledgeCalls += 1;
            },
            realtimeEvents: (_) => const Stream<RealtimeEvent>.empty(),
          ),
        ),
      );
      await tester.pump();
      await tester.pump();

      final acknowledge = find.byKey(const ValueKey('stemi-ack-77'));
      final scheduleList = find.ancestor(
        of: acknowledge,
        matching: find.byType(ListView),
      );
      await tester.drag(scheduleList.first, const Offset(0, -80));
      await tester.pump(const Duration(milliseconds: 300));
      await tester.tap(acknowledge);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(acknowledgeCalls, 1);
      expect(
        find.text('Activation data may be out of date. Refresh failed'),
        findsOneWidget,
      );
      expect(
        find.text(
          'Acknowledgement saved, but activation status could not be refreshed',
        ),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('stemi-activation-77')), findsOneWidget);
    },
  );

  testWidgets('reports tab expands a case-level report list', (tester) async {
    const cathCase = CathLabCaseSummary(
      id: 42,
      patientUid: '11111111-1111-4111-8111-111111111111',
      patientName: 'Asha Rao',
      requestedProcedure: 'Primary PCI',
      status: 'completed',
      urgency: 'emergency',
      labRoom: 'CL-1',
      plannedStartAt: null,
      readinessTotal: 8,
      readinessCleared: 8,
      procedureCount: 1,
      doseRecordCount: 1,
      activePostOrderCount: 0,
      deviceLinkCount: 1,
    );
    await tester.pumpWidget(
      MaterialApp(
        home: CathLabScreen(
          loadCases: (_) async => const [cathCase],
          loadRole: () async => 'DOCTOR',
          // The merged workbench also boots the STEMI strip; inject inert
          // sources so this test exercises only the reports surface. The
          // 1s clock ticker makes pumpAndSettle time out — use discrete
          // pumps like the STEMI tests above.
          currentStaffUid: 'staff-1',
          loadStemiActivations: () async => const [],
          realtimeEvents: (_) => const Stream<RealtimeEvent>.empty(),
          reportDependencies: CathReportDependencies(
            loadReports: (_) async => const [
              CathProcedureReport(
                id: 91,
                caseId: 42,
                patientUid: '11111111-1111-4111-8111-111111111111',
                reportType: 'ptca',
                status: 'preliminary',
                narrativeSections: {'findings': 'Successful PCI to LAD'},
                codedFields: {'stent_count': 1},
              ),
            ],
            loadViewerLink: (_) async =>
                const CathViewerLink(status: 'pacs_not_configured'),
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();

    await tester.ensureVisible(find.text('Reports'));
    await tester.tap(find.text('Reports'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 350));
    await tester.tap(find.byKey(const ValueKey('cath-report-expand-42')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 350));

    expect(find.text('Preliminary'), findsOneWidget);
    expect(find.text('Successful PCI to LAD'), findsOneWidget);
  });
}

StemiActivationSummary _stemiActivation({
  required bool acknowledged,
  bool clockStartPending = false,
}) {
  final startedAt = DateTime.utc(2026, 7, 11, 10);
  return StemiActivationSummary(
    id: 77,
    patientUid: '11111111-1111-4111-8111-111111111111',
    patientName: 'Asha Rao',
    emergencyVisitId: 14,
    cathLabCaseId: 42,
    activationSource: 'clinician',
    status: 'lab_notified',
    activatedAt: startedAt,
    targetsPending: false,
    slaInstances: [
      StemiSlaClock(
        ruleCode: 'stemi_door_to_ecg',
        status: 'completed',
        startedAt: clockStartPending ? null : startedAt,
        dueAt: null,
        completedAt: clockStartPending
            ? null
            : startedAt.add(const Duration(minutes: 5)),
        breachedAt: null,
        targetsPending: false,
        clockStartPending: clockStartPending,
      ),
      StemiSlaClock(
        ruleCode: 'stemi_door_to_lab',
        status: 'active',
        startedAt: clockStartPending ? null : startedAt,
        dueAt: null,
        completedAt: null,
        breachedAt: null,
        targetsPending: !clockStartPending,
        clockStartPending: clockStartPending,
      ),
      StemiSlaClock(
        ruleCode: 'stemi_door_to_balloon',
        status: 'active',
        startedAt: clockStartPending ? null : startedAt,
        dueAt: null,
        completedAt: null,
        breachedAt: null,
        targetsPending: !clockStartPending,
        clockStartPending: clockStartPending,
      ),
    ],
    teamAcknowledgements: [
      StemiTeamAcknowledgement(
        id: '8',
        activationId: 77,
        staffUid: 'staff-1',
        staffName: '',
        roleCode: 'CATH_LAB_STAFF',
        notificationStatus: acknowledged ? 'acknowledged' : 'notified',
        notifiedAt: startedAt,
        acknowledgedAt: acknowledged
            ? startedAt.add(const Duration(minutes: 2))
            : null,
      ),
      StemiTeamAcknowledgement(
        id: '9',
        activationId: 77,
        staffUid: 'staff-2',
        staffName: '',
        roleCode: 'CATH_LAB_INCHARGE',
        notificationStatus: 'notified',
        notifiedAt: startedAt,
        acknowledgedAt: null,
      ),
    ],
  );
}

Map<String, dynamic> _stemiPayload(List<String> ruleCodes) {
  return {
    'activations': [
      {
        'id': 77,
        'patient_uid': '11111111-1111-4111-8111-111111111111',
        'activation_source': 'clinician',
        'status': 'lab_notified',
        'activated_at': '2026-07-11T10:00:00.000Z',
        'sla_instances': [
          for (final ruleCode in ruleCodes)
            {'rule_code': ruleCode, 'status': 'active'},
        ],
        'team_acknowledgements': const [],
      },
    ],
  };
}
