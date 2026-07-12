import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const setTenantTxMock = jest.fn(async (_tenantId, fn) => fn(__prismaDefaultMock));
const setTenantMock = jest.fn(async (_tenantId, fn) => fn(__prismaDefaultMock));
const recordCanonicalClinicalEventMock = jest.fn(async () => ({
  timeline: { id: '44444444-4444-4444-8444-444444444444' },
  audit: { id: '55555555-5555-4555-8555-555555555555' }
}));
const recordClinicalAuditEventMock = jest.fn(async () => ({ id: '66666666-6666-4666-8666-666666666666' }));
const assertPrivilegeForGateMock = jest.fn(async () => ({ allowed: true }));
const isGateEnabledMock = jest.fn(key => process.env[key] === 'true');
const privilegeKeyMock = jest.fn(value => String(value).trim().toLowerCase());
const buildViewerUrlMock = jest.fn(uid => (uid ? `https://viewer.example/viewer?StudyInstanceUIDs=${uid}` : null));

const __prismaDefaultMock = { $queryRawUnsafe: queryUnsafeMock };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenant: setTenantMock,
  setTenantTx: setTenantTxMock
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: tenantId => tenantId || '00000000-0000-4000-8000-000000000001'
}));

jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: recordCanonicalClinicalEventMock,
  recordClinicalAuditEvent: recordClinicalAuditEventMock
}));

jest.unstable_mockModule('../../services/staff/credentialingService.js', () => ({
  assertPrivilegeForGate: assertPrivilegeForGateMock,
  isGateEnabled: isGateEnabledMock,
  privilegeKey: privilegeKeyMock
}));

jest.unstable_mockModule('../../services/radiology/pacsService.js', () => ({
  buildViewerUrl: buildViewerUrlMock
}));

const {
  REFERRAL_STATUSES,
  createReferral,
  recordRadioisotopeAdministration,
  recordSafetyEvidence,
  transitionPlanStatus,
  transitionFractionStatus,
  validateReferralTransition,
  validatePlanTransition,
  validateFractionTransition,
  validateNuclearOrderTransition,
  assertReferralLinkForState,
  assertPlanReferenceForApproval,
  assertTreatmentRefForDelivery,
  assertIsotopeRefForOrderState,
  radiationPrivilegeGateConfig,
  __testing__
} = await import('../../services/clinical/radiationCoordinationService.js');

const PATIENT = '11111111-1111-4111-8111-111111111111';
const ENCOUNTER = '22222222-2222-4222-8222-222222222222';
const ACTOR = '33333333-3333-4333-8333-333333333333';
// Distinct tenants per service-write test so the per-tenant enablement cache always misses.
const T_REFERRAL = 'aaaaaaaa-0000-4000-8000-000000000001';
const T_ADMIN = 'aaaaaaaa-0000-4000-8000-000000000002';
const T_EVIDENCE = 'aaaaaaaa-0000-4000-8000-000000000003';
const T_DISABLED = 'aaaaaaaa-0000-4000-8000-000000000004';
const T_PLAN = 'aaaaaaaa-0000-4000-8000-000000000005';
const T_PLAN_GATE = 'aaaaaaaa-0000-4000-8000-000000000006';
const T_FRACTION_SCHED = 'aaaaaaaa-0000-4000-8000-000000000007';
const T_FRACTION_DELIV = 'aaaaaaaa-0000-4000-8000-000000000008';
const T_ADMIN_BYPASS = 'aaaaaaaa-0000-4000-8000-000000000009';

function enabledSettingsRow(tenantId) {
  return { tenant_id: tenantId, enabled: true };
}

beforeEach(() => {
  queryUnsafeMock.mockReset();
  setTenantTxMock.mockClear();
  setTenantMock.mockClear();
  recordCanonicalClinicalEventMock.mockClear();
  recordClinicalAuditEventMock.mockClear();
  assertPrivilegeForGateMock.mockClear();
  isGateEnabledMock.mockClear();
  privilegeKeyMock.mockClear();
  buildViewerUrlMock.mockClear();
  delete process.env.RADIATION_ONCOLOGY_PRIVILEGE_KEY;
  delete process.env.RADIATION_ONCOLOGY_PRIVILEGE_GATE_ENABLED;
});

