import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_staff/core/models/care_pathway_work_models.dart';
import 'package:vhhealth_staff/core/services/care_pathway_api_service.dart';

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

  test('records closure evidence with an exact durable payload', () async {
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        expect(request.method, 'POST');
        expect(request.url.path, endsWith('/appointments/71/closure-evidence'));
        final body = jsonDecode(request.body) as Map<String, dynamic>;
        expect(body['follow_up_required'], isTrue);
        expect(body['follow_up_plan_id'], 81);
        expect(body['closure_basis'], 'named_ownership_accepted');
        expect(body['accepted_handoff_id'], isNull);
        expect(body['patient_safe_next_steps'], [
          {
            'label': 'Attend the booked review',
            'status': 'scheduled',
            'patient_action': 'Bring the medication list.',
          },
        ]);
        expect(body['idempotency_key'], isNotEmpty);
        expect(request.headers['idempotency-key'], body['idempotency_key']);
        return http.Response(
          jsonEncode({
            'success': true,
            'data': {
              'mode': 'active',
              'replayed': false,
              'closure_evidence': {
                'id': 'closure-1',
                'revision': 1,
                'clinician_uid': 'doctor-1',
                'follow_up_required': true,
                'follow_up_plan_id': 81,
                'patient_next_steps': [
                  {'label': 'Attend the booked review', 'status': 'scheduled'},
                ],
                'closure_basis': 'named_ownership_accepted',
              },
            },
          }),
          201,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    final evidence =
        await CarePathwayApiService.recordAppointmentClosureEvidence(
          appointmentId: 71,
          command: const OpClosureEvidenceCommand(
            followUpRequired: true,
            followUpPlanId: 81,
            closureBasis: 'named_ownership_accepted',
            patientSafeNextSteps: [
              PatientSafeNextStepCommand(
                label: 'Attend the booked review',
                status: 'scheduled',
                patientAction: 'Bring the medication list.',
              ),
            ],
          ),
        );

    expect(evidence.id, 'closure-1');
    expect(evidence.followUpPlanId, '81');
  });

  test('uses exact inpatient pending-result evidence routes', () async {
    var requestCount = 0;
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        requestCount += 1;
        final path = request.url.path;
        final body = request.body.isEmpty
            ? <String, dynamic>{}
            : jsonDecode(request.body) as Map<String, dynamic>;
        if (path.endsWith('/emr/44/pending-results')) {
          expect(request.method, 'GET');
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {
                'mode': 'active',
                'pending_results': {
                  'projection_ready': true,
                  'items': [
                    {
                      'resource_reference_id':
                          '11111111-1111-4111-8111-111111111111',
                      'source_type': 'lab_result',
                      'source_id': '91',
                      'patient_safe_label': 'Blood count',
                      'handoff': null,
                    },
                  ],
                },
                'evidence': {
                  'structured_signed_summary': {'id': 701},
                },
                'active_blockers': [],
              },
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }
        if (path.endsWith('/emr/44/pending-result-handoffs')) {
          expect(request.method, 'POST');
          expect(body['source_type'], 'lab_result');
          expect(body['source_id'], '91');
          expect(body['resource_reference_id'], isNotEmpty);
          expect(body['idempotency_key'], request.headers['idempotency-key']);
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {
                'handoff': {'id': 'handoff-1'},
              },
            }),
            201,
            headers: {'content-type': 'application/json'},
          );
        }
        if (path.endsWith(
          '/emr/44/pending-result-handoffs/handoff-1/summary-inclusion',
        )) {
          expect(request.method, 'PUT');
          expect(body, {'discharge_summary_id': 701});
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {
                'handoff': {'id': 'handoff-1'},
              },
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }
        expect(path, endsWith('/emr/44/follow-up-exception'));
        expect(request.method, 'POST');
        expect(body['reason'], 'Patient will follow locally.');
        expect(body['idempotency_key'], request.headers['idempotency-key']);
        return http.Response(
          jsonEncode({
            'success': true,
            'data': {
              'exception': {'admission_id': 44},
            },
          }),
          201,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    final work = await CarePathwayApiService.getAdmissionPendingResults(44);
    expect(work.isActive, isTrue);
    expect(work.signedSummaryId, 701);
    expect(work.items.single.canCreateNamedOwnerHandoff, isTrue);

    await CarePathwayApiService.createPendingResultHandoff(
      admissionId: 44,
      sourceType: 'lab_result',
      sourceId: '91',
      resourceReferenceId: '11111111-1111-4111-8111-111111111111',
      patientSafeLabel: 'Blood count',
    );
    await CarePathwayApiService.bindPendingResultToSignedSummary(
      admissionId: 44,
      handoffId: 'handoff-1',
      dischargeSummaryId: 701,
    );
    await CarePathwayApiService.recordFollowUpException(
      admissionId: 44,
      reason: 'Patient will follow locally.',
    );
    expect(requestCount, 4);
  });

  test(
    'requests and accepts OP-to-inpatient transfer with accepted tuple',
    () async {
      var accepted = false;
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          expect(request.headers['idempotency-key'], isNotEmpty);
          if (request.url.path.endsWith(
            '/appointments/71/inpatient-transfer-requests',
          )) {
            expect(jsonDecode(request.body), {
              'intended_recipient_uid': '22222222-2222-4222-8222-222222222222',
              'reason': 'Requires inpatient monitoring.',
            });
          } else {
            accepted = true;
            expect(
              request.url.path,
              endsWith(
                '/appointments/71/inpatient-transfer-requests/33333333-3333-4333-8333-333333333333/accept',
              ),
            );
            expect(jsonDecode(request.body), <String, dynamic>{});
          }
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {
                'handoff': {
                  'id': '33333333-3333-4333-8333-333333333333',
                  'status': accepted ? 'accepted' : 'requested',
                },
                'task': {
                  'id': 901,
                  'task_kind': 'op_to_inpatient_transfer_review',
                  'status': accepted ? 'completed' : 'open',
                },
                'transition': {
                  'transition_key': accepted
                      ? 'op_to_inpatient_transfer_accepted'
                      : 'op_to_inpatient_transfer_requested',
                },
                'admission_source': {
                  'appointment_id': 71,
                  'source_pathway_instance_id':
                      '44444444-4444-4444-8444-444444444444',
                  'source_handoff_id': '33333333-3333-4333-8333-333333333333',
                  'accepted_recipient_uid': accepted
                      ? '22222222-2222-4222-8222-222222222222'
                      : null,
                },
                'replayed': false,
              },
            }),
            accepted ? 200 : 201,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      final requested = await CarePathwayApiService.requestInpatientTransfer(
        appointmentId: 71,
        intendedRecipientUid: '22222222-2222-4222-8222-222222222222',
        reason: 'Requires inpatient monitoring.',
      );
      expect(requested.admissionSource.isAccepted, isFalse);

      final receipt = await CarePathwayApiService.acceptInpatientTransfer(
        appointmentId: 71,
        handoffId: '33333333-3333-4333-8333-333333333333',
      );
      expect(receipt.admissionSource.isAccepted, isTrue);
      expect(receipt.admissionSource.appointmentId, 71);
    },
  );

  test('preserves pathway error code for owner conflict UX', () async {
    VHHttpClient.setClientForTesting(
      MockClient(
        (_) async => http.Response(
          jsonEncode({
            'success': false,
            'message': 'Current pathway owner changed',
            'code': 'OP_CLOSURE_CURRENT_OWNER_REQUIRED',
          }),
          409,
          headers: {'content-type': 'application/json'},
        ),
      ),
    );

    await expectLater(
      CarePathwayApiService.getAppointmentPathwayWork(71),
      throwsA(
        isA<CarePathwayApiException>()
            .having(
              (error) => error.code,
              'code',
              'OP_CLOSURE_CURRENT_OWNER_REQUIRED',
            )
            .having(
              (error) => error.toString(),
              'display',
              contains('OP_CLOSURE_CURRENT_OWNER_REQUIRED'),
            ),
      ),
    );
  });
}
