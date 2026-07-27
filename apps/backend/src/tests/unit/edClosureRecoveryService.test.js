import { jest } from '@jest/globals';

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  setTenantTx: jest.fn(),
}));
jest.unstable_mockModule(
  '../../services/clinical/canonicalClinicalPlatformService.js',
  () => ({
    recordCanonicalClinicalEvent: jest.fn(),
  }),
);
jest.unstable_mockModule('../../services/events/eventOutboxService.js', () => ({
  publishEvent: jest.fn(),
}));
jest.unstable_mockModule(
  '../../services/pathways/pathwayRuntimePersistence.js',
  () => ({
    resolvePathwayModeTx: jest.fn(),
  }),
);
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  getTenantById: jest.fn(),
  requireTenantId: jest.fn(value => value),
}));
jest.unstable_mockModule('../../services/workflow/taskService.js', () => ({
  createEdClosureReviewTaskTx: jest.fn(),
  transitionTask: jest.fn(),
}));

const {
  loadEdContinuityEvidenceTx,
  reconcileEdClosureTaskTx,
  __testing__,
} = await import('../../services/ed/edClosureRecoveryService.js');
const {
  createEdClosureReviewTaskTx,
  transitionTask,
} = await import('../../services/workflow/taskService.js');

const TENANT_ID = '10000000-0000-4000-8000-000000000001';

function dischargeInput(overrides = {}) {
  return {
    closure_kind: 'discharge',
    follow_up_required: true,
    follow_up_plan_id: 91,
    patient_safe_next_steps: [{
      label: 'Review pending result',
      explanation: 'Attend the booked review.',
      status: 'scheduled',
      route_token: 'appointments',
      staff_notes: 'must never cross the patient boundary',
    }],
    medication_not_applicable_reason: 'No medicines were prescribed',
    identity_resolution_status: 'verified',
    ...overrides,
  };
}

test('normalizes a discharge revision to the bounded patient-safe contract', () => {
  const normalized = __testing__.normalizeClosureInput(dischargeInput());

  expect(normalized).toMatchObject({
    closureKind: 'discharge',
    followUpRequired: true,
    followUpPlanId: 91,
    medicationNotApplicableReason: 'No medicines were prescribed',
    patientVisibilityStatus: 'released',
    identityResolutionStatus: 'verified',
  });
  expect(normalized.patientSafeNextSteps).toEqual([{
    label: 'Review pending result',
    explanation: 'Attend the booked review.',
    due_date: null,
    status: 'scheduled',
    patient_action: null,
    route_token: 'appointments',
  }]);
  expect(JSON.stringify(normalized)).not.toContain('staff_notes');
});

test('requires one exact medication decision for every non-death closure', () => {
  expect(() => __testing__.normalizeClosureInput(dischargeInput({
    medication_reconciliation_id: '20000000-0000-4000-8000-000000000001',
  }))).toThrow(/either a completed medication_reconciliation_id/i);

  expect(() => __testing__.normalizeClosureInput(dischargeInput({
    medication_not_applicable_reason: null,
  }))).toThrow(/either a completed medication_reconciliation_id/i);
});

test('idempotent closure replay compares an explicitly supplied clinical timestamp', () => {
  const actorUid = '40000000-0000-4000-8000-000000000001';
  const visit = {
    id: 73,
    patient_uid: '20000000-0000-4000-8000-000000000001',
    encounter_id: '30000000-0000-4000-8000-000000000001',
  };
  const normalized = __testing__.normalizeClosureInput(dischargeInput({
    occurred_at: '2026-07-27T10:00:00.000Z',
  }));
  const row = {
    emergency_visit_id: visit.id,
    patient_uid: visit.patient_uid,
    encounter_id: visit.encounter_id,
    clinician_uid: actorUid,
    closure_kind: normalized.closureKind,
    follow_up_required: normalized.followUpRequired,
    follow_up_plan_id: normalized.followUpPlanId,
    patient_safe_next_steps: normalized.patientSafeNextSteps,
    medication_not_applicable_reason:
      normalized.medicationNotApplicableReason,
    identity_resolution_status: normalized.identityResolutionStatus,
    occurred_at: new Date(normalized.occurredAt),
  };

  expect(__testing__.closurePayloadMatches(row, {
    visit,
    actorUid,
    normalized,
  })).toBe(true);
  expect(__testing__.closurePayloadMatches({
    ...row,
    occurred_at: new Date('2026-07-27T10:05:00.000Z'),
  }, {
    visit,
    actorUid,
    normalized,
  })).toBe(false);
});

