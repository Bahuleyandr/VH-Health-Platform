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