describe('radiationCoordinationService state machines', () => {
  test('referral transitions allow only explicit edges', () => {
    expect(validateReferralTransition('draft', 'submitted')).toBe('submitted');
    expect(validateReferralTransition('submitted', 'accepted')).toBe('accepted');
    expect(() => validateReferralTransition('draft', 'completed')).toThrow('Invalid state transition');
    expect(() => validateReferralTransition('completed', 'submitted')).toThrow('Invalid state transition');
  });

  test('plan / fraction / nuclear-order transitions are guarded', () => {
    expect(validatePlanTransition('referenced', 'approved')).toBe('approved');
    expect(() => validatePlanTransition('approved', 'referenced')).toThrow('Invalid state transition');
    expect(validateFractionTransition('scheduled', 'delivered')).toBe('delivered');
    expect(() => validateFractionTransition('planned', 'delivered')).toThrow('Invalid state transition');
    expect(validateNuclearOrderTransition('draft', 'ordered')).toBe('ordered');
    expect(() => validateNuclearOrderTransition('draft', 'administered')).toThrow('Invalid state transition');
  });

  test('REFERRAL_STATUSES is the canonical status set', () => {
    expect(REFERRAL_STATUSES).toContain('draft');
    expect(REFERRAL_STATUSES).toContain('in_treatment');
  });
});

describe('radiationCoordinationService required-external-reference guardrails (fail closed)', () => {
  test('referral cannot advance to accepted without a diagnosis/staging link or external ref', () => {
    expect(() => assertReferralLinkForState({ diagnosis_id: null, staging_record_id: null, external_reference_id: null }, 'accepted'))
      .toThrow('Referral cannot advance');
    // A diagnosis link satisfies the gate.
    expect(() => assertReferralLinkForState({ diagnosis_id: 5, staging_record_id: null, external_reference_id: null }, 'accepted')).not.toThrow();
    // draft/submitted do not require the link.
    expect(() => assertReferralLinkForState({ diagnosis_id: null, staging_record_id: null, external_reference_id: null }, 'submitted')).not.toThrow();
  });

  test('plan cannot be approved without an external planning-system reference', () => {
    expect(() => assertPlanReferenceForApproval({ external_plan_system: null, external_plan_id: null }, 'approved'))
      .toThrow('cannot be approved without an external planning-system reference');
    expect(() => assertPlanReferenceForApproval({ external_plan_system: 'Eclipse', external_plan_id: 'PLAN-7' }, 'approved')).not.toThrow();
    expect(() => assertPlanReferenceForApproval({ external_plan_system: null, external_plan_id: null }, 'superseded')).not.toThrow();
  });

  test('fraction cannot be delivered without an external treatment reference', () => {
    expect(() => assertTreatmentRefForDelivery({ external_treatment_ref: null }, 'delivered'))
      .toThrow('cannot be marked delivered without an external treatment reference');
    expect(() => assertTreatmentRefForDelivery({ external_treatment_ref: 'RT-REC-9' }, 'delivered')).not.toThrow();
  });

  test('nuclear order cannot advance without an isotope / radiopharmaceutical reference', () => {
    expect(() => assertIsotopeRefForOrderState({ radiopharmaceutical_ref: null, isotope_ref: null }, 'ordered'))
      .toThrow('without an isotope');
    expect(() => assertIsotopeRefForOrderState({ radiopharmaceutical_ref: 'Tc-99m MDP', isotope_ref: null }, 'ordered')).not.toThrow();
    expect(() => assertIsotopeRefForOrderState({ radiopharmaceutical_ref: null, isotope_ref: null }, 'draft')).not.toThrow();
  });
});