test('requires explicit clinical risk evidence for LAMA and LWBS', () => {
  expect(() => __testing__.normalizeClosureInput(dischargeInput({
    closure_kind: 'left_against_medical_advice',
  }))).toThrow(/risk_classification_code is required/i);

  expect(__testing__.normalizeClosureInput(dischargeInput({
    closure_kind: 'lwbs',
    risk_classification_code: 'high_risk',
    risk_summary: 'Left before recommended monitoring was complete',
  }))).toMatchObject({
    closureKind: 'lwbs',
    riskClassificationCode: 'high_risk',
  });
});

test('death closure remains hidden and rejects patient aftercare fields', () => {
  const normalized = __testing__.normalizeClosureInput({
    closure_kind: 'death',
    patient_safe_next_steps: [],
    death_record_id: 71,
    identity_resolution_status: 'verified',
  });

  expect(normalized).toMatchObject({
    closureKind: 'death',
    patientVisibilityStatus: 'hidden',
    followUpRequired: false,
    deathRecordId: 71,
  });
  expect(() => __testing__.normalizeClosureInput({
    closure_kind: 'death',
    patient_safe_next_steps: [{ label: 'Internal mortuary step' }],
    medication_not_applicable_reason: 'not applicable',
    death_record_id: 71,
    identity_resolution_status: 'verified',
  })).toThrow(/does not accept medication reconciliation fields/i);
});

test('recovery outcome requires a bounded canonical outcome code', () => {
  expect(__testing__.normalizeRecoveryInput({
    event_kind: 'outcome',
    contact_channel: 'phone',
    outcome_code: 'review_arranged',
    patient_safe_summary: 'A review was arranged.',
    staff_notes: 'Internal risk discussion.',
  })).toMatchObject({
    eventKind: 'outcome',
    contactChannel: 'phone',
    outcomeCode: 'review_arranged',
  });

  expect(() => __testing__.normalizeRecoveryInput({
    event_kind: 'outcome',
    contact_channel: 'phone',
  })).toThrow(/outcome_code is required/i);
});

test('LAMA remains open until a contact attempt and clinician outcome exist', async () => {
  const tx = {
    $queryRawUnsafe: jest.fn(async () => [{
      id: 73,
      patient_uid: '20000000-0000-4000-8000-000000000001',
      encounter_id: '30000000-0000-4000-8000-000000000001',
      attending_doctor_uid: '40000000-0000-4000-8000-000000000001',
      visit_status: 'left_against_advice',
      disposition: 'left_against_medical_advice',
      is_mlc: false,
      is_unidentified: false,
      closure_evidence_id: '50000000-0000-4000-8000-000000000001',
      closure_kind: 'left_against_medical_advice',
      identity_resolution_status: 'verified',
      recovery_attempt_count: 1,
      latest_outcome_code: null,
      latest_outcome_at: null,
    }]),
  };

  const pending = await loadEdContinuityEvidenceTx({
    tx,
    tenantId: TENANT_ID,
    emergencyVisitId: 73,
  });
  expect(pending).toMatchObject({
    latest_closure_matches_branch: true,
    recovery_complete: false,
    branch_closure_complete: false,
  });

  tx.$queryRawUnsafe.mockResolvedValueOnce([{
    ...pending,
    id: 73,
    recovery_attempt_count: 1,
    latest_outcome_code: 'review_arranged',
    latest_outcome_at: new Date('2026-07-27T10:00:00.000Z'),
  }]);
  const complete = await loadEdContinuityEvidenceTx({
    tx,
    tenantId: TENANT_ID,
    emergencyVisitId: 73,
  });
  expect(complete).toMatchObject({
    recovery_complete: true,
    branch_closure_complete: true,
  });
});

