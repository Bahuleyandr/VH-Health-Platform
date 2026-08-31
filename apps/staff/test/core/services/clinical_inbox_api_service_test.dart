import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_staff/core/services/clinical_inbox_api_service.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
    VHHttpClient.resetClientForTesting();
    VHHttpClient.onSessionExpired = null;
  });

  tearDown(() {
    VHHttpClient.resetClientForTesting();
    VHHttpClient.onSessionExpired = null;
  });

  test('ward-medication domain evidence retains its actionable deep link', () {
    final task = ClinicalInboxTask.fromJson({
      'id': '81',
      'title': 'MAR supply reconciliation required',
      'description': 'Match the exact ward allocation quantities',
      'patient_uid': '11111111-1111-4111-8111-111111111111',
      'priority': 'high',
      'status': 'open',
      'related_resource_type': 'medication_administration',
      'related_resource_id': '42',
      'assigned_to_role': 'NURSING_INCHARGE',
      'sla_completion_semantics': 'domain_evidence',
      'metadata': {
        'task_contract': 'ward_medication_obligation_v1',
        'deep_link': '/clinical/mar/42?supply-reconciliation=1',
      },
    });

    expect(task.needsRoutedDomainEvidence, isTrue);
    expect(
      task.domainEvidenceDeepLink,
      '/clinical/mar/42?supply-reconciliation=1',
    );
    expect(task.needsClinicalAction, isTrue);
  });

  test(
    'alert recovery is actionable only for its exact typed case binding',
    () {
      ClinicalInboxTask task({
        String contract = 'clinical_alert_delivery_recovery_v1',
        String resource = 'clinical_alert_delivery_recovery_cases',
        String resourceId = '9223372036854775806',
        String caseKind = 'manual_hold',
        String obligationId = '9223372036854775805',
      }) => ClinicalInboxTask.fromJson({
        'id': '82',
        'status': 'open',
        'sla_completion_semantics': 'domain_evidence',
        'related_resource_type': resource,
        'related_resource_id': resourceId,
        'metadata': {
          'task_contract': contract,
          'case_kind': caseKind,
          'obligation_id': obligationId,
          'deep_link': '/api/v1/admin/forged',
        },
      });

      final exact = task();
      expect(exact.isClinicalAlertDeliveryRecovery, isTrue);
      expect(exact.needsRoutedDomainEvidence, isTrue);
      expect(
        exact.domainEvidenceRoute,
        '/clinical-inbox/recovery?case_id=9223372036854775806',
      );
      expect(task(resource: 'tasks').needsRoutedDomainEvidence, isFalse);
      expect(task(caseKind: 'other').needsRoutedDomainEvidence, isFalse);
      expect(task(resourceId: '0').needsRoutedDomainEvidence, isFalse);
      expect(
        task(obligationId: 'arbitrary').needsRoutedDomainEvidence,
        isFalse,
      );
      expect(task(contract: 'other_v1').needsRoutedDomainEvidence, isFalse);
    },
  );

  test('MAR exception routing requires the exact typed task binding', () {
    ClinicalInboxTask task({
      String contract = 'mar_medication_exception_v1',
      String resource = 'mar_medication_exception_cases',
      String resourceId = '73',
      String caseId = '73',
      String administrationId = '42',
      String exceptionKind = 'missed',
      String slaKey = 'mar_medication_exception_review',
    }) => ClinicalInboxTask.fromJson({
      'id': '83',
      'task_kind': 'review',
      'status': 'open',
      'assigned_to_role': 'DOCTOR',
      'sla_completion_semantics': 'domain_evidence',
      'related_resource_type': resource,
      'related_resource_id': resourceId,
      'metadata': {
        'task_contract': contract,
        'exception_case_id': caseId,
        'medication_administration_id': administrationId,
        'exception_kind': exceptionKind,
        'sla_key': slaKey,
        'deep_link': '/api/v1/admin/forged',
      },
    });

    final exact = task();
    expect(exact.isMarMedicationException, isTrue);
    expect(exact.needsRoutedDomainEvidence, isTrue);
    expect(exact.domainEvidenceRoute, '/mar/due?exception_id=73');
    expect(task(resource: 'tasks').needsRoutedDomainEvidence, isFalse);
    expect(task(caseId: '74').needsRoutedDomainEvidence, isFalse);
    expect(task(administrationId: '0').needsRoutedDomainEvidence, isFalse);
    expect(task(exceptionKind: 'other').needsRoutedDomainEvidence, isFalse);
    expect(task(slaKey: 'other').needsRoutedDomainEvidence, isFalse);
    expect(task(contract: 'other_v1').needsRoutedDomainEvidence, isFalse);
  });

  test('counter-sale void stages route only their exact operator roles', () {
    final approval = _counterSaleVoidTask(stage: 'approval');
    expect(approval.isCounterSaleVoidRefund, isTrue);
    expect(approval.needsRoutedDomainEvidence, isTrue);
    expect(
      approval.counterSaleVoidRouteForRole('SUPER_ADMIN'),
      '/billing/refunds?refund_id=9223372036854775803&void_request_id=9223372036854775801',
    );
    expect(approval.counterSaleVoidRouteForRole('BILLING_INCHARGE'), isNull);

    final payout = _counterSaleVoidTask(stage: 'payout');
    for (final role in const {
      'FINANCE_INCHARGE',
      'BILLING_INCHARGE',
      'BILLING_STAFF',
      'CASHIER',
    }) {
      expect(
        payout.counterSaleVoidRouteForRole(role),
        '/billing/refunds?refund_id=9223372036854775803&void_request_id=9223372036854775801',
        reason: role,
      );
    }
    expect(payout.counterSaleVoidRouteForRole('ADMIN'), isNull);

    final reconciliation = _counterSaleVoidTask(
      stage: 'reconciliation',
      status: 'blocked',
    );
    expect(reconciliation.isCounterSaleVoidRefund, isTrue);
    expect(
      reconciliation.counterSaleVoidRouteForRole('PHARMACY_INCHARGE'),
      '/pharmacy?tab=counter-sales&sale_id=9223372036854775802',
    );
    expect(
      reconciliation.counterSaleVoidRouteForRole(' admin '),
      '/pharmacy?tab=counter-sales&sale_id=9223372036854775802',
    );
    expect(
      reconciliation.counterSaleVoidRouteForRole('PHARMACY_STAFF'),
      isNull,
    );

    final rejected = _counterSaleVoidTask(stage: 'rejected_review');
    for (final role in const {'ADMIN', 'SUPER_ADMIN', 'PHARMACY_INCHARGE'}) {
      expect(
        rejected.counterSaleVoidRouteForRole(role),
        '/pharmacy?tab=counter-sales&sale_id=9223372036854775802',
        reason: role,
      );
    }
    expect(rejected.counterSaleVoidRouteForRole('FINANCE_INCHARGE'), isNull);
  });

  test('counter-sale void task binding rejects malformed or forged fields', () {
    final malformed = <ClinicalInboxTask>[
      _counterSaleVoidTask(relatedResourceId: '9223372036854775799'),
      _counterSaleVoidTask(taskId: '9223372036854775808'),
      _counterSaleVoidTask(saleId: '0'),
      _counterSaleVoidTask(refundId: '9223372036854775808'),
      _counterSaleVoidTask(invoiceId: '01'),
      _counterSaleVoidTask(
        assignedToUid: '11111111-1111-4111-8111-111111111111',
      ),
      _counterSaleVoidTask(assignedToRole: 'SUPER_ADMIN'),
      _counterSaleVoidTask(
        ownerRoleCodes: const ['ADMIN', 'SUPER_ADMIN', 'BILLING_STAFF'],
      ),
      _counterSaleVoidTask(slaInstanceId: 'not-a-uuid'),
      _counterSaleVoidTask(
        workflowSlaInstanceId: '22222222-2222-4222-8222-222222222222',
      ),
      _counterSaleVoidTask(evidenceKind: 'refund_paid'),
      _counterSaleVoidTask(
        financeDeepLink:
            '/billing/refunds?refund_id=1&void_request_id=9223372036854775801',
      ),
      _counterSaleVoidTask(
        pharmacyDeepLink:
            '/pharmacy?tab=counter-sales&sale_id=9223372036854775798',
      ),
      _counterSaleVoidTask(stage: 'completed'),
      _counterSaleVoidTask(status: 'completed'),
    ];

    for (final task in malformed) {
      expect(
        task.isCounterSaleVoidRefund,
        isFalse,
        reason: task.metadata.toString(),
      );
      expect(task.needsRoutedDomainEvidence, isFalse);
      expect(task.counterSaleVoidRouteForRole('ADMIN'), isNull);
    }

    final forgedAcknowledgementFallback = ClinicalInboxTask.fromJson({
      'id': '91',
      'status': 'open',
      'sla_completion_semantics': 'acknowledgement',
      'metadata': {'task_contract': 'counter_sale_void_refund_v1'},
    });
    final forgedDiagnosticFallback = ClinicalInboxTask.fromJson({
      'id': '92',
      'status': 'open',
      'sla_completion_semantics': 'domain_evidence',
      'diagnostic_generation_id': '11111111-1111-4111-8111-111111111111',
      'diagnostic_generation_snapshot_sha256': List.filled(64, 'a').join(),
      'metadata': {'task_contract': 'counter_sale_void_refund_v1'},
    });
    expect(forgedAcknowledgementFallback.needsAcknowledgement, isFalse);
    expect(forgedAcknowledgementFallback.needsClinicalAction, isFalse);
    expect(forgedDiagnosticFallback.needsDoctorAction, isFalse);
    expect(forgedDiagnosticFallback.needsClinicalAction, isFalse);
  });

  test('sends a durable break-glass record id when one is supplied', () async {
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        expect(request.method, 'POST');
        expect(
          request.url.path,
          endsWith('/clinical-inbox/tasks/71/acknowledge'),
        );
        expect(jsonDecode(request.body), {'break_glass_id': 42});
        return http.Response(
          jsonEncode({
            'success': true,
            'data': {'id': '71', 'status': 'in_progress'},
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    final task = await ClinicalInboxApiService.instance.acknowledgeTask(
      '71',
      breakGlassId: 42,
    );

    expect(task.id, '71');
    expect(task.status, 'in_progress');
  });

  test('claims a role queue task with a stable idempotency key', () async {
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        expect(request.method, 'POST');
        expect(request.url.path, endsWith('/clinical-inbox/tasks/72/claim'));
        expect(jsonDecode(request.body), <String, dynamic>{});
        expect(request.headers['idempotency-key'], isNotEmpty);
        return http.Response(
          jsonEncode({
            'success': true,
            'data': {
              'id': '72',
              'status': 'open',
              'assigned_to_uid': 'doctor-1',
              'sla_completion_semantics': 'domain_evidence',
            },
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    final task = await ClinicalInboxApiService.instance.claimTask('72');

    expect(task.assignedToUid, 'doctor-1');
    expect(task.slaCompletionSemantics, 'domain_evidence');
  });

  test(
    'claims a MAR exception through its domain endpoint and caller key',
    () async {
      late http.Request captured;
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          captured = request;
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {
                'exception_case_id': 73,
                'task_id': 83,
                'assigned_prescriber_uid':
                    '11111111-1111-4111-8111-111111111111',
                'status': 'open',
              },
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      await ClinicalInboxApiService.instance.claimMarMedicationException(
        caseId: '73',
        idempotencyKey: 'mar-exception-claim:73:test',
      );

      expect(captured.method, 'POST');
      expect(captured.url.path, endsWith('/clinical/mar/exceptions/73/claim'));
      expect(
        captured.headers['idempotency-key'],
        'mar-exception-claim:73:test',
      );
      expect(jsonDecode(captured.body), <String, dynamic>{});
    },
  );

  test(
    'hands off a MAR exception with exact ownership and caller command key',
    () async {
      late http.Request captured;
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          captured = request;
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {
                'exception_case_id': '73',
                'task_id': 83,
                'assignment_handoff_event_id': '91',
                'from_prescriber_uid': '11111111-1111-4111-8111-111111111111',
                'assigned_prescriber_uid':
                    '22222222-2222-4222-8222-222222222222',
                'handed_off_at': '2026-08-28T10:00:00.000Z',
                'replayed': false,
              },
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      final receipt = await ClinicalInboxApiService.instance
          .handoffMarMedicationException(
            caseId: '73',
            expectedPrescriberUid: '11111111-1111-4111-8111-111111111111',
            targetPrescriberUid: '22222222-2222-4222-8222-222222222222',
            reason: '  On-call ownership changed.  ',
            idempotencyKey: 'mar-exception-handoff:73:test',
          );

      expect(captured.method, 'POST');
      expect(
        captured.url.path,
        endsWith('/clinical/mar/exceptions/73/handoff'),
      );
      expect(
        captured.headers['idempotency-key'],
        'mar-exception-handoff:73:test',
      );
      expect(jsonDecode(captured.body), {
        'expected_prescriber_uid': '11111111-1111-4111-8111-111111111111',
        'target_prescriber_uid': '22222222-2222-4222-8222-222222222222',
        'reason': 'On-call ownership changed.',
      });
      expect(receipt.exceptionCaseId, '73');
      expect(receipt.taskId, '83');
      expect(
        receipt.assignedPrescriberUid,
        '22222222-2222-4222-8222-222222222222',
      );
    },
  );

  test('records an explicitly attested diagnostic action', () async {
    final snapshotHash = List.filled(64, 'a').join();
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        expect(request.method, 'POST');
        expect(
          request.url.path,
          endsWith('/clinical-inbox/diagnostic-results/generation-1/actions'),
        );
        expect(request.headers['idempotency-key'], isNotEmpty);
        expect(jsonDecode(request.body), {
          'task_id': 73,
          'disposition': 'referred',
          'clinical_note': 'Reviewed the complete signed generation.',
          'generation_snapshot_sha256': snapshotHash,
          'attested': true,
          'downstream_evidence': {
            'resource_type': 'referral',
            'resource_id': 'ref-8',
          },
        });
        return http.Response(
          jsonEncode({
            'success': true,
            'data': {
              'id': 'action-1',
              'generation_id': 'generation-1',
              'task_id': 73,
              'action_kind': 'doctor_disposition',
              'disposition': 'referred',
              'signature_id': 'signature-1',
              'replayed': false,
            },
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    final receipt = await ClinicalInboxApiService.instance
        .recordDiagnosticAction(
          DiagnosticActionCommand(
            generationId: 'generation-1',
            taskId: '73',
            disposition: 'referred',
            clinicalNote: 'Reviewed the complete signed generation.',
            generationSnapshotSha256: snapshotHash,
            downstreamResourceType: 'referral',
            downstreamResourceId: 'ref-8',
          ),
        );

    expect(receipt.actionKind, 'doctor_disposition');
    expect(receipt.signatureId, 'signature-1');
  });

  test('cross-signs the exact post-discharge result obligation', () async {
    final snapshotHash = List.filled(64, 'b').join();
    String? firstIdempotencyKey;
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        expect(request.method, 'POST');
        expect(
          request.url.path,
          endsWith(
            '/emr/44/pending-result-handoffs/'
            '11111111-1111-4111-8111-111111111111/cross-sign',
          ),
        );
        final idempotencyKey = request.headers['idempotency-key'];
        expect(idempotencyKey, isNotEmpty);
        if (firstIdempotencyKey == null) {
          firstIdempotencyKey = idempotencyKey;
        } else {
          expect(idempotencyKey, firstIdempotencyKey);
        }
        expect(jsonDecode(request.body), {
          'generation_id': '22222222-2222-4222-8222-222222222222',
          'diagnostic_action_id': '33333333-3333-4333-8333-333333333333',
          'generation_snapshot_sha256': snapshotHash,
          'attested': true,
        });
        return http.Response(
          jsonEncode({
            'success': true,
            'data': {
              'resolution': {
                'id': '44444444-4444-4444-8444-444444444444',
                'admission_id': 44,
                'handoff_id': '11111111-1111-4111-8111-111111111111',
                'generation_id': '22222222-2222-4222-8222-222222222222',
                'diagnostic_action_id': '33333333-3333-4333-8333-333333333333',
                'pathway_instance_id': '55555555-5555-4555-8555-555555555555',
                'owner_action_id': '66666666-6666-4666-8666-666666666666',
                'action_task_id': 73,
                'tracking_task_id': 72,
                'signature_id': '77777777-7777-4777-8777-777777777777',
                'resolution_action_id': '44444444-4444-4444-8444-444444444444',
                'handoff_state': 'resolved',
                'current_handoff_state': 'resolved',
                'generation_snapshot_sha256': snapshotHash,
                'request_sha256': List.filled(64, 'c').join(),
                'canonical_timeline_event_id':
                    '88888888-8888-4888-8888-888888888888',
                'canonical_audit_event_id':
                    '99999999-9999-4999-8999-999999999999',
                'replayed': false,
              },
            },
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    final command = PostDischargeCrossSignCommand(
      admissionId: 44,
      handoffId: '11111111-1111-4111-8111-111111111111',
      generationId: '22222222-2222-4222-8222-222222222222',
      diagnosticActionId: '33333333-3333-4333-8333-333333333333',
      generationSnapshotSha256: snapshotHash,
      actionTaskId: '73',
    );
    final receipt = await ClinicalInboxApiService.instance
        .crossSignPendingResult(command);
    await ClinicalInboxApiService.instance.crossSignPendingResult(command);

    expect(receipt.actionTaskId, '73');
    expect(receipt.handoffState, 'resolved');
    expect(receipt.generationSnapshotSha256, snapshotHash);
    expect(receipt.replayed, isFalse);
    expect(firstIdempotencyKey, command.idempotencyKey);
  });

  test('reopens a normal result with a reason and idempotency key', () async {
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        expect(request.method, 'POST');
        expect(
          request.url.path,
          endsWith('/clinical-inbox/diagnostic-results/generation-2/reopen'),
        );
        expect(request.headers['idempotency-key'], isNotEmpty);
        expect(jsonDecode(request.body), {
          'reason': 'Doctor requested a discretionary re-review.',
        });
        return http.Response(
          jsonEncode({
            'success': true,
            'data': {
              'id': 'reopen-1',
              'generation_id': 'generation-2',
              'action_kind': 'doctor_reopened',
              'replayed': false,
            },
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    final receipt = await ClinicalInboxApiService.instance
        .reopenDiagnosticResult(
          generationId: 'generation-2',
          reason: 'Doctor requested a discretionary re-review.',
        );

    expect(receipt.actionKind, 'doctor_reopened');
    expect(receipt.generationId, 'generation-2');
  });

  test('parses exact named-owner cross-sign inbox evidence fail-closed', () {
    final hash = List.filled(64, 'd').join();
    final task = ClinicalInboxTask.fromJson({
      'id': 73,
      'status': 'open',
      'assigned_to_uid': 'doctor-1',
      'related_resource_type': 'discharge_pending_result_action',
      'related_resource_id':
          '11111111-1111-4111-8111-111111111111:'
          '22222222-2222-4222-8222-222222222222',
      'diagnostic_generation_id': '22222222-2222-4222-8222-222222222222',
      'diagnostic_classification': 'abnormal',
      'diagnostic_generation_snapshot_sha256': hash,
      'pending_result_admission_id': 44,
      'pending_result_handoff_id': '11111111-1111-4111-8111-111111111111',
      'pending_result_owner_action_id': '33333333-3333-4333-8333-333333333333',
      'pending_result_handoff_state': 'result_available',
      'pending_result_resolution_action_id': null,
      'diagnostic_authoritative_action_id':
          '44444444-4444-4444-8444-444444444444',
      'diagnostic_authoritative_action_kind': 'doctor_disposition',
      'diagnostic_authoritative_disposition': 'referred',
      'diagnostic_authoritative_action_occurred_at': '2026-07-23T12:00:00Z',
      'can_cross_sign': true,
    });

    expect(task.isPostDischargePendingResultReview, isTrue);
    expect(task.needsPostDischargeCrossSign, isTrue);
    expect(task.needsDoctorAction, isFalse);
    expect(task.needsClinicalAction, isTrue);

    final withoutServerAuthority = ClinicalInboxTask.fromJson({
      'id': 74,
      'status': 'open',
      'related_resource_type': 'discharge_pending_result_action',
      'diagnostic_generation_id': task.diagnosticGenerationId,
      'diagnostic_generation_snapshot_sha256': hash,
      'pending_result_admission_id': 44,
      'pending_result_handoff_id': task.pendingResultHandoffId,
      'diagnostic_authoritative_action_id':
          task.diagnosticAuthoritativeActionId,
      'diagnostic_authoritative_action_kind': 'doctor_disposition',
      'diagnostic_authoritative_disposition': 'referred',
    });

    expect(withoutServerAuthority.needsPostDischargeCrossSign, isFalse);
    expect(withoutServerAuthority.needsClinicalAction, isFalse);
  });

  test(
    'parses late-critical continuity awareness as no-SLA acknowledgement work',
    () {
      final task = ClinicalInboxTask.fromJson({
        'id': 81,
        'priority': 'critical',
        'status': 'open',
        'sla_completion_semantics': 'none',
        'due_at': null,
        'external_recovery_critical_review_obligation_id':
            '11111111-1111-4111-8111-111111111111',
        'external_recovery_critical_review_acknowledgement_id': null,
        'external_recovery_interface_family': 'i01',
        'external_recovery_awareness_acknowledgement_required': true,
        'external_recovery_source_occurred_at': '2026-08-01T01:00:00Z',
        'external_recovery_awareness_recorded_at': '2026-08-05T01:00:00Z',
      });

      expect(task.isRecoveredCriticalAwareness, isTrue);
      expect(task.needsAcknowledgement, isTrue);
      expect(task.needsClinicalAction, isTrue);
      expect(task.slaCompletionSemantics, 'none');
      expect(task.dueAt, isNull);
      expect(task.externalRecoveryInterfaceFamily, 'I01');
      expect(
        task.externalRecoverySourceOccurredAt,
        DateTime.parse('2026-08-01T01:00:00Z').toLocal(),
      );

      final forgedSlaShape = ClinicalInboxTask.fromJson({
        'id': 82,
        'priority': 'critical',
        'status': 'open',
        'sla_completion_semantics': 'acknowledgement',
        'due_at': '2026-08-05T01:15:00Z',
        'external_recovery_critical_review_obligation_id':
            '22222222-2222-4222-8222-222222222222',
        'external_recovery_awareness_acknowledgement_required': true,
      });
      expect(forgedSlaShape.isRecoveredCriticalAwareness, isFalse);
    },
  );
}

ClinicalInboxTask _counterSaleVoidTask({
  String taskId = '9223372036854775800',
  String stage = 'approval',
  String status = 'open',
  String requestId = '9223372036854775801',
  String? relatedResourceId,
  String saleId = '9223372036854775802',
  String refundId = '9223372036854775803',
  String invoiceId = '9223372036854775804',
  String? assignedToRole,
  String assignedToUid = '',
  List<String>? ownerRoleCodes,
  String slaInstanceId = '11111111-1111-4111-8111-111111111111',
  String? workflowSlaInstanceId,
  String evidenceKind = 'counter_sale_void_completed',
  String? financeDeepLink,
  String? pharmacyDeepLink,
}) {
  final expectedAssignedRole = switch (stage) {
    'approval' => 'ADMIN',
    'payout' => 'BILLING_INCHARGE',
    'reconciliation' => 'PHARMACY_INCHARGE',
    'rejected_review' => 'ADMIN',
    _ => '',
  };
  final expectedOwnerRoles = switch (stage) {
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
    'status': status,
    'assigned_to_uid': assignedToUid,
    'assigned_to_role': assignedToRole ?? expectedAssignedRole,
    'workflow_sla_instance_id': workflowSlaInstanceId ?? slaInstanceId,
    'sla_completion_semantics': 'domain_evidence',
    'related_resource_type': 'pharmacy_counter_sale_void_requests',
    'related_resource_id': relatedResourceId ?? requestId,
    'metadata': {
      'task_contract': 'counter_sale_void_refund_v1',
      'evidence_kind': evidenceKind,
      'counter_sale_void_request_id': requestId,
      'counter_sale_id': saleId,
      'refund_id': refundId,
      'invoice_id': invoiceId,
      'task_stage': stage,
      'owner_role_codes': ownerRoleCodes ?? expectedOwnerRoles,
      'finance_deep_link':
          financeDeepLink ??
          '/billing/refunds?refund_id=$refundId&void_request_id=$requestId',
      'pharmacy_deep_link':
          pharmacyDeepLink ?? '/pharmacy?tab=counter-sales&sale_id=$saleId',
      'sla_key': 'counter_sale_void_refund',
      'sla_instance_id': slaInstanceId,
    },
  });
}
