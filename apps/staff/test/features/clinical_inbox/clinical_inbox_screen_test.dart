import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_staff/core/providers/clinical_inbox_provider.dart';
import 'package:vhhealth_staff/core/services/clinical_inbox_api_service.dart';
import 'package:vhhealth_staff/core/widgets/mar_medication_exception_handoff_sheet.dart';
import 'package:vhhealth_staff/core/widgets/message_unread_badge.dart';
import 'package:vhhealth_staff/features/clinical_inbox/screens/clinical_inbox_screen.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

void main() {
  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
    VHHttpClient.resetClientForTesting();
  });

  tearDown(VHHttpClient.resetClientForTesting);

  testWidgets('clinical inbox renders grouped tasks', (tester) async {
    final api = _FakeClinicalInboxApi(tasks: [_task(id: '1')]);
    final provider = ClinicalInboxProvider(api: api);

    await tester.pumpWidget(_host(provider));
    await tester.pump();
    await tester.pump();

    expect(find.text('Clinical Inbox'), findsOneWidget);
    expect(find.text('Critical'), findsOneWidget);
    expect(find.text('Critical lab: Potassium'), findsOneWidget);
    expect(find.textContaining('patient-1'), findsOneWidget);
  });

  testWidgets(
    'late-critical recovery is acknowledgement-required without a fresh alarm or SLA',
    (tester) async {
      final api = _FakeClinicalInboxApi(
        tasks: [_task(id: '81', recoveredCriticalAwareness: true)],
      );
      final provider = ClinicalInboxProvider(api: api);

      await tester.pumpWidget(_host(provider));
      await tester.pumpAndSettle();

      expect(
        find.text('Recovered critical result — acknowledgement required'),
        findsOneWidget,
      );
      expect(
        find.text(
          'Continuity awareness only — not a fresh alarm or SLA breach.',
        ),
        findsOneWidget,
      );
      expect(find.text('Acknowledge recovered result'), findsOneWidget);
      expect(find.text('Acknowledge critical result'), findsNothing);

      await tester.tap(find.text('Acknowledge recovered result'));
      await tester.pumpAndSettle();
      expect(api.acknowledgeCalls, 1);
      expect(find.text('Acknowledged'), findsWidgets);
    },
  );

  testWidgets('acknowledge button fires once while pending', (tester) async {
    final releaseAck = Completer<void>();
    final api = _FakeClinicalInboxApi(
      tasks: [_task(id: '1')],
      acknowledgeDelay: releaseAck.future,
    );
    final provider = ClinicalInboxProvider(api: api);

    await tester.pumpWidget(_host(provider));
    await tester.pump();
    await tester.pump();

    final acknowledge = find.byType(FilledButton).first;
    await tester.tap(acknowledge);
    await tester.pump();
    await tester.tap(acknowledge, warnIfMissed: false);
    await tester.pump();

    expect(api.acknowledgeCalls, 1);
    releaseAck.complete();
    await tester.pumpAndSettle();
    expect(find.text('Acknowledged'), findsWidgets);
  });

  test('provider pending count updates after acknowledgement', () async {
    final api = _FakeClinicalInboxApi(
      tasks: [
        _task(id: '1'),
        _task(id: '2'),
      ],
    );
    final provider = ClinicalInboxProvider(api: api);

    await provider.refresh();
    expect(provider.pendingCount, 2);

    await provider.acknowledge('1');
    expect(provider.pendingCount, 1);
    expect(api.acknowledgeCalls, 1);
  });

  test(
    'provider claims an exact MAR role-queue task before navigation',
    () async {
      final task = _task(
        id: '83',
        taskKind: 'review',
        semantics: 'domain_evidence',
        assignedToRole: 'DOCTOR',
        relatedResourceType: 'mar_medication_exception_cases',
        relatedResourceId: '73',
        metadata: const {
          'task_contract': 'mar_medication_exception_v1',
          'exception_case_id': 73,
          'medication_administration_id': 42,
          'exception_kind': 'missed',
          'sla_key': 'mar_medication_exception_review',
        },
      );
      final api = _FakeClinicalInboxApi(tasks: [task]);
      final provider = ClinicalInboxProvider(api: api);
      await provider.refresh();

      final claimed = await provider.claimMarMedicationException(task);

      expect(api.marExceptionClaimCalls, 1);
      expect(api.marExceptionClaimCaseIds, ['73']);
      expect(api.marExceptionClaimIdempotencyKeys.single, isNotEmpty);
      expect(claimed.assignedToUid, 'doctor-1');
      expect(claimed.assignedToRole, isEmpty);
    },
  );

  testWidgets('admin sees and completes exact MAR named-prescriber handoff', (
    tester,
  ) async {
    FlutterSecureStorage.setMockInitialValues({'staff_role': 'ADMIN'});
    final task = _marExceptionTask();
    final api = _FakeClinicalInboxApi(tasks: [task]);
    final provider = ClinicalInboxProvider(api: api);

    await tester.pumpWidget(
      _host(
        provider,
        loadActivePrescribers: () async => const [
          MarPrescriberOption(
            uid: '22222222-2222-4222-8222-222222222222',
            name: 'Dr Target',
            role: 'CONSULTANT',
          ),
        ],
      ),
    );
    await tester.pumpAndSettle();

    final action = find.byKey(const Key('mar-exception-handoff-84'));
    expect(action, findsOneWidget);
    expect(find.text('Reassign prescriber'), findsOneWidget);
    await tester.tap(action);
    await tester.pumpAndSettle();

    await tester.tap(find.byType(DropdownButtonFormField<String>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Dr Target (CONSULTANT)').last);
    await tester.enterText(
      find.byKey(const Key('mar-handoff-reason')),
      'On-call ownership changed.',
    );
    await tester.tap(find.byKey(const Key('mar-handoff-confirmation')));
    await _tapVisible(tester, find.byKey(const Key('mar-handoff-submit')));
    await tester.pumpAndSettle();

    expect(api.marExceptionHandoffCalls, 1);
    expect(
      api.lastMarExceptionExpectedPrescriberUid,
      '11111111-1111-4111-8111-111111111111',
    );
    expect(
      api.lastMarExceptionTargetPrescriberUid,
      '22222222-2222-4222-8222-222222222222',
    );
    expect(api.lastMarExceptionHandoffReason, 'On-call ownership changed.');
    expect(api.marExceptionHandoffIdempotencyKeys.single, isNotEmpty);
    expect(
      find.text('Medication exception reassigned to the selected prescriber.'),
      findsOneWidget,
    );
  });

  testWidgets('prescriber cannot see the admin handoff action', (tester) async {
    FlutterSecureStorage.setMockInitialValues({'staff_role': 'DOCTOR'});
    final provider = ClinicalInboxProvider(
      api: _FakeClinicalInboxApi(tasks: [_marExceptionTask()]),
    );

    await tester.pumpWidget(
      _host(provider, loadActivePrescribers: () async => const []),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('mar-exception-handoff-84')), findsNothing);
    expect(find.text('Reassign prescriber'), findsNothing);
  });

  testWidgets(
    'stale MAR owner refreshes binding and requires confirmation again',
    (tester) async {
      FlutterSecureStorage.setMockInitialValues({'staff_role': 'SUPER_ADMIN'});
      final initial = _marExceptionTask();
      final refreshed = _marExceptionTask(
        assignedToUid: '33333333-3333-4333-8333-333333333333',
      );
      final api = _FakeClinicalInboxApi(
        tasks: [initial],
        marExceptionHandoffFailure:
            const MarMedicationExceptionHandoffException(
              message: 'Medication exception owner changed',
              statusCode: 409,
              code: 'MAR_EXCEPTION_ASSIGNMENT_CONFLICT',
            ),
        tasksAfterMarExceptionHandoffFailure: [refreshed],
      );
      final provider = ClinicalInboxProvider(api: api);
      final prescribers = const [
        MarPrescriberOption(
          uid: '22222222-2222-4222-8222-222222222222',
          name: 'Dr Target',
          role: 'CONSULTANT',
        ),
        MarPrescriberOption(
          uid: '33333333-3333-4333-8333-333333333333',
          name: 'Dr Concurrent Owner',
          role: 'DUTY_DOCTOR',
        ),
      ];

      await tester.pumpWidget(
        _host(provider, loadActivePrescribers: () async => prescribers),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('mar-exception-handoff-84')));
      await tester.pumpAndSettle();
      await tester.tap(find.byType(DropdownButtonFormField<String>));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Dr Target (CONSULTANT)').last);
      await tester.enterText(
        find.byKey(const Key('mar-handoff-reason')),
        'Coverage changed during the shift.',
      );
      await tester.tap(find.byKey(const Key('mar-handoff-confirmation')));
      await _tapVisible(tester, find.byKey(const Key('mar-handoff-submit')));
      await tester.pumpAndSettle();

      expect(api.marExceptionHandoffCalls, 1);
      expect(
        find.text(
          'Ownership changed while you were reviewing this task. The latest owner is shown; review and confirm again.',
        ),
        findsOneWidget,
      );
      expect(find.text('33333333-3333-4333-8333-333333333333'), findsOneWidget);
      expect(
        tester
            .widget<CheckboxListTile>(
              find.byKey(const Key('mar-handoff-confirmation')),
            )
            .value,
        isFalse,
      );

      await tester.tap(find.byKey(const Key('mar-handoff-confirmation')));
      await _tapVisible(tester, find.byKey(const Key('mar-handoff-submit')));
      await tester.pumpAndSettle();

      expect(api.marExceptionHandoffCalls, 2);
      expect(api.marExceptionHandoffIdempotencyKeys.toSet(), hasLength(2));
      expect(
        api.lastMarExceptionExpectedPrescriberUid,
        '33333333-3333-4333-8333-333333333333',
      );
    },
  );

  test('unchanged MAR handoff retry preserves its command key', () async {
    final task = _marExceptionTask();
    final api = _FakeClinicalInboxApi(
      tasks: [task],
      marExceptionHandoffFailure: const MarMedicationExceptionHandoffException(
        message: 'Temporary upstream failure',
        statusCode: 503,
      ),
    );
    final provider = ClinicalInboxProvider(api: api);
    await provider.refresh();

    Future<void> submit() => provider.handoffMarMedicationException(
      task: task,
      expectedPrescriberUid: task.assignedToUid,
      targetPrescriberUid: '22222222-2222-4222-8222-222222222222',
      reason: 'On-call ownership changed.',
    );

    await expectLater(
      submit(),
      throwsA(isA<MarMedicationExceptionHandoffException>()),
    );
    await submit();

    expect(api.marExceptionHandoffCalls, 2);
    expect(api.marExceptionHandoffIdempotencyKeys.toSet(), hasLength(1));
  });

  test('MAR handoff copy never falls through to English', () {
    const keys = {
      'clinical_inbox.mar_handoff.action',
      'clinical_inbox.mar_handoff.title',
      'clinical_inbox.mar_handoff.body',
      'clinical_inbox.mar_handoff.case_id',
      'clinical_inbox.mar_handoff.current_prescriber',
      'clinical_inbox.mar_handoff.target_prescriber',
      'clinical_inbox.mar_handoff.prescriber_required',
      'clinical_inbox.mar_handoff.prescribers_failed',
      'clinical_inbox.mar_handoff.no_prescribers',
      'clinical_inbox.mar_handoff.reason',
      'clinical_inbox.mar_handoff.reason_hint',
      'clinical_inbox.mar_handoff.reason_required',
      'clinical_inbox.mar_handoff.confirmation',
      'clinical_inbox.mar_handoff.confirmation_required',
      'clinical_inbox.mar_handoff.submit',
      'clinical_inbox.mar_handoff.submitting',
      'clinical_inbox.mar_handoff.succeeded',
      'clinical_inbox.mar_handoff.failed',
      'clinical_inbox.mar_handoff.stale_owner',
      'clinical_inbox.mar_handoff.no_longer_actionable',
      'clinical_inbox.mar_handoff.requires_connection',
    };
    final english = AppStrings.forLocale(const Locale('en'));
    for (final locale in const ['hi', 'ta', 'te', 'ml']) {
      final translated = AppStrings.forLocale(Locale(locale));
      for (final key in keys) {
        expect(translated.lookup(key), isNot(key), reason: '$locale $key');
        expect(
          translated.lookup(key),
          isNot(english.lookup(key)),
          reason: '$locale fell through for $key',
        );
      }
    }
  });

  testWidgets('finance operator opens the exact governed refund workbench', (
    tester,
  ) async {
    FlutterSecureStorage.setMockInitialValues({
      'staff_role': 'BILLING_INCHARGE',
    });
    final provider = ClinicalInboxProvider(
      api: _FakeClinicalInboxApi(
        tasks: [_counterSaleVoidTask(stage: 'payout')],
      ),
    );

    await tester.pumpWidget(_workflowHost(provider));
    await tester.pumpAndSettle();

    final open = find.widgetWithText(FilledButton, 'Open workflow');
    expect(open, findsOneWidget);
    expect(tester.widget<FilledButton>(open).onPressed, isNotNull);
    await tester.tap(open);
    await tester.pumpAndSettle();

    expect(
      find.text(
        '/billing/refunds?refund_id=2147483643&void_request_id=9223372036854775801',
      ),
      findsOneWidget,
    );
  });

  testWidgets(
    'pharmacy operator opens exact reconciliation from the task detail',
    (tester) async {
      FlutterSecureStorage.setMockInitialValues({
        'staff_role': 'PHARMACY_INCHARGE',
      });
      final provider = ClinicalInboxProvider(
        api: _FakeClinicalInboxApi(
          tasks: [_counterSaleVoidTask(stage: 'reconciliation')],
        ),
      );

      await tester.pumpWidget(_workflowHost(provider));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Reconcile paid counter-sale void'));
      await tester.pumpAndSettle();

      final open = find.widgetWithText(FilledButton, 'Open workflow');
      expect(open, findsNWidgets(2));
      expect(tester.widget<FilledButton>(open.last).onPressed, isNotNull);
      await tester.tap(open.last);
      await tester.pumpAndSettle();

      expect(
        find.text('/pharmacy?tab=counter-sales&sale_id=9223372036854775802'),
        findsOneWidget,
      );
    },
  );

  testWidgets('unauthorized counter-sale task action stays disabled', (
    tester,
  ) async {
    FlutterSecureStorage.setMockInitialValues({'staff_role': 'GENERAL_STAFF'});
    final provider = ClinicalInboxProvider(
      api: _FakeClinicalInboxApi(
        tasks: [_counterSaleVoidTask(stage: 'approval')],
      ),
    );

    await tester.pumpWidget(_workflowHost(provider));
    await tester.pumpAndSettle();

    final open = find.widgetWithText(FilledButton, 'Open workflow');
    expect(open, findsOneWidget);
    expect(tester.widget<FilledButton>(open).onPressed, isNull);
    expect(find.byKey(const Key('workflow-destination')), findsNothing);
  });

  testWidgets('forged counter-sale deep link never enables navigation', (
    tester,
  ) async {
    FlutterSecureStorage.setMockInitialValues({'staff_role': 'ADMIN'});
    final provider = ClinicalInboxProvider(
      api: _FakeClinicalInboxApi(
        tasks: [
          _counterSaleVoidTask(
            stage: 'approval',
            financeDeepLink: '/billing/refunds?refund_id=7&void_request_id=9223372036854775801',
          ),
        ],
      ),
    );

    await tester.pumpWidget(_workflowHost(provider));
    await tester.pumpAndSettle();

    expect(find.widgetWithText(FilledButton, 'Open workflow'), findsNothing);
    expect(find.byKey(const Key('workflow-destination')), findsNothing);
  });

  testWidgets('clinical inbox badge updates from provider count', (
    tester,
  ) async {
    final api = _FakeClinicalInboxApi(
      tasks: [
        _task(id: '1'),
        _task(id: '2'),
      ],
    );
    final provider = ClinicalInboxProvider(api: api);
    await provider.refresh();

    await tester.pumpWidget(
      ChangeNotifierProvider.value(
        value: provider,
        child: MaterialApp(
          home: Consumer<ClinicalInboxProvider>(
            builder: (context, inbox, child) => MessageUnreadBadge(
              unreadCount: inbox.pendingCount,
              semanticLabel: 'pending clinical tasks',
              child: const Icon(Icons.assignment_late_outlined),
            ),
          ),
        ),
      ),
    );

    expect(find.text('2'), findsOneWidget);

    await provider.acknowledge('1');
    await tester.pump();

    expect(find.text('1'), findsOneWidget);
  });

  testWidgets('domain-evidence work requires a signed disposition', (
    tester,
  ) async {
    final api = _FakeClinicalInboxApi(
      tasks: [
        _task(
          id: '73',
          semantics: 'domain_evidence',
          assignedToUid: 'doctor-1',
        ),
      ],
    );
    final provider = ClinicalInboxProvider(api: api);

    await tester.pumpWidget(_host(provider));
    await tester.pumpAndSettle();

    expect(find.text('Review and record action'), findsOneWidget);
    expect(find.text('Acknowledge critical result'), findsNothing);

    await tester.tap(find.text('Review and record action'));
    await tester.pumpAndSettle();
    expect(find.text('Record diagnostic action'), findsOneWidget);

    await tester.tap(find.byType(DropdownButtonFormField<String>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('No action required').last);
    await tester.pumpAndSettle();

    final fields = find.byType(TextFormField);
    await tester.enterText(fields.at(0), 'Reviewed the signed generation.');
    await tester.enterText(fields.at(1), 'No treatment change is required.');
    await tester.tap(find.byType(Checkbox));
    await tester.pump();
    await tester.ensureVisible(find.text('Sign and record action'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Sign and record action'));
    await tester.pumpAndSettle();

    expect(api.actionCalls, 1);
    expect(api.lastAction?.disposition, 'no_action');
    expect(find.text('Diagnostic action recorded'), findsOneWidget);
  });

  testWidgets('recipient accepts transfer and sees canonical admission tuple', (
    tester,
  ) async {
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        expect(request.method, 'POST');
        expect(
          request.url.path,
          endsWith(
            '/appointments/71/inpatient-transfer-requests/33333333-3333-4333-8333-333333333333/accept',
          ),
        );
        return http.Response(
          jsonEncode({
            'success': true,
            'data': {
              'handoff': {
                'id': '33333333-3333-4333-8333-333333333333',
                'status': 'accepted',
              },
              'task': {
                'id': 91,
                'task_kind': 'op_to_inpatient_transfer_review',
                'status': 'completed',
              },
              'transition': {
                'transition_key': 'op_to_inpatient_transfer_accepted',
              },
              'admission_source': {
                'appointment_id': 71,
                'source_pathway_instance_id':
                    '44444444-4444-4444-8444-444444444444',
                'source_handoff_id': '33333333-3333-4333-8333-333333333333',
                'accepted_recipient_uid':
                    '22222222-2222-4222-8222-222222222222',
              },
              'replayed': false,
            },
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );
    final api = _FakeClinicalInboxApi(
      tasks: [
        _task(
          id: '91',
          taskKind: 'op_to_inpatient_transfer_review',
          relatedResourceType: 'care_handoff_instance',
          relatedResourceId: '33333333-3333-4333-8333-333333333333',
          metadata: const {
            'source_appointment_id': 71,
            'care_pathway_instance_id': '44444444-4444-4444-8444-444444444444',
          },
        ),
      ],
    );
    final provider = ClinicalInboxProvider(api: api);

    await tester.pumpWidget(_host(provider));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Accept inpatient transfer'));
    await tester.pumpAndSettle();

    expect(find.text('Transfer accepted'), findsOneWidget);
    expect(find.text('71'), findsOneWidget);
    expect(find.text('33333333-3333-4333-8333-333333333333'), findsOneWidget);
  });

  testWidgets(
    'named discharge owner cross-signs exact refreshed doctor disposition',
    (tester) async {
      final hash = List.filled(64, 'd').join();
      final api = _FakeClinicalInboxApi(
        tasks: [
          _task(
            id: '93',
            assignedToUid: 'doctor-1',
            relatedResourceType: 'discharge_pending_result_action',
            relatedResourceId:
                '11111111-1111-4111-8111-111111111111:'
                '22222222-2222-4222-8222-222222222222',
            diagnosticGenerationId: '22222222-2222-4222-8222-222222222222',
            diagnosticGenerationSnapshotSha256: hash,
            pendingResultAdmissionId: 44,
            pendingResultHandoffId: '11111111-1111-4111-8111-111111111111',
            pendingResultOwnerActionId: '33333333-3333-4333-8333-333333333333',
            pendingResultHandoffState: 'result_available',
            diagnosticAuthoritativeActionId:
                '44444444-4444-4444-8444-444444444444',
            diagnosticAuthoritativeActionKind: 'doctor_disposition',
            diagnosticAuthoritativeDisposition: 'referred',
            canCrossSignPendingResult: true,
          ),
        ],
      );
      final provider = ClinicalInboxProvider(api: api);

      await tester.pumpWidget(_host(provider));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Review discharge result'));
      await tester.pumpAndSettle();

      expect(find.text('22222222-2222-4222-8222-222222222222'), findsOneWidget);
      expect(find.text(hash), findsOneWidget);
      expect(find.text('referred'), findsOneWidget);

      await _tapVisible(
        tester,
        find.byKey(const Key('post-discharge-cross-sign-submit')),
      );
      await tester.pump();
      expect(api.crossSignCalls, 0);

      await _tapVisible(
        tester,
        find.byKey(const Key('post-discharge-cross-sign-attestation')),
      );
      await _tapVisible(
        tester,
        find.byKey(const Key('post-discharge-cross-sign-submit')),
      );
      await tester.pumpAndSettle();

      expect(api.actionCalls, 0);
      expect(api.crossSignCalls, 1);
      expect(api.lastCrossSign?.admissionId, 44);
      expect(
        api.lastCrossSign?.diagnosticActionId,
        '44444444-4444-4444-8444-444444444444',
      );
      expect(api.lastCrossSign?.generationSnapshotSha256, hash);
      expect(find.text('Result review cross-signed'), findsOneWidget);
    },
  );

  testWidgets('normal auto-closed discharge result stays read-only', (
    tester,
  ) async {
    final api = _FakeClinicalInboxApi(
      tasks: [
        _task(
          id: '94',
          status: 'completed',
          assignedToUid: 'doctor-1',
          relatedResourceType: 'discharge_pending_result_action',
          diagnosticGenerationId: '22222222-2222-4222-8222-222222222222',
          diagnosticGenerationSnapshotSha256: List.filled(64, 'e').join(),
          pendingResultAdmissionId: 44,
          pendingResultHandoffId: '11111111-1111-4111-8111-111111111111',
          pendingResultOwnerActionId: '33333333-3333-4333-8333-333333333333',
          pendingResultHandoffState: 'resolved',
          pendingResultResolutionActionId:
              '55555555-5555-4555-8555-555555555555',
          diagnosticAuthoritativeActionId:
              '44444444-4444-4444-8444-444444444444',
          diagnosticAuthoritativeActionKind: 'normal_auto_closed',
          canCrossSignPendingResult: false,
        ),
      ],
    );
    final provider = ClinicalInboxProvider(api: api);

    await tester.pumpWidget(_host(provider));
    await tester.pumpAndSettle();

    expect(provider.pendingCount, 0);
    expect(find.text('Resolved — no action available'), findsOneWidget);
    expect(
      tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
      isNull,
    );
    expect(api.crossSignCalls, 0);
  });

  testWidgets('409 refreshes corrected binding and rotates only then', (
    tester,
  ) async {
    final handoffId = '11111111-1111-4111-8111-111111111111';
    final first = _task(
      id: '95',
      assignedToUid: 'doctor-1',
      relatedResourceType: 'discharge_pending_result_action',
      diagnosticGenerationId: '22222222-2222-4222-8222-222222222222',
      diagnosticGenerationSnapshotSha256: List.filled(64, 'a').join(),
      pendingResultAdmissionId: 44,
      pendingResultHandoffId: handoffId,
      pendingResultOwnerActionId: '33333333-3333-4333-8333-333333333333',
      pendingResultHandoffState: 'result_available',
      diagnosticAuthoritativeActionId: '44444444-4444-4444-8444-444444444444',
      diagnosticAuthoritativeActionKind: 'doctor_disposition',
      diagnosticAuthoritativeDisposition: 'referred',
      canCrossSignPendingResult: true,
    );
    final corrected = _task(
      id: '96',
      assignedToUid: 'doctor-1',
      relatedResourceType: 'discharge_pending_result_action',
      diagnosticGenerationId: '55555555-5555-4555-8555-555555555555',
      diagnosticGenerationSnapshotSha256: List.filled(64, 'b').join(),
      pendingResultAdmissionId: 44,
      pendingResultHandoffId: handoffId,
      pendingResultOwnerActionId: '66666666-6666-4666-8666-666666666666',
      pendingResultHandoffState: 'result_available',
      diagnosticAuthoritativeActionId: '77777777-7777-4777-8777-777777777777',
      diagnosticAuthoritativeActionKind: 'doctor_disposition',
      diagnosticAuthoritativeDisposition: 'repeated',
      canCrossSignPendingResult: true,
    );
    final api = _FakeClinicalInboxApi(
      tasks: [first],
      crossSignFailure: const PostDischargeCrossSignException(
        message: 'Attested diagnostic generation hash is stale',
        statusCode: 409,
        code: 'INPATIENT_PENDING_RESULT_CROSS_SIGN_GENERATION_STALE',
      ),
      tasksAfterCrossSignFailure: [corrected],
    );
    final provider = ClinicalInboxProvider(api: api);

    await tester.pumpWidget(_host(provider));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Review discharge result'));
    await tester.pumpAndSettle();
    await _tapVisible(
      tester,
      find.byKey(const Key('post-discharge-cross-sign-attestation')),
    );
    await _tapVisible(
      tester,
      find.byKey(const Key('post-discharge-cross-sign-submit')),
    );
    await tester.pumpAndSettle();

    expect(api.crossSignCalls, 1);
    expect(find.text('55555555-5555-4555-8555-555555555555'), findsOneWidget);
    expect(find.text('repeated'), findsOneWidget);
    expect(
      tester
          .widget<CheckboxListTile>(
            find.byKey(const Key('post-discharge-cross-sign-attestation')),
          )
          .value,
      isFalse,
    );

    await _tapVisible(
      tester,
      find.byKey(const Key('post-discharge-cross-sign-attestation')),
    );
    await _tapVisible(
      tester,
      find.byKey(const Key('post-discharge-cross-sign-submit')),
    );
    await tester.pumpAndSettle();

    expect(api.crossSignCalls, 2);
    expect(api.crossSignIdempotencyKeys.toSet(), hasLength(2));
    expect(
      api.lastCrossSign?.generationId,
      '55555555-5555-4555-8555-555555555555',
    );
  });

  testWidgets('same-binding 409 retry preserves its idempotency key', (
    tester,
  ) async {
    final task = _task(
      id: '97',
      assignedToUid: 'doctor-1',
      relatedResourceType: 'discharge_pending_result_action',
      diagnosticGenerationId: '22222222-2222-4222-8222-222222222222',
      diagnosticGenerationSnapshotSha256: List.filled(64, 'c').join(),
      pendingResultAdmissionId: 44,
      pendingResultHandoffId: '11111111-1111-4111-8111-111111111111',
      pendingResultOwnerActionId: '33333333-3333-4333-8333-333333333333',
      pendingResultHandoffState: 'result_available',
      diagnosticAuthoritativeActionId: '44444444-4444-4444-8444-444444444444',
      diagnosticAuthoritativeActionKind: 'doctor_disposition',
      diagnosticAuthoritativeDisposition: 'referred',
      canCrossSignPendingResult: true,
    );
    final api = _FakeClinicalInboxApi(
      tasks: [task],
      crossSignFailure: const PostDischargeCrossSignException(
        message: 'Cross-sign outcome requires a replay',
        statusCode: 409,
        code: 'INPATIENT_PENDING_RESULT_CROSS_SIGN_CONFLICT',
      ),
      tasksAfterCrossSignFailure: [task],
    );
    final provider = ClinicalInboxProvider(api: api);

    await tester.pumpWidget(_host(provider));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Review discharge result'));
    await tester.pumpAndSettle();
    await _tapVisible(
      tester,
      find.byKey(const Key('post-discharge-cross-sign-attestation')),
    );
    await _tapVisible(
      tester,
      find.byKey(const Key('post-discharge-cross-sign-submit')),
    );
    await tester.pumpAndSettle();
    await _tapVisible(
      tester,
      find.byKey(const Key('post-discharge-cross-sign-attestation')),
    );
    await _tapVisible(
      tester,
      find.byKey(const Key('post-discharge-cross-sign-submit')),
    );
    await tester.pumpAndSettle();

    expect(api.crossSignCalls, 2);
    expect(api.crossSignIdempotencyKeys.toSet(), hasLength(1));
  });
}

Future<void> _tapVisible(WidgetTester tester, Finder finder) async {
  await tester.ensureVisible(finder);
  await tester.pump();
  await tester.tap(finder);
}

Widget _host(
  ClinicalInboxProvider provider, {
  MarPrescriberLoader loadActivePrescribers = loadActiveMarPrescribers,
}) {
  return ChangeNotifierProvider.value(
    value: provider,
    child: MaterialApp(
      home: ClinicalInboxScreen(loadActivePrescribers: loadActivePrescribers),
    ),
  );
}

Widget _workflowHost(ClinicalInboxProvider provider) {
  final router = GoRouter(
    initialLocation: '/clinical-inbox',
    routes: [
      GoRoute(
        path: '/clinical-inbox',
        builder: (context, state) => const ClinicalInboxScreen(),
      ),
      GoRoute(
        path: '/billing/refunds',
        builder: (context, state) => Scaffold(
          body: Text(
            state.uri.toString(),
            key: const Key('workflow-destination'),
          ),
        ),
      ),
      GoRoute(
        path: '/pharmacy',
        builder: (context, state) => Scaffold(
          body: Text(
            state.uri.toString(),
            key: const Key('workflow-destination'),
          ),
        ),
      ),
    ],
  );
  return ChangeNotifierProvider.value(
    value: provider,
    child: MaterialApp.router(routerConfig: router),
  );
}

ClinicalInboxTask _counterSaleVoidTask({
  required String stage,
  String? financeDeepLink,
}) {
  const taskId = '9223372036854775800';
  const requestId = '9223372036854775801';
  const saleId = '9223372036854775802';
  const refundId = '2147483643';
  const invoiceId = '9223372036854775804';
  final assignedRole = switch (stage) {
    'approval' => 'ADMIN',
    'payout' => 'BILLING_INCHARGE',
    'reconciliation' => 'PHARMACY_INCHARGE',
    'rejected_review' => 'ADMIN',
    _ => '',
  };
  final ownerRoles = switch (stage) {
    'approval' => const ['ADMIN', 'SUPER_ADMIN'],
    'payout' => const [
      'FINANCE_INCHARGE',
      'BILLING_INCHARGE',
      'BILLING_STAFF',
      'CASHIER',
    ],
    'reconciliation' => const ['ADMIN', 'PHARMACY_INCHARGE'],
    'rejected_review' => const ['ADMIN', 'SUPER_ADMIN', 'PHARMACY_INCHARGE'],
    _ => const <String>[],
  };
  return ClinicalInboxTask.fromJson({
    'id': taskId,
    'task_kind': 'review',
    'title': stage == 'reconciliation'
        ? 'Reconcile paid counter-sale void'
        : 'Settle counter-sale void refund',
    'priority': 'high',
    'status': 'open',
    'related_resource_type': 'pharmacy_counter_sale_void_requests',
    'related_resource_id': requestId,
    'assigned_to_role': assignedRole,
    'workflow_sla_instance_id': '11111111-1111-4111-8111-111111111111',
    'sla_completion_semantics': 'domain_evidence',
    'metadata': {
      'task_contract': 'counter_sale_void_refund_v1',
      'evidence_kind': 'counter_sale_void_completed',
      'counter_sale_void_request_id': requestId,
      'counter_sale_id': saleId,
      'refund_id': refundId,
      'invoice_id': invoiceId,
      'task_stage': stage,
      'owner_role_codes': ownerRoles,
      'finance_deep_link':
          financeDeepLink ??
          '/billing/refunds?refund_id=$refundId&void_request_id=$requestId',
      'pharmacy_deep_link': '/pharmacy?tab=counter-sales&sale_id=$saleId',
      'sla_key': 'counter_sale_void_refund',
      'sla_instance_id': '11111111-1111-4111-8111-111111111111',
    },
  });
}

ClinicalInboxTask _marExceptionTask({
  String assignedToUid = '11111111-1111-4111-8111-111111111111',
}) {
  return ClinicalInboxTask.fromJson({
    'id': '84',
    'task_kind': 'review',
    'title': 'Missed medication dose review',
    'description': 'Governed prescriber disposition required',
    'patient_uid': '44444444-4444-4444-8444-444444444444',
    'priority': 'high',
    'status': 'open',
    'assigned_to_uid': assignedToUid,
    'related_resource_type': 'mar_medication_exception_cases',
    'related_resource_id': '73',
    'sla_completion_semantics': 'domain_evidence',
    'due_at': DateTime.now().add(const Duration(minutes: 8)).toIso8601String(),
    'metadata': const {
      'task_contract': 'mar_medication_exception_v1',
      'exception_case_id': '73',
      'medication_administration_id': '42',
      'exception_kind': 'missed',
      'sla_key': 'mar_medication_exception_review',
      'deep_link': '/mar/due?exception_id=73',
    },
  });
}

ClinicalInboxTask _task({
  required String id,
  String semantics = 'acknowledgement',
  String assignedToUid = '',
  String? assignedToRole,
  String taskKind = '',
  String status = 'open',
  String relatedResourceType = 'lab_result',
  String? relatedResourceId,
  Map<String, dynamic> metadata = const {'source': 'lab_result'},
  String? diagnosticGenerationId,
  String? diagnosticGenerationSnapshotSha256,
  int? pendingResultAdmissionId,
  String pendingResultHandoffId = '',
  String pendingResultOwnerActionId = '',
  String pendingResultHandoffState = '',
  String pendingResultResolutionActionId = '',
  String diagnosticAuthoritativeActionId = '',
  String diagnosticAuthoritativeActionKind = '',
  String diagnosticAuthoritativeDisposition = '',
  bool canCrossSignPendingResult = false,
  bool recoveredCriticalAwareness = false,
}) {
  final now = DateTime.now();
  return ClinicalInboxTask(
    id: id,
    taskKind: taskKind,
    title: 'Critical lab: Potassium',
    description: 'K 6.8 mmol/L above critical threshold',
    patientUid: 'patient-$id',
    priority: 'critical',
    status: status,
    relatedResourceType: relatedResourceType,
    relatedResourceId: relatedResourceId ?? 'lr-$id',
    assignedToUid: assignedToUid,
    assignedToRole:
        assignedToRole ?? (assignedToUid.isEmpty ? 'DUTY_DOCTOR' : ''),
    slaCompletionSemantics: recoveredCriticalAwareness ? 'none' : semantics,
    diagnosticGenerationId:
        diagnosticGenerationId ??
        (semantics == 'domain_evidence'
            ? '11111111-1111-4111-8111-111111111111'
            : ''),
    diagnosticClassification: semantics == 'domain_evidence' ? 'abnormal' : '',
    diagnosticGenerationSnapshotSha256:
        diagnosticGenerationSnapshotSha256 ??
        (semantics == 'domain_evidence' ? List.filled(64, 'a').join() : ''),
    pendingResultAdmissionId: pendingResultAdmissionId,
    pendingResultHandoffId: pendingResultHandoffId,
    pendingResultOwnerActionId: pendingResultOwnerActionId,
    pendingResultHandoffState: pendingResultHandoffState,
    pendingResultResolutionActionId: pendingResultResolutionActionId,
    diagnosticAuthoritativeActionId: diagnosticAuthoritativeActionId,
    diagnosticAuthoritativeActionKind: diagnosticAuthoritativeActionKind,
    diagnosticAuthoritativeDisposition: diagnosticAuthoritativeDisposition,
    canCrossSignPendingResult: canCrossSignPendingResult,
    externalRecoveryCriticalReviewObligationId: recoveredCriticalAwareness
        ? '11111111-1111-4111-8111-111111111111'
        : '',
    externalRecoveryInterfaceFamily: recoveredCriticalAwareness ? 'I01' : '',
    externalRecoveryAwarenessAcknowledgementRequired:
        recoveredCriticalAwareness,
    externalRecoverySourceOccurredAt: recoveredCriticalAwareness
        ? now.subtract(const Duration(days: 3))
        : null,
    externalRecoveryAwarenessRecordedAt: recoveredCriticalAwareness
        ? now.subtract(const Duration(minutes: 2))
        : null,
    dueAt: recoveredCriticalAwareness
        ? null
        : now.add(const Duration(minutes: 8)),
    slaBreachedAt: null,
    createdAt: now.subtract(const Duration(minutes: 2)),
    metadata: metadata,
  );
}

class _FakeClinicalInboxApi extends ClinicalInboxApi {
  _FakeClinicalInboxApi({
    required this._tasks,
    this.acknowledgeDelay,
    this.crossSignFailure,
    this.tasksAfterCrossSignFailure,
    this.marExceptionHandoffFailure,
    this.tasksAfterMarExceptionHandoffFailure,
  });

  List<ClinicalInboxTask> _tasks;
  final Future<void>? acknowledgeDelay;
  PostDischargeCrossSignException? crossSignFailure;
  final List<ClinicalInboxTask>? tasksAfterCrossSignFailure;
  MarMedicationExceptionHandoffException? marExceptionHandoffFailure;
  final List<ClinicalInboxTask>? tasksAfterMarExceptionHandoffFailure;
  int acknowledgeCalls = 0;
  int actionCalls = 0;
  int crossSignCalls = 0;
  int marExceptionClaimCalls = 0;
  int marExceptionHandoffCalls = 0;
  final List<String> marExceptionClaimCaseIds = [];
  final List<String> marExceptionClaimIdempotencyKeys = [];
  final List<String> marExceptionHandoffIdempotencyKeys = [];
  final List<String> crossSignIdempotencyKeys = [];
  DiagnosticActionCommand? lastAction;
  PostDischargeCrossSignCommand? lastCrossSign;
  String? lastMarExceptionExpectedPrescriberUid;
  String? lastMarExceptionTargetPrescriberUid;
  String? lastMarExceptionHandoffReason;

  @override
  Future<ClinicalInboxResult> listInboxTasks({int limit = 100}) async {
    return ClinicalInboxResult(tasks: _tasks, count: _tasks.length);
  }

  @override
  Future<ClinicalInboxTask> acknowledgeTask(
    String id, {
    int? breakGlassId,
  }) async {
    acknowledgeCalls += 1;
    final delay = acknowledgeDelay;
    if (delay != null) await delay;
    final updated = _tasks
        .firstWhere((task) => task.id == id)
        .copyWith(status: 'in_progress');
    _tasks = [for (final task in _tasks) task.id == id ? updated : task];
    return updated;
  }

  @override
  Future<ClinicalInboxTask> claimTask(String id) async {
    final updated = _tasks
        .firstWhere((task) => task.id == id)
        .copyWith(assignedToUid: 'doctor-1', assignedToRole: '');
    _tasks = [for (final task in _tasks) task.id == id ? updated : task];
    return updated;
  }

  @override
  Future<void> claimMarMedicationException({
    required String caseId,
    required String idempotencyKey,
  }) async {
    marExceptionClaimCalls += 1;
    marExceptionClaimCaseIds.add(caseId);
    marExceptionClaimIdempotencyKeys.add(idempotencyKey);
    final updated = _tasks
        .firstWhere((task) => task.relatedResourceId == caseId)
        .copyWith(assignedToUid: 'doctor-1', assignedToRole: '');
    _tasks = [
      for (final task in _tasks) task.id == updated.id ? updated : task,
    ];
  }

  @override
  Future<MarMedicationExceptionHandoffReceipt> handoffMarMedicationException({
    required String caseId,
    required String expectedPrescriberUid,
    required String targetPrescriberUid,
    required String reason,
    required String idempotencyKey,
  }) async {
    marExceptionHandoffCalls += 1;
    marExceptionHandoffIdempotencyKeys.add(idempotencyKey);
    lastMarExceptionExpectedPrescriberUid = expectedPrescriberUid;
    lastMarExceptionTargetPrescriberUid = targetPrescriberUid;
    lastMarExceptionHandoffReason = reason.trim();
    final failure = marExceptionHandoffFailure;
    if (failure != null) {
      marExceptionHandoffFailure = null;
      final replacement = tasksAfterMarExceptionHandoffFailure;
      if (replacement != null) _tasks = replacement;
      throw failure;
    }
    final updated = _tasks
        .firstWhere((task) => task.relatedResourceId == caseId)
        .copyWith(assignedToUid: targetPrescriberUid, assignedToRole: '');
    _tasks = [
      for (final task in _tasks) task.id == updated.id ? updated : task,
    ];
    return MarMedicationExceptionHandoffReceipt(
      exceptionCaseId: caseId,
      taskId: updated.id,
      assignmentHandoffEventId: '91',
      fromPrescriberUid: expectedPrescriberUid,
      assignedPrescriberUid: targetPrescriberUid,
      handedOffAt: DateTime.now(),
      replayed: false,
    );
  }

  @override
  Future<DiagnosticActionReceipt> recordDiagnosticAction(
    DiagnosticActionCommand command,
  ) async {
    actionCalls += 1;
    lastAction = command;
    _tasks = [
      for (final task in _tasks)
        if (task.id != command.taskId) task,
    ];
    return DiagnosticActionReceipt(
      id: 'action-1',
      generationId: command.generationId,
      taskId: command.taskId,
      actionKind: 'doctor_disposition',
      disposition: command.disposition,
      signatureId: 'signature-1',
      replayed: false,
    );
  }

  @override
  Future<PostDischargeCrossSignReceipt> crossSignPendingResult(
    PostDischargeCrossSignCommand command,
  ) async {
    crossSignCalls += 1;
    lastCrossSign = command;
    crossSignIdempotencyKeys.add(command.idempotencyKey);
    final failure = crossSignFailure;
    if (failure != null) {
      crossSignFailure = null;
      final replacement = tasksAfterCrossSignFailure;
      if (replacement != null) _tasks = replacement;
      throw failure;
    }
    _tasks = [
      for (final task in _tasks)
        if (task.id != command.actionTaskId) task,
    ];
    return PostDischargeCrossSignReceipt(
      id: '55555555-5555-4555-8555-555555555555',
      admissionId: command.admissionId,
      handoffId: command.handoffId,
      generationId: command.generationId,
      diagnosticActionId: command.diagnosticActionId,
      pathwayInstanceId: '66666666-6666-4666-8666-666666666666',
      ownerActionId: '77777777-7777-4777-8777-777777777777',
      actionTaskId: command.actionTaskId,
      trackingTaskId: '92',
      signatureId: '88888888-8888-4888-8888-888888888888',
      resolutionActionId: '55555555-5555-4555-8555-555555555555',
      handoffState: 'resolved',
      currentHandoffState: 'resolved',
      generationSnapshotSha256: command.generationSnapshotSha256,
      requestSha256: List.filled(64, 'f').join(),
      canonicalTimelineEventId: '99999999-9999-4999-8999-999999999999',
      canonicalAuditEventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      replayed: false,
    );
  }

  @override
  Future<DiagnosticActionReceipt> reopenDiagnosticResult({
    required String generationId,
    required String reason,
  }) {
    throw UnsupportedError('Reopen is outside this screen fixture');
  }
}
