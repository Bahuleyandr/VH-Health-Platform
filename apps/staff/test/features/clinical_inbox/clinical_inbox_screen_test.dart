import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_staff/core/providers/clinical_inbox_provider.dart';
import 'package:vhhealth_staff/core/services/clinical_inbox_api_service.dart';
import 'package:vhhealth_staff/core/widgets/message_unread_badge.dart';
import 'package:vhhealth_staff/features/clinical_inbox/screens/clinical_inbox_screen.dart';

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

Widget _host(ClinicalInboxProvider provider) {
  return ChangeNotifierProvider.value(
    value: provider,
    child: const MaterialApp(home: ClinicalInboxScreen()),
  );
}

ClinicalInboxTask _task({
  required String id,
  String semantics = 'acknowledgement',
  String assignedToUid = '',
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
    assignedToRole: assignedToUid.isEmpty ? 'DUTY_DOCTOR' : '',
    slaCompletionSemantics: semantics,
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
    dueAt: now.add(const Duration(minutes: 8)),
    slaBreachedAt: null,
    createdAt: now.subtract(const Duration(minutes: 2)),
    metadata: metadata,
  );
}

class _FakeClinicalInboxApi extends ClinicalInboxApi {
  _FakeClinicalInboxApi({
    required List<ClinicalInboxTask> tasks,
    this.acknowledgeDelay,
    this.crossSignFailure,
    this.tasksAfterCrossSignFailure,
  }) : _tasks = tasks;

  List<ClinicalInboxTask> _tasks;
  final Future<void>? acknowledgeDelay;
  PostDischargeCrossSignException? crossSignFailure;
  final List<ClinicalInboxTask>? tasksAfterCrossSignFailure;
  int acknowledgeCalls = 0;
  int actionCalls = 0;
  int crossSignCalls = 0;
  final List<String> crossSignIdempotencyKeys = [];
  DiagnosticActionCommand? lastAction;
  PostDischargeCrossSignCommand? lastCrossSign;

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
}