describe('radiationCoordinationService privilege gate + PACS reuse', () => {
  test('privilege gate stays inert until the operator enables it', () => {
    expect(radiationPrivilegeGateConfig()).toEqual({
      key: 'radiation_oncology_access',
      enabled: false
    });
    process.env.RADIATION_ONCOLOGY_PRIVILEGE_KEY = 'RADONC_PRIV_OWNER_APPROVED';
    process.env.RADIATION_ONCOLOGY_PRIVILEGE_GATE_ENABLED = 'true';
    expect(radiationPrivilegeGateConfig()).toEqual({
      key: 'radonc_priv_owner_approved',
      enabled: true
    });
  });

  test('withViewerUrl reuses the existing PACS/OHIF deep-link builder', () => {
    const linked = __testing__.withViewerUrl({ id: 1, image_study_instance_uid: '1.2.3.4' });
    expect(linked.viewer_url).toBe('https://viewer.example/viewer?StudyInstanceUIDs=1.2.3.4');
    const noImage = __testing__.withViewerUrl({ id: 2, image_study_instance_uid: null });
    expect(noImage.viewer_url).toBeUndefined();
  });
});

describe('radiationCoordinationService credential gate seams (owner sign-off 2026-07-13)', () => {
  test('plan approval asserts the credential gate and threads the env flag', async () => {
    process.env.RADIATION_ONCOLOGY_PRIVILEGE_GATE_ENABLED = 'true';
    const planRef = {
      id: 51, tenant_id: T_PLAN_GATE, patient_uid: PATIENT, encounter_id: ENCOUNTER,
      plan_status: 'referenced', external_plan_system: 'Eclipse', external_plan_id: 'PLAN-7'
    };
    queryUnsafeMock
      .mockResolvedValueOnce([enabledSettingsRow(T_PLAN_GATE)])          // assertCoordinationEnabled
      .mockResolvedValueOnce([planRef])                                  // planRefById (lock)
      .mockResolvedValueOnce([{ ...planRef, plan_status: 'approved' }])  // UPDATE
      .mockResolvedValueOnce([]);                                        // emitAndLink UPDATE

    await transitionPlanStatus(
      51,
      { tenantId: T_PLAN_GATE, plan_status: 'approved' },
      { actorUid: ACTOR, actorRole: 'RADIATION_ONCOLOGIST' }
    );

    expect(assertPrivilegeForGateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        staffUid: ACTOR,
        privilegeName: 'radiation_oncology_access',
        gate: 'radiotherapy_plan_approval',
        enabled: true
      })
    );
  });

  test('fraction delivery asserts the credential gate; other fraction transitions do not', async () => {
    const scheduled = {
      id: 61, tenant_id: T_FRACTION_SCHED, patient_uid: PATIENT, encounter_id: ENCOUNTER,
      status: 'planned', fraction_number: 1, external_treatment_ref: null
    };
    queryUnsafeMock
      .mockResolvedValueOnce([enabledSettingsRow(T_FRACTION_SCHED)])
      .mockResolvedValueOnce([scheduled])
      .mockResolvedValueOnce([{ ...scheduled, status: 'scheduled' }])
      .mockResolvedValueOnce([]);
    await transitionFractionStatus(
      61,
      { tenantId: T_FRACTION_SCHED, status: 'scheduled' },
      { actorUid: ACTOR, actorRole: 'RADIOTHERAPIST' }
    );
    expect(assertPrivilegeForGateMock).not.toHaveBeenCalled();

    const deliverable = {
      id: 62, tenant_id: T_FRACTION_DELIV, patient_uid: PATIENT, encounter_id: ENCOUNTER,
      status: 'scheduled', fraction_number: 2, external_treatment_ref: 'RT-REC-9'
    };
    queryUnsafeMock
      .mockResolvedValueOnce([enabledSettingsRow(T_FRACTION_DELIV)])
      .mockResolvedValueOnce([deliverable])
      .mockResolvedValueOnce([{ ...deliverable, status: 'delivered' }])
      .mockResolvedValueOnce([]);
    await transitionFractionStatus(
      62,
      { tenantId: T_FRACTION_DELIV, status: 'delivered' },
      { actorUid: ACTOR, actorRole: 'RADIOTHERAPIST' }
    );
    expect(assertPrivilegeForGateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        staffUid: ACTOR,
        privilegeName: 'radiation_oncology_access',
        gate: 'radiotherapy_fraction_delivery',
        enabled: false
      })
    );
  });

  test('ADMIN bypasses the credential gate — role-based access is preserved', async () => {
    process.env.RADIATION_ONCOLOGY_PRIVILEGE_GATE_ENABLED = 'true';
    const planRef = {
      id: 52, tenant_id: T_ADMIN_BYPASS, patient_uid: PATIENT, encounter_id: ENCOUNTER,
      plan_status: 'referenced', external_plan_system: 'Eclipse', external_plan_id: 'PLAN-8'
    };
    queryUnsafeMock
      .mockResolvedValueOnce([enabledSettingsRow(T_ADMIN_BYPASS)])
      .mockResolvedValueOnce([planRef])
      .mockResolvedValueOnce([{ ...planRef, plan_status: 'approved' }])
      .mockResolvedValueOnce([]);

    await transitionPlanStatus(
      52,
      { tenantId: T_ADMIN_BYPASS, plan_status: 'approved' },
      { actorUid: ACTOR, actorRole: 'ADMIN' }
    );

    expect(assertPrivilegeForGateMock).not.toHaveBeenCalled();
  });
});

