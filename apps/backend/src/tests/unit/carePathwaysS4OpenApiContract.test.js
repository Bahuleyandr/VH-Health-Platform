import Ajv from 'ajv';
import addFormats from 'ajv-formats';

import { operations, schemas } from '../../../scripts/openapi/schemas/carePathways.mjs';
import {
  operations as emrOperations,
  schemas as emrSchemas,
} from '../../../scripts/openapi/schemas/emr.mjs';
import { ajvReadySpec } from '../helpers/openapiToAjv.js';

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(
  ajvReadySpec({
    components: { schemas },
  }),
  'care-pathways-s4-openapi',
);

function validatorFor(name) {
  const validate = ajv.getSchema(`care-pathways-s4-openapi#/components/schemas/${name}`);
  if (!validate) {
    throw new Error(`Missing care-pathway OpenAPI schema: ${name}`);
  }
  return validate;
}

const physicianUid = '550e8400-e29b-41d4-a716-446655440000';
const actorUid = '550e8400-e29b-41d4-a716-446655440001';
const assignmentId = '550e8400-e29b-41d4-a716-446655440002';
const pathwayId = '550e8400-e29b-41d4-a716-446655440003';
const referenceId = '550e8400-e29b-41d4-a716-446655440004';
const handoffId = '550e8400-e29b-41d4-a716-446655440005';
const generationId = '550e8400-e29b-41d4-a716-446655440006';
const evidenceId = '550e8400-e29b-41d4-a716-446655440007';
const timelineId = '550e8400-e29b-41d4-a716-446655440008';
const auditId = '550e8400-e29b-41d4-a716-446655440009';
const diagnosticActionId = '550e8400-e29b-41d4-a716-44665544000a';

const safeNextStep = {
  label: 'Complete the blood test',
  explanation: 'Please complete this test before your follow-up visit.',
  due_date: '2026-07-30',
  status: 'scheduled',
  patient_action: 'Visit the laboratory with your order.',
  route_token: 'lab_results',
  responsible_clinician_display_name: 'Dr Meera Rao',
  responsible_clinician_role: 'DOCTOR',
  safe_contact: 'support@example.test',
};

const appointmentPathwayWork = {
  mode: 'active',
  projection_pending: false,
  configuration: {
    mode: 'active',
    projection_pending: false,
    completeness_checked: true,
    completeness_proven: true,
    exact_source_count: 1,
    child_event_count: 1,
    valid_child_event_count: 1,
    missing_source_event_count: 0,
    pending_child_projection_count: 0,
    invalid_child_event_count: 0,
    child_state_mismatch_count: 0,
    unsupported_historical_source_types: [],
    pathway_instance_id: pathwayId,
    pathway_clinical_status: 'active',
  },
  visit_completion: {
    allowed: true,
    blockers: [],
  },
  pathway_closure: {
    allowed: true,
    blockers: [],
  },
  items: [
    {
      resource_type: 'lab_result',
      id: '41',
      relationship_kind: 'child_action',
      evidence_state: 'ownership_accepted',
      blocking: true,
      owner_uid: physicianUid,
      owner_name: 'Dr Meera Rao',
      owner_role: 'DOCTOR',
      task_id: 91,
      handoff_id: null,
      route: 'investigations',
      source_evidence_state: 'ownership_accepted',
    },
  ],
  prior_admission_pending_results: [
    {
      admission_id: 73,
      handoff_id: handoffId,
      source_type: 'lab_result',
      patient_safe_label: 'Complete blood count',
      result_status: 'available',
      handoff_state: 'result_available',
      requires_action: true,
      can_cross_sign: true,
      named_owner: {
        uid: physicianUid,
        display_name: 'Dr Meera Rao',
        role: 'DOCTOR',
      },
      generation_id: generationId,
      generation_snapshot_sha256: 'a'.repeat(64),
      diagnostic_classification: 'abnormal',
      diagnostic_action_id: diagnosticActionId,
      diagnostic_action_kind: 'doctor_disposition',
      diagnostic_disposition: 'treated',
      diagnostic_action_occurred_at: '2026-07-23T08:20:00.000Z',
      resolution_action_id: null,
      resolved_at: null,
      resolved_by_uid: null,
      tracking_task: {
        id: 91,
        status: 'in_progress',
      },
      action_task: {
        id: 92,
        status: 'open',
      },
      task: {
        id: 92,
        status: 'open',
      },
      route: 'investigations',
    },
  ],
  closure_evidence: {
    id: evidenceId,
    revision: 1,
    clinician_uid: physicianUid,
    follow_up_required: true,
    follow_up_plan_id: 31,
    patient_next_steps: [safeNextStep],
    closure_basis: 'all_required_work_completed',
    accepted_handoff_id: null,
    source_status_history_id: '9876543210',
    occurred_at: '2026-07-23T08:30:00.000Z',
    recorded_at: '2026-07-23T08:31:00.000Z',
  },
};

