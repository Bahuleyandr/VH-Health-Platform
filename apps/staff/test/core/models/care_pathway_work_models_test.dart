import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/models/care_pathway_work_models.dart';

void main() {
  group('appointment pathway work', () {
    test('parses gates, unresolved items, and closure evidence', () {
      final work = AppointmentPathwayWork.fromJson({
        'mode': 'active',
        'visit_completion': {
          'allowed': false,
          'blockers': [
            {
              'code': 'UNOWNED_CHILD_WORK',
              'message': 'Assign the pending investigation to a named owner.',
            },
          ],
        },
        'pathway_closure': {'allowed': false, 'blockers': []},
        'items': [
          {
            'resource_type': 'investigation',
            'id': '91',
            'relationship_kind': 'child_action',
            'evidence_state': 'open',
            'blocking': true,
            'owner_uid': 'doctor-7',
            'owner_name': 'Dr Meera Shah',
            'owner_role': 'Consultant',
            'route': 'investigations',
          },
          {
            'resource_type': 'referral',
            'id': 'ref-4',
            'relationship_kind': 'child_action',
            'evidence_state': 'ownership_accepted',
            'blocking': false,
            'handoff_id': 'handoff-4',
          },
        ],
        'prior_admission_pending_results': [
          {
            'admission_id': 44,
            'handoff_id': '11111111-1111-4111-8111-111111111111',
            'source_type': 'lab_result',
            'patient_safe_label': 'Complete blood count',
            'result_status': 'available',
            'handoff_state': 'result_available',
            'requires_action': true,
            'can_cross_sign': true,
            'named_owner': {
              'uid': 'doctor-9',
              'display_name': 'Dr Nikhil Rao',
              'role': 'DOCTOR',
            },
            'generation_id': '22222222-2222-4222-8222-222222222222',
            'generation_snapshot_sha256':
                'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            'diagnostic_classification': 'abnormal',
            'diagnostic_action_id': '33333333-3333-4333-8333-333333333333',
            'diagnostic_action_kind': 'doctor_disposition',
            'diagnostic_disposition': 'referred',
            'diagnostic_action_occurred_at': '2026-07-23T12:00:00Z',
            'tracking_task': {'id': 91, 'status': 'open'},
            'action_task': {'id': 92, 'status': 'open'},
            'task': {'id': 92, 'status': 'open'},
            'route': 'investigations',
            'patient_uid': 'must-not-be-used',
            'metadata': {'internal': true},
          },
        ],
        'closure_evidence': {
          'id': 'closure-1',
          'evidence_revision': 3,
          'clinician_uid': 'doctor-7',
          'follow_up_required': true,
          'follow_up_plan_id': 'follow-up-9',
          'patient_safe_next_steps': [
            {
              'label': 'Booked follow-up',
              'patient_action': 'Attend the booked follow-up.',
              'route_token': 'appointments',
            },
          ],
          'closure_basis': 'named_ownership_accepted',
          'recorded_at': '2026-07-23T10:00:00Z',
        },
      });

      expect(work.mode, 'active');
      expect(work.isActive, isTrue);
      expect(work.visitCompletion.allowed, isFalse);
      expect(work.visitCompletion.blockers.single.code, 'UNOWNED_CHILD_WORK');
      expect(work.unresolvedItems, hasLength(1));
      expect(work.unresolvedItems.single.resourceType, 'investigation');
      expect(work.unresolvedItems.single.hasNamedOwner, isTrue);
      expect(work.items.last.isResolved, isTrue);
      expect(work.priorAdmissionPendingResults, hasLength(1));
      expect(
        work.priorAdmissionPendingResults.single.patientSafeLabel,
        'Complete blood count',
      );
      expect(work.priorAdmissionPendingResults.single.requiresAction, isTrue);
      expect(work.priorAdmissionPendingResults.single.canCrossSign, isTrue);
      expect(work.priorAdmissionPendingResults.single.needsCrossSign, isTrue);
      expect(
        work.priorAdmissionPendingResults.single.diagnosticDisposition,
        'referred',
      );
      expect(work.priorAdmissionPendingResults.single.actionTaskId, 92);
      expect(work.priorAdmissionPendingResults.single.taskId, 92);
      expect(work.closureEvidence?.revision, 3);
      expect(
        work.closureEvidence?.patientNextSteps.single.patientAction,
        'Attend the booked follow-up.',
      );
    });

    test('defaults missing gates to allowed legacy behavior', () {
      final work = AppointmentPathwayWork.fromJson({
        'mode': 'off',
        'items': const [
          {
            'resource_type': 'referral',
            'id': 'ref-without-owner',
            'evidence_state': 'ownership_accepted',
            'blocking': false,
          },
        ],
      });

      expect(work.visitCompletion.allowed, isTrue);
      expect(work.pathwayClosure.allowed, isTrue);
      expect(work.unresolvedItems, hasLength(1));
      expect(work.priorAdmissionPendingResults, isEmpty);
    });

    test('keeps auto-settled and resolved pending results read-only', () {
      final work = AppointmentPathwayWork.fromJson({
        'mode': 'active',
        'prior_admission_pending_results': [
          {
            'admission_id': 44,
            'handoff_id': '11111111-1111-4111-8111-111111111111',
            'patient_safe_label': 'Complete blood count',
            'result_status': 'reviewed',
            'handoff_state': 'resolved',
            'requires_action': false,
            'can_cross_sign': false,
            'named_owner': {'uid': 'doctor-9', 'role': 'DOCTOR'},
            'generation_id': '22222222-2222-4222-8222-222222222222',
            'generation_snapshot_sha256':
                'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            'diagnostic_classification': 'normal',
            'resolution_action_id': '44444444-4444-4444-8444-444444444444',
            'tracking_task': {'id': 91, 'status': 'completed'},
            'action_task': {'id': 92, 'status': 'completed'},
          },
        ],
      });

      final result = work.priorAdmissionPendingResults.single;
      expect(result.handoffState, 'resolved');
      expect(result.canCrossSign, isFalse);
      expect(result.needsCrossSign, isFalse);
      expect(result.resolutionActionId, isNotEmpty);
    });
  });

  group('inpatient pathway presentation models', () {
    test('parses exact pending-result ownership and blocker state', () {
      final handoff = DischargePendingResultHandoff.fromJson({
        'source_type': 'radiology_order',
        'source_id': 'rad-22',
        'resource_reference_id': '11111111-1111-4111-8111-111111111111',
        'patient_safe_label': 'CT chest report',
        'current_status': 'awaiting_report',
        'exact_lineage': true,
        'primary_physician': {
          'uid': 'doctor-10',
          'display_name': 'Dr Asha Menon',
          'role': 'Primary physician',
        },
        'named_owner': {
          'uid': 'doctor-11',
          'display_name': 'Dr Nikhil Rao',
          'role': 'Primary physician',
        },
        'handoff': {
          'id': '22222222-2222-4222-8222-222222222222',
          'state': 'accepted',
          'task_id': 91,
          'summary_included_at': '2026-07-23T09:00:00Z',
        },
        'summary_included': true,
        'handoff_complete': true,
        'handoff_complete_warning': true,
        'blocking': false,
        'blocker_codes': const [],
        'internal_comment': 'must never be presented',
      });

      expect(handoff.safeLabel, 'CT chest report');
      expect(handoff.currentStatus, 'awaiting_report');
      expect(handoff.exactLineage, isTrue);
      expect(handoff.ownerName, 'Dr Nikhil Rao');
      expect(handoff.ownerRole, 'Primary physician');
      expect(handoff.ownerRoute, isNull);
      expect(handoff.summaryIncluded, isTrue);
      expect(handoff.handoffComplete, isTrue);
      expect(handoff.handoffCompleteWarning, isTrue);
      expect(handoff.blocking, isFalse);
      expect(handoff.handoffId, '22222222-2222-4222-8222-222222222222');
      expect(handoff.handoffTaskId, 91);
      expect(handoff.canCreateNamedOwnerHandoff, isFalse);
      expect(handoff.canBindSignedSummary, isFalse);
    });

    test('parses command-board relationship, blocking, and named owner', () {
      final task = CarePathwayTaskItem.fromJson({
        'label': 'Review pending result',
        'kind': 'diagnostic_follow_up',
        'status': 'open',
        'priority': 'high',
        'relationship_kind': 'child_action',
        'blocking_state': 'result_action',
        'route': 'discharge_hub',
        'named_owner': {
          'uid': 'doctor-10',
          'display_name': 'Dr Nikhil Rao',
          'role': 'Primary physician',
        },
        'comments': 'not a presentation field',
      });

      expect(task.relationship, 'child_action');
      expect(task.blockingState, 'result_action');
      expect(task.isBlocking, isFalse);
      expect(task.ownerName, 'Dr Nikhil Rao');
      expect(task.ownerUid, 'doctor-10');
      expect(task.ownerRole, 'Primary physician');
      expect(task.ownerRoute, 'discharge_hub');
    });

    test('keeps route tokens separate from owner identity', () {
      final task = CarePathwayTaskItem.fromJson({
        'label': 'Review order',
        'kind': 'review',
        'status': 'open',
        'priority': 'normal',
        'route': 'orders',
        'named_owner': {'uid': 'doctor-12'},
      });

      expect(task.ownerUid, 'doctor-12');
      expect(task.ownerName, isNull);
      expect(task.ownerRoute, 'orders');
    });
  });
}