describe('radiationCoordinationService canonical writes', () => {
  test('createReferral emits exactly one canonical timeline/audit event tagged nl13_p4', async () => {
    const referral = {
      id: 10, tenant_id: T_REFERRAL, patient_uid: PATIENT, encounter_id: ENCOUNTER,
      intent: 'curative', modality: 'external_beam', status: 'draft'
    };
    queryUnsafeMock
      .mockResolvedValueOnce([enabledSettingsRow(T_REFERRAL)]) // assertCoordinationEnabled
      .mockResolvedValueOnce([{ uid: PATIENT }])               // assertPatientInTenant
      .mockResolvedValueOnce([referral])                       // INSERT referral
      .mockResolvedValueOnce([]);                              // emitAndLink UPDATE

    const result = await createReferral(
      { tenantId: T_REFERRAL, patient_uid: PATIENT, encounter_id: ENCOUNTER, modality: 'external_beam' },
      { actorUid: ACTOR, actorRole: 'RADIATION_ONCOLOGIST' }
    );

    expect(result).toMatchObject({ id: 10, status: 'draft' });
    expect(recordCanonicalClinicalEventMock).toHaveBeenCalledTimes(1);
    expect(recordCanonicalClinicalEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: T_REFERRAL,
        patientUid: PATIENT,
        eventType: 'radiotherapy.referral_created',
        sourceTable: 'radiation_oncology_referrals',
        sourceId: 10,
        tags: ['radiation_oncology', 'nl13_p4']
      }),
      { db: __prismaDefaultMock }
    );
    expect(queryUnsafeMock.mock.calls[2][0]).toContain('INSERT INTO radiation_oncology_referrals');
  });

  test('recordRadioisotopeAdministration enforces the privilege gate and stores owner-supplied activity (never computed)', async () => {
    const order = { id: 20, tenant_id: T_ADMIN, patient_uid: PATIENT, encounter_id: ENCOUNTER, status: 'prepared', radiopharmaceutical_ref: 'I-131', isotope_ref: null };
    const administration = { id: 30, tenant_id: T_ADMIN, order_id: 20, patient_uid: PATIENT, administered_activity_mbq: 3700, route: 'oral' };
    queryUnsafeMock
      .mockResolvedValueOnce([enabledSettingsRow(T_ADMIN)]) // assertCoordinationEnabled
      .mockResolvedValueOnce([order])                       // nuclearOrderById
      .mockResolvedValueOnce([administration])              // INSERT administration
      .mockResolvedValueOnce([])                            // UPDATE order status
      .mockResolvedValueOnce([]);                           // emitAndLink UPDATE

    const result = await recordRadioisotopeAdministration(
      20,
      { tenantId: T_ADMIN, administered_activity_mbq: 3700, route: 'oral', aerb_evidence_owner: 'Owner-supplied AERB evidence' },
      { actorUid: ACTOR, actorRole: 'NUCLEAR_MEDICINE_PHYSICIAN' }
    );

    expect(result).toMatchObject({ id: 30, administered_activity_mbq: 3700 });
    expect(assertPrivilegeForGateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        staffUid: ACTOR,
        privilegeName: 'radiation_oncology_access',
        gate: 'radioisotope_administration',
        enabled: false
      })
    );
    expect(recordCanonicalClinicalEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'nuclear_medicine.radioisotope_administered',
        sourceTable: 'radioisotope_administration_records',
        payload: expect.objectContaining({ privilege_gate: { key: 'radiation_oncology_access', enforced: false } }),
        tags: ['radiation_oncology', 'nl13_p4']
      }),
      { db: __prismaDefaultMock }
    );
    expect(queryUnsafeMock.mock.calls[2][0]).toContain('INSERT INTO radioisotope_administration_records');
  });

  test('recordSafetyEvidence writes a register/audit trail and NEVER a patient timeline event', async () => {
    const evidence = { id: 40, tenant_id: T_EVIDENCE, evidence_type: 'equipment_qa', status: 'pending', equipment_ref: 'LINAC-1' };
    queryUnsafeMock
      .mockResolvedValueOnce([enabledSettingsRow(T_EVIDENCE)]) // assertCoordinationEnabled
      .mockResolvedValueOnce([evidence])                       // INSERT evidence
      .mockResolvedValueOnce([]);                              // UPDATE clinical_audit_event_id

    const result = await recordSafetyEvidence(
      { tenantId: T_EVIDENCE, evidence_type: 'equipment_qa', equipment_ref: 'LINAC-1', evidence_owner: 'Owner RSO' },
      { actorUid: ACTOR, actorRole: 'RADIATION_SAFETY_OFFICER' }
    );

    expect(result).toMatchObject({ id: 40, evidence_type: 'equipment_qa' });
    expect(recordClinicalAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'radiation_safety.evidence_recorded',
        resourceTable: 'radiation_safety_evidence'
      }),
      { db: __prismaDefaultMock }
    );
    // Equipment/QA evidence is a register/audit subject — it must NOT emit a patient timeline event.
    expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
    expect(queryUnsafeMock.mock.calls[1][0]).toContain('INSERT INTO radiation_safety_evidence');
  });

  test('mutations fail closed when the coordination suite is disabled for the tenant', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ tenant_id: T_DISABLED, enabled: false }]);
    await expect(
      createReferral({ tenantId: T_DISABLED, patient_uid: PATIENT }, { actorUid: ACTOR })
    ).rejects.toMatchObject({ code: 'RADIATION_COORDINATION_DISABLED' });
    expect(setTenantTxMock).not.toHaveBeenCalled();
  });

  test('plan approval fails closed without an external planning-system reference', async () => {
    const planRef = { id: 50, tenant_id: T_PLAN, patient_uid: PATIENT, plan_status: 'referenced', external_plan_system: null, external_plan_id: null };
    queryUnsafeMock
      .mockResolvedValueOnce([enabledSettingsRow(T_PLAN)]) // assertCoordinationEnabled
      .mockResolvedValueOnce([planRef]);                   // planRefById (lock)
    await expect(
      transitionPlanStatus(50, { tenantId: T_PLAN, plan_status: 'approved' }, { actorUid: ACTOR })
    ).rejects.toMatchObject({ code: 'RADIOTHERAPY_PLAN_REFERENCE_REQUIRED' });
  });
});