const pendingResultItem = {
  resource_reference_id: referenceId,
  source_type: 'lab_result',
  source_id: '41',
  patient_safe_label: 'Complete blood count',
  current_status: 'pending',
  exact_lineage: true,
  evidence_state: 'ownership_accepted',
  primary_physician: {
    assignment_id: assignmentId,
    uid: physicianUid,
    display_name: 'Dr Meera Rao',
    role: 'DOCTOR',
  },
  named_owner: {
    uid: physicianUid,
    display_name: 'Dr Meera Rao',
    role: 'DOCTOR',
  },
  handoff: {
    id: handoffId,
    state: 'pending',
    task_id: 91,
    named_physician_uid: physicianUid,
    named_physician_name: 'Dr Meera Rao',
    summary_id: 72,
    summary_included_at: '2026-07-23T08:15:00.000Z',
    resolution_generation_id: null,
    resolution_action_id: null,
    resolved_at: null,
    resolved_by_uid: null,
  },
  handoff_complete_warning: true,
  handoff_complete: true,
  summary_included: true,
  blocking: false,
  blocker_codes: [],
};

const pendingResults = {
  projection_ready: true,
  pathway_instance_id: pathwayId,
  references_found: 1,
  references_expected: 1,
  missing_reference_count: 0,
  unresolved_reference_count: 0,
  reconciliation_debt: [],
  items: [pendingResultItem],
};

const pendingResultHandoff = {
  id: handoffId,
  admission_id: 73,
  resource_reference_id: referenceId,
  source_type: 'lab_result',
  source_id: '41',
  patient_safe_label: 'Complete blood count',
  result_status: 'pending',
  primary_physician_assignment_id: assignmentId,
  named_physician_uid: physicianUid,
  task_id: 91,
  handoff_state: 'pending',
  discharge_summary_id: null,
  summary_included_at: null,
  resolution_generation_id: null,
  resolution_action_id: null,
  resolved_at: null,
  resolved_by_uid: null,
  created_at: '2026-07-23T08:05:00.000Z',
  updated_at: '2026-07-23T08:05:00.000Z',
};

const pendingResultActionTask = {
  id: 92,
  task_kind: 'review',
  title: 'Review Complete blood count',
  description: 'A result pending at discharge is now available for the named physician.',
  status: 'open',
  assigned_to_uid: physicianUid,
  related_resource_type: 'discharge_pending_result_action',
  related_resource_id: `${handoffId}:${generationId}`,
  parent_task_id: 91,
  created_at: '2026-07-24T08:05:00.000Z',
  updated_at: '2026-07-24T08:05:00.000Z',
};

const pendingResultOwnerAction = {
  id: evidenceId,
  handoff_id: handoffId,
  generation_id: generationId,
  predecessor_generation_id: null,
  predecessor_owner_action_id: null,
  predecessor_resolution_action_id: null,
  rearm_source_action_id: null,
  task_id: 92,
  owner_uid: physicianUid,
  recorded_at: '2026-07-24T08:05:00.000Z',
};

const dischargeClosureSection = (sectionId, sectionKey) => ({
  discharge_summary_id: 72,
  section_id: sectionId,
  section_key: sectionKey,
});