test('death closure requires both mortuary receipt and release', async () => {
  const base = {
    id: 74,
    patient_uid: '20000000-0000-4000-8000-000000000001',
    encounter_id: '30000000-0000-4000-8000-000000000001',
    attending_doctor_uid: '40000000-0000-4000-8000-000000000001',
    visit_status: 'expired',
    disposition: 'death',
    is_mlc: false,
    is_unidentified: false,
    closure_evidence_id: '50000000-0000-4000-8000-000000000001',
    closure_kind: 'death',
    identity_resolution_status: 'verified',
    death_record_id: 71,
    death_status: 'certified',
    death_certified_at: new Date('2026-07-27T10:00:00.000Z'),
    custody_has_receive: true,
    custody_has_release: false,
  };
  const tx = {
    $queryRawUnsafe: jest.fn()
      .mockResolvedValueOnce([base])
      .mockResolvedValueOnce([{
        ...base,
        custody_has_release: true,
      }]),
  };

  const awaitingRelease = await loadEdContinuityEvidenceTx({
    tx,
    tenantId: TENANT_ID,
    emergencyVisitId: 74,
  });
  expect(awaitingRelease).toMatchObject({
    mortuary_custody_recorded: false,
    branch_closure_complete: false,
  });

  const released = await loadEdContinuityEvidenceTx({
    tx,
    tenantId: TENANT_ID,
    emergencyVisitId: 74,
  });
  expect(released).toMatchObject({
    mortuary_custody_recorded: true,
    branch_closure_complete: true,
  });
});

test('a corrected LAMA revision creates a successor task instead of reopening completion', async () => {
  const patientUid = '20000000-0000-4000-8000-000000000001';
  const encounterId = '30000000-0000-4000-8000-000000000001';
  const clinicianUid = '40000000-0000-4000-8000-000000000001';
  const pathwayId = '60000000-0000-4000-8000-000000000001';
  const completed = {
    id: 88,
    status: 'completed',
    task_kind: 'ed_closure_review',
    assigned_to_uid: clinicianUid,
    assigned_to_role: null,
    related_resource_type: 'emergency_visit_closure',
    related_resource_id: '75',
    due_at: null,
    workflow_sla_instance_id: null,
    sla_completion_semantics: 'none',
    metadata: {
      task_contract: 'ed_closure_review_v1',
      canonical_encounter_id: encounterId,
      care_pathway_instance_id: pathwayId,
    },
  };
  const successor = {
    ...completed,
    id: 89,
    status: 'open',
  };
  const tx = {
    $queryRawUnsafe: jest.fn()
      .mockResolvedValueOnce([{
        id: 75,
        patient_uid: patientUid,
        encounter_id: encounterId,
        attending_doctor_uid: clinicianUid,
        visit_status: 'left_against_advice',
        disposition: 'left_against_medical_advice',
        is_mlc: false,
        is_unidentified: false,
        closure_evidence_id: '50000000-0000-4000-8000-000000000001',
        evidence_revision: 2,
        closure_kind: 'left_against_medical_advice',
        identity_resolution_status: 'verified',
        recovery_attempt_count: 0,
        latest_outcome_code: null,
        latest_outcome_at: null,
      }])
      .mockResolvedValueOnce([completed]),
  };
  createEdClosureReviewTaskTx.mockResolvedValueOnce(successor);

  const result = await reconcileEdClosureTaskTx({
    tx,
    tenantId: TENANT_ID,
    emergencyVisitId: 75,
    pathwayInstanceId: pathwayId,
  });

  expect(createEdClosureReviewTaskTx).toHaveBeenCalledWith(expect.objectContaining({
    supersedesTaskId: 88,
    evidenceRevision: 2,
  }));
  expect(transitionTask).not.toHaveBeenCalled();
  expect(result.task).toEqual(successor);
});