const inpatientWork = {
  mode: 'active',
  primary_physician_assignment: {
    id: assignmentId,
    assignment_version: 1,
    physician_uid: physicianUid,
    assignment_source: 'attending_physician',
    accepted_handoff_id: null,
    supersedes_assignment_id: null,
    assigned_by_uid: actorUid,
    assigned_at: '2026-07-20T08:00:00.000Z',
    physician_name: 'Dr Meera Rao',
    physician_role: 'DOCTOR',
  },
  pending_results: pendingResults,
  evidence: {
    structured_signed_summary: {
      id: 72,
      status: 'signed',
      signed_by: physicianUid,
      signed_at: '2026-07-23T08:00:00.000Z',
    },
    patient_guardian_instructions: dischargeClosureSection(
      801,
      'patient_guardian_instructions',
    ),
    escalation_contact: dischargeClosureSection(802, 'escalation_contact'),
    required_equipment_home_care: dischargeClosureSection(
      803,
      'required_equipment_home_care',
    ),
    discharge_destination: dischargeClosureSection(804, 'discharge_destination'),
    transport_plan: dischargeClosureSection(805, 'transport_plan'),
    formal_discharge_medication_reconciliation: {
      id: generationId,
      status: 'completed',
      completed_by: physicianUid,
      completed_at: '2026-07-23T07:50:00.000Z',
    },
    admission_scoped_follow_up: null,
    audited_follow_up_exception: {
      timeline_event_id: timelineId,
      audit_event_id: auditId,
      reason: 'The patient declined a follow-up booking.',
    },
    pending_results: pendingResults,
  },
  active_blockers: [],
};

const postDischargeContact = {
  id: evidenceId,
  admission_id: 73,
  event_kind: 'outcome',
  contact_source: 'manual',
  contact_channel: 'phone',
  outcome_code: 'reached',
  patient_safe_summary: 'Patient reports recovery is progressing.',
  policy_rule_code: null,
  occurred_at: '2026-07-24T09:00:00.000Z',
  recorded_at: '2026-07-24T09:01:00.000Z',
};

describe('S4 OP and inpatient OpenAPI contracts', () => {
  it('compiles every care-pathway schema and resolves local references', () => {
    for (const name of Object.keys(schemas)) {
      expect(validatorFor(name)).toBeTruthy();
    }
  });

  it('maps the stable S4 routes to strict typed contracts', () => {
    expect(operations['GET /api/v1/appointments/{id}/pathway-work']).toMatchObject({
      response: 'AppointmentPathwayWorkResponse',
      pathParameters: { id: { type: 'integer', minimum: 1 } },
    });
    expect(operations['POST /api/v1/appointments/{id}/closure-evidence']).toMatchObject({
      request: 'OpVisitClosureEvidenceRequest',
      response: 'OpVisitClosureEvidenceMutationResponse',
      responseStatus: 201,
      description: expect.stringMatching(/201.*replay.*200/i),
    });
    expect(
      operations['POST /api/v1/appointments/{id}/inpatient-transfer-requests'],
    ).toMatchObject({
      request: 'OpInpatientTransferRequest',
      response: 'OpInpatientTransferResponse',
      responseStatus: 201,
      description: expect.stringMatching(/201.*replay.*200/i),
      pathParameters: { id: { type: 'integer', minimum: 1 } },
      parameters: [
        expect.objectContaining({
          name: 'Idempotency-Key',
          in: 'header',
          required: true,
        }),
      ],
    });
    expect(
      operations[
        'POST /api/v1/appointments/{id}/inpatient-transfer-requests/{handoffId}/accept'
      ],
    ).toMatchObject({
      request: 'OpInpatientTransferAcceptRequest',
      response: 'OpInpatientTransferResponse',
      description: expect.stringMatching(/replay.*200/i),
      pathParameters: {
        id: { type: 'integer', minimum: 1 },
        handoffId: { type: 'string', format: 'uuid' },
      },
    });
    expect(operations['GET /api/v1/admissions/{id}/pending-results']).toMatchObject({
      response: 'InpatientPendingResultWorkResponse',
    });
    expect(operations['POST /api/v1/admissions/{id}/pending-result-handoffs']).toMatchObject({
      request: 'InpatientPendingResultHandoffRequest',
      response: 'InpatientPendingResultHandoffMutationResponse',
      responseStatus: 201,
      description: expect.stringMatching(/replay.*201/i),
    });
    expect(
      operations[
        'PUT /api/v1/admissions/{id}/pending-result-handoffs/{handoffId}/summary-inclusion'
      ],
    ).toMatchObject({
      request: 'InpatientPendingResultSummaryInclusionRequest',
      response: 'InpatientPendingResultHandoffMutationResponse',
    });
    expect(
      operations[
        'POST /api/v1/admissions/{id}/pending-result-handoffs/{handoffId}/result-available'
      ],
    ).toMatchObject({
      request: 'InpatientPendingResultAvailableRequest',
      response: 'InpatientPendingResultAvailableResponse',
      description: expect.stringMatching(/repeated.*200.*action_task null/i),
    });
    for (const prefix of ['/api/v1/emr', '/api/v1/admissions']) {
      expect(
        operations[
          `POST ${prefix}/{id}/pending-result-handoffs/{handoffId}/cross-sign`
        ],
      ).toMatchObject({
        request: 'InpatientPendingResultCrossSignRequest',
        response: 'InpatientPendingResultCrossSignResponse',
        pathParameters: {
          id: { type: 'integer', minimum: 1 },
          handoffId: { type: 'string', format: 'uuid' },
        },
        parameters: [
          expect.objectContaining({
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
          }),
        ],
      });
    }
    expect(operations['POST /api/v1/admissions/{id}/follow-up-exception']).toMatchObject({
      request: 'InpatientFollowUpExceptionRequest',
      response: 'InpatientFollowUpExceptionMutationResponse',
      responseStatus: 201,
    });
    expect(operations['GET /api/v1/admissions/{id}/post-discharge-contacts']).toMatchObject({
      response: 'PostDischargeContactListResponse',
    });
    expect(operations['POST /api/v1/admissions/{id}/post-discharge-contacts']).toMatchObject({
      request: 'PostDischargeContactRequest',
      response: 'PostDischargeContactMutationResponse',
      responseStatus: 201,
      description: expect.stringMatching(/replay.*201/i),
    });
    expect(emrSchemas.EmrAttendingDoctorRequest).toEqual({
      type: 'object',
      additionalProperties: true,
      required: ['doctor_uid'],
      properties: {
        doctor_uid: { type: 'string', format: 'uuid' },
        accepted_handoff_id: {
          type: 'string',
          format: 'uuid',
          nullable: true,
        },
      },
    });
    for (const prefix of ['/api/v1/emr', '/api/v1/admissions']) {
      expect(emrOperations[`PUT ${prefix}/{id}/attending-doctor`]).toMatchObject({
        request: 'EmrAttendingDoctorRequest',
        response: 'EmrAdmissionMutationResponse',
      });
    }

    for (const methodSuffix of [
      'GET /{id}/pending-results',
      'POST /{id}/pending-result-handoffs',
      'PUT /{id}/pending-result-handoffs/{handoffId}/summary-inclusion',
      'POST /{id}/pending-result-handoffs/{handoffId}/result-available',
      'POST /{id}/pending-result-handoffs/{handoffId}/cross-sign',
      'POST /{id}/follow-up-exception',
      'GET /{id}/post-discharge-contacts',
      'POST /{id}/post-discharge-contacts',
    ]) {
      const separator = methodSuffix.indexOf(' ');
      const method = methodSuffix.slice(0, separator);
      const suffix = methodSuffix.slice(separator + 1);
      expect(operations[`${method} /api/v1/emr${suffix}`]).toBe(
        operations[`${method} /api/v1/admissions${suffix}`],
      );
    }
  });

  it('accepts the exact staff appointment projection and rejects enrichment', () => {
    const validate = validatorFor('AppointmentPathwayWorkResponse');
    const pendingResultValidate = validatorFor('OpFollowUpPendingResult');
    expect(validate({ success: true, data: appointmentPathwayWork })).toBe(true);
    expect(
      pendingResultValidate({
        ...appointmentPathwayWork.prior_admission_pending_results[0],
        result_status: 'awaiting_result',
        handoff_state: 'pending',
        requires_action: false,
        can_cross_sign: false,
        generation_id: null,
        generation_snapshot_sha256: null,
        diagnostic_classification: null,
        diagnostic_action_id: null,
        diagnostic_action_kind: null,
        diagnostic_disposition: null,
        diagnostic_action_occurred_at: null,
        action_task: null,
        task: appointmentPathwayWork.prior_admission_pending_results[0].tracking_task,
      }),
    ).toBe(true);
    expect(
      pendingResultValidate({
        ...appointmentPathwayWork.prior_admission_pending_results[0],
        result_status: 'reviewed',
        handoff_state: 'resolved',
        requires_action: false,
        can_cross_sign: false,
        resolution_action_id: auditId,
        resolved_at: '2026-07-23T08:40:00.000Z',
        resolved_by_uid: physicianUid,
        tracking_task: { id: 91, status: 'completed' },
        action_task: { id: 92, status: 'completed' },
        task: { id: 92, status: 'completed' },
      }),
    ).toBe(true);
    expect(
      validate({
        success: true,
        data: {
          mode: 'off',
          projection_pending: false,
          configuration: {
            mode: 'off',
            projection_pending: false,
            completeness_checked: false,
            completeness_proven: false,
            exact_source_count: 0,
            child_event_count: 0,
            valid_child_event_count: 0,
            missing_source_event_count: 0,
            pending_child_projection_count: 0,
            invalid_child_event_count: 0,
            child_state_mismatch_count: 0,
            unsupported_historical_source_types: [],
            pathway_instance_id: null,
            pathway_clinical_status: null,
          },
          visit_completion: { allowed: true, blockers: [] },
          pathway_closure: { allowed: true, blockers: [] },
          items: [],
          prior_admission_pending_results: [],
          closure_evidence: null,
        },
      }),
    ).toBe(true);
    expect(
      validatorFor('AppointmentPathwayWorkItem')({
        ...appointmentPathwayWork.items[0],
        configuration_issue: 'child_projection_pending',
        source_evidence_state: null,
      }),
    ).toBe(true);
    expect(
      validatorFor('AppointmentPathwayWorkBlocker')({
        code: 'APPOINTMENT_PATHWAY_CHILD_PROJECTION_PENDING',
        message: 'lab_result work is linked but not projected',
        resource_type: 'lab_result',
        resource_id: '41',
      }),
    ).toBe(true);
    expect(
      pendingResultValidate({
        ...appointmentPathwayWork.prior_admission_pending_results[0],
        patient_uid: actorUid,
      }),
    ).toBe(false);
    expect(
      pendingResultValidate({
        ...appointmentPathwayWork.prior_admission_pending_results[0],
        metadata: { admission_id: 73 },
      }),
    ).toBe(false);
    expect(
      pendingResultValidate({
        ...appointmentPathwayWork.prior_admission_pending_results[0],
        clinical_note: 'Must remain outside the OP worklist contract',
      }),
    ).toBe(false);
    expect(
      validate({
        success: true,
        data: {
          ...appointmentPathwayWork,
          internal_notes: 'Not part of the staff contract',
        },
      }),
    ).toBe(false);
  });

  it('keeps OP closure authoring patient-safe and enforces evidence choices', () => {
    const validate = validatorFor('OpVisitClosureEvidenceRequest');
    const request = {
      follow_up_required: true,
      follow_up_plan_id: 31,
      patient_safe_next_steps: [
        {
          label: safeNextStep.label,
          explanation: safeNextStep.explanation,
          due_date: safeNextStep.due_date,
          status: safeNextStep.status,
          patient_action: safeNextStep.patient_action,
          route_token: safeNextStep.route_token,
        },
      ],
      closure_basis: 'all_required_work_completed',
    };

    expect(validate(request)).toBe(true);
    expect(
      validate({
        ...request,
        follow_up_required: false,
        follow_up_plan_id: 31,
      }),
    ).toBe(false);
    expect(
      validate({
        ...request,
        closure_basis: 'accepted_transfer',
      }),
    ).toBe(false);
    expect(
      validate({
        ...request,
        patient_safe_next_steps: [
          {
            ...request.patient_safe_next_steps[0],
            staff_comment: 'Do not expose this field',
          },
        ],
      }),
    ).toBe(false);
    expect(
      validate({
        ...request,
        patient_next_steps: request.patient_safe_next_steps,
      }),
    ).toBe(false);
  });

  it('keeps OP-to-inpatient transfer requests and results exact and staff-safe', () => {
    const validateRequest = validatorFor('OpInpatientTransferRequest');
    expect(
      validateRequest({
        intended_recipient_uid: physicianUid,
        reason: 'Requires monitored inpatient treatment',
      }),
    ).toBe(true);
    expect(
      validateRequest({
        intended_recipient_uid: physicianUid,
        reason: 'Contains\ncontrol text',
      }),
    ).toBe(false);
    expect(
      validateRequest({
        intended_recipient_uid: physicianUid,
        reason: 'Requires monitored inpatient treatment',
        patient_uid: actorUid,
      }),
    ).toBe(false);

    const validateAccept = validatorFor('OpInpatientTransferAcceptRequest');
    expect(validateAccept({})).toBe(true);
    expect(validateAccept({ accepted: true })).toBe(false);

    const requested = {
      handoff: {
        id: handoffId,
        status: 'requested',
        requested_at: '2026-07-23T08:00:00.000Z',
        accepted_at: null,
      },
      task: {
        id: 91,
        task_kind: 'op_to_inpatient_transfer_review',
        priority: 'normal',
        status: 'open',
      },
      transition: {
        transition_key: 'op_to_inpatient_transfer_requested',
        occurred_at: '2026-07-23T08:00:00.000Z',
      },
      admission_source: {
        appointment_id: 73,
        source_pathway_instance_id: pathwayId,
        source_handoff_id: handoffId,
        accepted_recipient_uid: null,
      },
      replayed: false,
    };
    const validateResponse = validatorFor('OpInpatientTransferResponse');
    expect(validateResponse({ success: true, data: requested })).toBe(true);
    expect(
      validateResponse({
        success: true,
        data: {
          ...requested,
          handoff: {
            ...requested.handoff,
            status: 'accepted',
            accepted_at: '2026-07-23T08:05:00.000Z',
          },
          task: { ...requested.task, status: 'completed' },
          transition: {
            transition_key: 'op_to_inpatient_transfer_accepted',
            occurred_at: '2026-07-23T08:05:00.000Z',
          },
          admission_source: {
            ...requested.admission_source,
            accepted_recipient_uid: physicianUid,
          },
        },
      }),
    ).toBe(true);

    for (const forbidden of [
      'tenant_id',
      'patient_uid',
      'metadata',
      'idempotency_key',
      'request_fingerprint',
      'actor_uid',
    ]) {
      expect(schemas.OpInpatientTransferResult.properties).not.toHaveProperty(forbidden);
      expect(
        validateResponse({
          success: true,
          data: { ...requested, [forbidden]: 'internal' },
        }),
      ).toBe(false);
    }
  });

  it('accepts exact inpatient discharge evidence without result content', () => {
    const validate = validatorFor('InpatientPendingResultWorkResponse');
    const valid = validate({ success: true, data: inpatientWork });
    expect(validate.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
    expect(
      validate({
        success: true,
        data: {
          ...inpatientWork,
          evidence: {
            ...inpatientWork.evidence,
            transport_plan: {
              ...inpatientWork.evidence.transport_plan,
              section_key: 'discharge_destination',
            },
          },
        },
      }),
    ).toBe(false);
    expect(
      validate({
        success: true,
        data: {
          mode: 'off',
          active_blockers: [],
          evidence: null,
          pending_results: {
            projection_ready: false,
            pathway_instance_id: null,
            references_found: 0,
            references_expected: 0,
            missing_reference_count: 0,
            unresolved_reference_count: 0,
            reconciliation_debt: [],
            items: [],
          },
        },
      }),
    ).toBe(true);

    const unprojected = {
      ...pendingResultItem,
      resource_reference_id: null,
      evidence_state: null,
      handoff: null,
      handoff_complete_warning: false,
      handoff_complete: false,
      summary_included: false,
      blocking: true,
      blocker_codes: ['PENDING_RESULT_REFERENCE_MISSING'],
    };
    expect(
      validatorFor('InpatientPendingResultsProjection')({
        projection_ready: false,
        pathway_instance_id: pathwayId,
        references_found: 0,
        references_expected: 1,
        missing_reference_count: 1,
        unresolved_reference_count: 0,
        reconciliation_debt: [
          {
            code: 'PENDING_RESULT_REFERENCE_MISSING',
            source_type: 'lab_result',
            source_id: '41',
          },
        ],
        items: [unprojected],
      }),
    ).toBe(true);

    for (const forbidden of [
      'result_value',
      'preliminary_result',
      'staff_comment',
      'ward_note',
      'metadata',
    ]) {
      expect(schemas.InpatientPendingResultItem.properties).not.toHaveProperty(forbidden);
      expect(
        validate({
          success: true,
          data: {
            ...inpatientWork,
            pending_results: {
              ...pendingResults,
              items: [{ ...pendingResultItem, [forbidden]: 'internal' }],
            },
          },
        }),
      ).toBe(false);
    }
  });

  it('keeps staff mutation requests closed to arbitrary metadata', () => {
    const handoff = {
      source_type: 'lab_result',
      source_id: '41',
      resource_reference_id: referenceId,
      patient_safe_label: 'Complete blood count',
      idempotency_key: 'pending-result:73:41',
    };
    expect(validatorFor('InpatientPendingResultHandoffRequest')(handoff)).toBe(true);
    expect(
      validatorFor('InpatientPendingResultHandoffRequest')({
        ...handoff,
        metadata: { staff_comment: 'internal' },
      }),
    ).toBe(false);

    expect(
      validatorFor('InpatientFollowUpExceptionRequest')({
        reason: 'The patient declined a follow-up booking.',
        idempotency_key: 'follow-up-exception:73:1',
      }),
    ).toBe(true);
    expect(
      validatorFor('InpatientFollowUpExceptionRequest')({
        reason: 'The patient declined a follow-up booking.',
        idempotency_key: 'follow-up-exception:73:1',
        metadata: { approval: true },
      }),
    ).toBe(false);
  });

  it('returns only allowlisted handoff, task, and contact mutation fields', () => {
    const allowlists = {
      InpatientPendingResultHandoff: [
        'id',
        'admission_id',
        'resource_reference_id',
        'source_type',
        'source_id',
        'patient_safe_label',
        'result_status',
        'primary_physician_assignment_id',
        'named_physician_uid',
        'task_id',
        'handoff_state',
        'discharge_summary_id',
        'summary_included_at',
        'resolution_generation_id',
        'resolution_action_id',
        'resolved_at',
        'resolved_by_uid',
        'created_at',
        'updated_at',
      ],
      InpatientPendingResultActionTask: [
        'id',
        'task_kind',
        'title',
        'description',
        'status',
        'assigned_to_uid',
        'related_resource_type',
        'related_resource_id',
        'parent_task_id',
        'created_at',
        'updated_at',
      ],
      PostDischargeContact: [
        'id',
        'admission_id',
        'event_kind',
        'contact_source',
        'contact_channel',
        'outcome_code',
        'patient_safe_summary',
        'policy_rule_code',
        'occurred_at',
        'recorded_at',
      ],
    };
    for (const [name, fields] of Object.entries(allowlists)) {
      expect(schemas[name].additionalProperties).toBe(false);
      expect(Object.keys(schemas[name].properties)).toEqual(fields);
      expect(schemas[name].required).toEqual(fields);
    }

    const validateHandoff = validatorFor('InpatientPendingResultHandoffMutationResponse');
    expect(
      validateHandoff({
        success: true,
        data: { handoff: pendingResultHandoff },
      }),
    ).toBe(true);

    const resultAvailableHandoff = {
      ...pendingResultHandoff,
      result_status: 'available',
      handoff_state: 'result_available',
      resolution_generation_id: generationId,
      updated_at: '2026-07-24T08:05:00.000Z',
    };
    const validateAvailable = validatorFor('InpatientPendingResultAvailableResponse');
    expect(
      validateAvailable({
        success: true,
        data: {
          handoff: resultAvailableHandoff,
          action_task: pendingResultActionTask,
          owner_action: pendingResultOwnerAction,
          ordering_owner_obligation_preserved: true,
        },
      }),
    ).toBe(true);
    expect(
      validateAvailable({
        success: true,
        data: {
          handoff: resultAvailableHandoff,
          action_task: null,
          owner_action: pendingResultOwnerAction,
          ordering_owner_obligation_preserved: true,
        },
      }),
    ).toBe(true);

    const validateContact = validatorFor('PostDischargeContactMutationResponse');
    expect(
      validateContact({
        success: true,
        data: { contact: postDischargeContact },
      }),
    ).toBe(true);

    const forbidden = [
      'tenant_id',
      'patient_uid',
      'idempotency_key',
      'metadata',
      'created_by_uid',
      'canonical_audit_event_id',
      'notification_outbox_id',
    ];
    for (const field of forbidden) {
      expect(schemas.InpatientPendingResultHandoff.properties).not.toHaveProperty(field);
      expect(
        validateHandoff({
          success: true,
          data: {
            handoff: { ...pendingResultHandoff, [field]: 'internal' },
          },
        }),
      ).toBe(false);

      expect(schemas.PostDischargeContact.properties).not.toHaveProperty(field);
      expect(
        validateContact({
          success: true,
          data: {
            contact: { ...postDischargeContact, [field]: 'internal' },
          },
        }),
      ).toBe(false);
    }

    for (const field of ['tenant_id', 'patient_uid', 'metadata', 'created_by']) {
      expect(schemas.InpatientPendingResultActionTask.properties).not.toHaveProperty(field);
      expect(
        validateAvailable({
          success: true,
          data: {
            handoff: resultAvailableHandoff,
            action_task: { ...pendingResultActionTask, [field]: 'internal' },
            ordering_owner_obligation_preserved: true,
          },
        }),
      ).toBe(false);
    }
  });

  it('binds cross-sign attestation and immutable replay receipts exactly', () => {
    const request = {
      generation_id: generationId,
      diagnostic_action_id: diagnosticActionId,
      generation_snapshot_sha256: 'a'.repeat(64),
      attested: true,
    };
    const validateRequest = validatorFor('InpatientPendingResultCrossSignRequest');
    expect(validateRequest(request)).toBe(true);
    expect(validateRequest({ ...request, attested: false })).toBe(false);
    expect(validateRequest({ ...request, metadata: { approval: true } })).toBe(false);

    const resolution = {
      id: timelineId,
      admission_id: 73,
      handoff_id: handoffId,
      generation_id: generationId,
      diagnostic_action_id: diagnosticActionId,
      pathway_instance_id: pathwayId,
      owner_action_id: evidenceId,
      action_task_id: 92,
      tracking_task_id: 91,
      signature_id: assignmentId,
      resolution_action_id: timelineId,
      handoff_state: 'resolved',
      current_handoff_state: 'result_available',
      generation_snapshot_sha256: 'a'.repeat(64),
      request_sha256: 'b'.repeat(64),
      canonical_timeline_event_id: referenceId,
      canonical_audit_event_id: auditId,
      replayed: true,
    };
    const validateResponse = validatorFor('InpatientPendingResultCrossSignResponse');
    expect(
      validateResponse({
        success: true,
        data: { resolution },
      }),
    ).toBe(true);
    expect(
      validateResponse({
        success: true,
        data: {
          resolution: {
            ...resolution,
            tracking_task_id: undefined,
          },
        },
      }),
    ).toBe(false);
    expect(
      validateResponse({
        success: true,
        data: {
          resolution: {
            ...resolution,
            actor_uid: physicianUid,
          },
        },
      }),
    ).toBe(false);
  });

  it('enforces contact event/source pairs and a patient-safe list shape', () => {
    const validateRequest = validatorFor('PostDischargeContactRequest');
    expect(
      validateRequest({
        event_kind: 'outcome',
        contact_source: 'manual',
        contact_channel: 'phone',
        outcome_code: 'reached',
        patient_safe_summary: 'Patient reports recovery is progressing.',
        idempotency_key: 'contact:73:1',
      }),
    ).toBe(true);
    expect(
      validateRequest({
        event_kind: 'attempt',
        contact_source: 'manual',
        contact_channel: 'phone',
        outcome_code: 'reached',
        idempotency_key: 'contact:73:2',
      }),
    ).toBe(false);
    expect(
      validateRequest({
        event_kind: 'outcome',
        contact_source: 'registered_policy',
        contact_channel: 'sms',
        outcome_code: 'delivered',
        idempotency_key: 'contact:73:3',
      }),
    ).toBe(false);
    expect(
      validateRequest({
        event_kind: 'attempt',
        contact_source: 'manual',
        contact_channel: 'phone',
        idempotency_key: 'contact:73:4',
        recorded_by_system_key: 'hidden-system-identity',
      }),
    ).toBe(false);
    expect(
      validateRequest({
        event_kind: 'attempt',
        contact_source: 'manual',
        contact_channel: 'phone',
        idempotency_key: 'contact:73:5',
        metadata: { staff_comment: 'internal' },
      }),
    ).toBe(false);

    const validateResponse = validatorFor('PostDischargeContactListResponse');
    expect(
      validateResponse({
        success: true,
        data: { contacts: [postDischargeContact], count: 1 },
      }),
    ).toBe(true);
    expect(
      validateResponse({
        success: true,
        data: {
          contacts: [
            {
              ...postDischargeContact,
              canonical_audit_event_id: auditId,
            },
          ],
          count: 1,
        },
      }),
    ).toBe(false);
  });
});
