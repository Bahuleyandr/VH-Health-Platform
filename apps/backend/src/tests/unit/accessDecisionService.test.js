import { jest } from '@jest/globals';

const prismaMock = {
  $queryRawUnsafe: jest.fn(),
  $executeRawUnsafe: jest.fn(),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  setTenantTx: async (_tenantId, fn) => fn(prismaMock),
  setTenant: async (_tenantId, fn) => fn(prismaMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(prismaMock),
  pickTenantClient: () => prismaMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

const {
  ACCESS_POLICY_CODES,
  authorizePatientAccessRequest,
  resolvePatientForAccess,
  resolvePatientForResourceAccess,
} = await import('../../services/security/accessDecisionService.js');

const PATIENT_UID = '11111111-1111-4111-8111-111111111111';
const ACTOR_UID = '22222222-2222-4222-8222-222222222222';
const PATHWAY_INSTANCE_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_PATHWAY_INSTANCE_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_PATIENT_UID = '55555555-5555-4555-8555-555555555555';
const OTHER_TENANT_ID = '00000000-0000-4000-8000-000000000002';

afterEach(() => {
  prismaMock.$queryRawUnsafe.mockReset();
  prismaMock.$executeRawUnsafe.mockReset();
});

function reqFor(role, extras = {}) {
  return {
    id: 'req-1',
    method: 'GET',
    originalUrl: '/api/v1/records?patient_id=15',
    params: {},
    query: { patient_id: '15' },
    body: {},
    user: {
      id: 9,
      uid: ACTOR_UID,
      role,
      tenant_id: '00000000-0000-4000-8000-000000000001',
      ...extras.user,
    },
    ...extras,
  };
}

function patientLookup() {
  return [{ id: 15, uid: PATIENT_UID }];
}

describe('accessDecisionService', () => {
  it('treats an explicit unresolved patient as authoritative instead of falling back to request aliases', async () => {
    const resolved = await resolvePatientForAccess(reqFor('DOCTOR', {
      query: { patient_uid: PATIENT_UID },
      body: { patient_id: '15', phone: '+919000090011' },
    }), null);

    expect(resolved).toBeNull();
    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('uses an explicit patient selector instead of conflicting query and body aliases', async () => {
    const selectedUid = '33333333-3333-4333-8333-333333333333';
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([{ id: 27, uid: selectedUid }]);

    const resolved = await resolvePatientForAccess(reqFor('DOCTOR', {
      query: { patient_uid: PATIENT_UID },
      body: { patient_uid: PATIENT_UID },
    }), { uid: selectedUid });

    expect(resolved).toEqual({ id: 27, uid: selectedUid });
    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(prismaMock.$queryRawUnsafe.mock.calls[0][2]).toBeNull();
    expect(prismaMock.$queryRawUnsafe.mock.calls[0][3]).toBe(selectedUid);
  });

  it('denies CNO PHI access without a patient relationship or break-glass override', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce(patientLookup())
      .mockResolvedValueOnce([]);
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizePatientAccessRequest(reqFor('CNO'), {
      policyCode: ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW,
      recordType: 'MEDICAL_RECORD',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.break_glass_available).toBe(false);
    expect(decision.policy_code).toBe(ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW);
    expect(prismaMock.$executeRawUnsafe.mock.calls[0][5]).toBe('deny');
  });

  it('denies Admin PHI access without active break-glass but advertises break-glass availability', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce(patientLookup())
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizePatientAccessRequest(reqFor('ADMIN'), {
      policyCode: ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW,
      recordType: 'MEDICAL_RECORD',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.break_glass_available).toBe(true);
    expect(decision.reason).toMatch(/relationship/i);
    expect(prismaMock.$executeRawUnsafe.mock.calls[0][5]).toBe('deny');
  });

  it('allows Admin PHI access through an active break-glass session', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce(patientLookup())
      .mockResolvedValueOnce([{ id: 44, reason: 'Emergency access for active resuscitation' }]);
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizePatientAccessRequest(reqFor('ADMIN'), {
      policyCode: ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW,
      recordType: 'MEDICAL_RECORD',
    });

    expect(decision.allowed).toBe(true);
    expect(decision.accessDecision).toBe('break_glass');
    expect(decision.accessSource).toBe('break_glass');
    expect(decision.breakGlassId).toBe(44);
    expect(decision.breakGlassReason).toBe('Emergency access for active resuscitation');
    expect(prismaMock.$executeRawUnsafe.mock.calls[0][5]).toBe('break_glass');
    expect(prismaMock.$executeRawUnsafe.mock.calls[0][11]).toBe(44);
  });

  it('allows receptionist record view only when an OP appointment relationship exists', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce(patientLookup())
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 77 }]);
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizePatientAccessRequest(reqFor('RECEPTIONIST'), {
      policyCode: ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW,
      recordType: 'MEDICAL_RECORD',
    });

    expect(decision.allowed).toBe(true);
    expect(decision.accessSource).toBe('appointment');
    expect(decision.appointmentId).toBe(77);
    expect(prismaMock.$executeRawUnsafe.mock.calls[0][6]).toBe('appointment');
  });

  it('keeps HR leave/reporting authority out of patient PHI access', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce(patientLookup());
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizePatientAccessRequest(reqFor('HR_STAFF'), {
      policyCode: ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW,
      recordType: 'MEDICAL_RECORD',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.phi_access_level).toBe('staff_only');
    expect(decision.reason).toMatch(/does not have a patient PHI access scope/i);
  });

  it('denies OP-only nursing roles from IP-only extraction review capability', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce(patientLookup());
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizePatientAccessRequest(reqFor('OP_STAFF_NURSE'), {
      policyCode: ACCESS_POLICY_CODES.PATIENT_RECORD_EXTRACTION_REVIEW,
      recordType: 'PATIENT_RECORD_EXTRACTION',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/capability group/i);
    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  });

  it('denies explicit record access when the patient context cannot be resolved', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([]);

    const decision = await authorizePatientAccessRequest(reqFor('DOCTOR'), {
      policyCode: ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW,
      recordType: 'MEDICAL_RECORD',
      patient: { id: 15 },
      requireResolvedPatient: true,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/could not be resolved/i);
    expect(prismaMock.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('allows a referred consultant to view patient records through an active referral relationship', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce(patientLookup())
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 88, status: 'pending', referred_to_department: 'Cardiology' }]);
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizePatientAccessRequest(reqFor('DOCTOR'), {
      policyCode: ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW,
      recordType: 'MEDICAL_RECORD',
      patient: { uid: PATIENT_UID },
    });

    expect(decision.allowed).toBe(true);
    expect(decision.accessSource).toBe('referral');
    expect(decision.referralId).toBe(88);
    expect(prismaMock.$executeRawUnsafe.mock.calls[0][5]).toBe('allow');
    expect(prismaMock.$executeRawUnsafe.mock.calls[0][6]).toBe('referral');
  });

  it('allows receptionist admission writes through role-owned operational workflow access', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce(patientLookup());
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizePatientAccessRequest(reqFor('RECEPTIONIST', {
      method: 'POST',
      originalUrl: '/api/v1/admissions',
      query: {},
      body: { patient_uid: PATIENT_UID },
    }), {
      policyCode: ACCESS_POLICY_CODES.PATIENT_ADMISSION_WRITE,
      recordType: 'ADMISSION',
    });

    expect(decision.allowed).toBe(true);
    expect(decision.accessSource).toBe('role');
    expect(decision.reason).toMatch(/operational workflow access/i);
    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(prismaMock.$executeRawUnsafe.mock.calls[0][5]).toBe('allow');
  });

  it('allows pharmacy to view admitted-patient clinical workflow through an active admission relationship', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce(patientLookup())
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 27 }]);
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizePatientAccessRequest(reqFor('PHARMACY_STAFF', {
      originalUrl: '/api/v1/clinical/drug-chart/admission/27',
      query: { patient_id: '15' },
    }), {
      policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS,
      recordType: 'CLINICAL_WORKFLOW',
    });

    expect(decision.allowed).toBe(true);
    expect(decision.accessSource).toBe('admission');
    expect(decision.admissionId).toBe(27);
  });

  it.each([
    [ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS, 'GET'],
    [ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE, 'POST'],
  ])('allows a current RADIOLOGIST owner through exact pathway ownership for %s', async (policyCode, method) => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce(patientLookup())
      .mockResolvedValueOnce([{ id: PATHWAY_INSTANCE_ID }]);
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizePatientAccessRequest(reqFor('RADIOLOGIST', {
      method,
      originalUrl: `/api/v1/care-pathways/instances/${PATHWAY_INSTANCE_ID}`,
      query: {},
    }), {
      policyCode,
      recordType: 'CARE_PATHWAY',
      patient: { uid: PATIENT_UID },
      resourceContext: {
        resourceType: 'care_pathway_instance',
        resourceId: PATHWAY_INSTANCE_ID,
      },
      requireResolvedPatient: true,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.accessSource).toBe('care_pathway_owner');
    expect(decision.carePathwayInstanceId).toBe(PATHWAY_INSTANCE_ID);

    const ownerLookup = prismaMock.$queryRawUnsafe.mock.calls[1];
    expect(ownerLookup[0]).toContain('FROM care_pathway_instances cpi');
    expect(ownerLookup[0]).toContain('cpi.patient_uid = $3::uuid');
    expect(ownerLookup[0]).toContain('cpi.owning_clinician_uid = $4::uuid');
    expect(ownerLookup[0]).toContain('UPPER(BTRIM(owner.role)) = $5::text');
    expect(ownerLookup[0]).toContain('owner.is_active = TRUE');
    expect(ownerLookup[0]).toContain("LOWER(COALESCE(owner.status, '')) = 'active'");
    expect(ownerLookup[0]).toContain('owner.is_deleted IS FALSE');
    expect(ownerLookup[0]).toContain('owner.deleted_at IS NULL');
    expect(ownerLookup.slice(1)).toEqual([
      '00000000-0000-4000-8000-000000000001',
      PATHWAY_INSTANCE_ID,
      PATIENT_UID,
      ACTOR_UID,
      'RADIOLOGIST',
    ]);
    expect(prismaMock.$executeRawUnsafe.mock.calls[0][6]).toBe('care_pathway_owner');
    expect(JSON.parse(prismaMock.$executeRawUnsafe.mock.calls[0][13]))
      .toEqual(expect.objectContaining({ care_pathway_instance_id: PATHWAY_INSTANCE_ID }));
  });

  it('denies a RADIOLOGIST who owns a different pathway instance', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce(patientLookup())
      .mockResolvedValueOnce([]);
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizePatientAccessRequest(reqFor('RADIOLOGIST', {
      method: 'POST',
      originalUrl: `/api/v1/care-pathways/instances/${OTHER_PATHWAY_INSTANCE_ID}/commands`,
      query: {},
    }), {
      policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
      recordType: 'CARE_PATHWAY',
      patient: { uid: PATIENT_UID },
      resourceContext: {
        resourceType: 'care_pathway_instance',
        resourceId: OTHER_PATHWAY_INSTANCE_ID,
      },
      requireResolvedPatient: true,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.accessSource).toBe('unknown');
    expect(decision.reason).toMatch(/capability group/i);
    expect(prismaMock.$queryRawUnsafe.mock.calls[1][2]).toBe(OTHER_PATHWAY_INSTANCE_ID);
  });

  it.each([
    'inactive',
    'soft-deleted',
    'current database role no longer matches the clinical JWT role',
  ])('denies a named owner whose user record is %s', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce(patientLookup())
      .mockResolvedValueOnce([]);
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizePatientAccessRequest(reqFor('RADIOLOGIST', {
      originalUrl: `/api/v1/care-pathways/instances/${PATHWAY_INSTANCE_ID}`,
      query: {},
    }), {
      policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS,
      recordType: 'CARE_PATHWAY',
      patient: { uid: PATIENT_UID },
      resourceContext: {
        resourceType: 'care_pathway_instance',
        resourceId: PATHWAY_INSTANCE_ID,
      },
      requireResolvedPatient: true,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/capability group/i);
    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledTimes(2);
  });

  it('binds owner access to the request tenant', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce(patientLookup())
      .mockResolvedValueOnce([]);
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizePatientAccessRequest(reqFor('RADIOLOGIST', {
      originalUrl: `/api/v1/care-pathways/instances/${PATHWAY_INSTANCE_ID}`,
      query: {},
      user: {
        id: 9,
        uid: ACTOR_UID,
        role: 'RADIOLOGIST',
        tenant_id: OTHER_TENANT_ID,
      },
    }), {
      policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS,
      recordType: 'CARE_PATHWAY',
      patient: { uid: PATIENT_UID },
      resourceContext: {
        resourceType: 'care_pathway_instance',
        resourceId: PATHWAY_INSTANCE_ID,
      },
      requireResolvedPatient: true,
    });

    expect(decision.allowed).toBe(false);
    expect(prismaMock.$queryRawUnsafe.mock.calls[1][1]).toBe(OTHER_TENANT_ID);
  });

  it('binds owner access to the patient resolved from the requested instance', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ id: 16, uid: OTHER_PATIENT_UID }])
      .mockResolvedValueOnce([]);
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizePatientAccessRequest(reqFor('RADIOLOGIST', {
      originalUrl: `/api/v1/care-pathways/instances/${PATHWAY_INSTANCE_ID}`,
      query: {},
    }), {
      policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS,
      recordType: 'CARE_PATHWAY',
      patient: { uid: OTHER_PATIENT_UID },
      resourceContext: {
        resourceType: 'care_pathway_instance',
        resourceId: PATHWAY_INSTANCE_ID,
      },
      requireResolvedPatient: true,
    });

    expect(decision.allowed).toBe(false);
    expect(prismaMock.$queryRawUnsafe.mock.calls[1][3]).toBe(OTHER_PATIENT_UID);
  });

  it('never probes pathway ownership for an invalid instance UUID', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce(patientLookup());
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizePatientAccessRequest(reqFor('RADIOLOGIST', { query: {} }), {
      policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS,
      recordType: 'CARE_PATHWAY',
      patient: { uid: PATIENT_UID },
      resourceContext: {
        resourceType: 'care_pathway_instance',
        resourceId: 'not-a-uuid',
      },
      requireResolvedPatient: true,
    });

    expect(decision.allowed).toBe(false);
    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  });

  it.each([
    [ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS, 'radiology_order'],
    [ACCESS_POLICY_CODES.PATIENT_RADIOLOGY_VIEW, 'care_pathway_instance'],
  ])('never probes pathway ownership for policy %s and resource %s', async (policyCode, resourceType) => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce(patientLookup())
      .mockResolvedValue([]);
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    await authorizePatientAccessRequest(reqFor('RADIOLOGIST', { query: {} }), {
      policyCode,
      recordType: 'RADIOLOGY',
      patient: { uid: PATIENT_UID },
      resourceContext: { resourceType, resourceId: PATHWAY_INSTANCE_ID },
      requireResolvedPatient: true,
    });

    const pathwayOwnerQueries = prismaMock.$queryRawUnsafe.mock.calls.filter(
      ([sql]) => sql.includes('FROM care_pathway_instances cpi') && sql.includes('owning_clinician_uid'),
    );
    expect(pathwayOwnerQueries).toHaveLength(0);
  });

  it('does not grant pathway ownership to a nonclinical role even when the resource names that actor', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce(patientLookup());
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizePatientAccessRequest(reqFor('MEDICAL_RECORDS', {
      originalUrl: `/api/v1/care-pathways/instances/${PATHWAY_INSTANCE_ID}`,
      query: {},
    }), {
      policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS,
      recordType: 'CARE_PATHWAY',
      patient: { uid: PATIENT_UID },
      resourceContext: {
        resourceType: 'care_pathway_instance',
        resourceId: PATHWAY_INSTANCE_ID,
      },
      requireResolvedPatient: true,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/does not have a patient PHI access scope/i);
    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  });

  it('keeps pathway start on the existing capability and patient-relationship guard', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce(patientLookup());
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizePatientAccessRequest(reqFor('RADIOLOGIST', {
      method: 'POST',
      originalUrl: '/api/v1/care-pathways/instances',
      query: {},
      body: { patient_uid: PATIENT_UID },
    }), {
      policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
      recordType: 'CARE_PATHWAY',
      patient: { uid: PATIENT_UID },
      requireResolvedPatient: true,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/capability group/i);
    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  });

  it('preserves break-glass precedence for pathway instance access', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce(patientLookup())
      .mockResolvedValueOnce([{ id: 45, reason: 'Emergency pathway intervention' }]);
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizePatientAccessRequest(reqFor('ADMIN', {
      originalUrl: `/api/v1/care-pathways/instances/${PATHWAY_INSTANCE_ID}`,
      query: {},
    }), {
      policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS,
      recordType: 'CARE_PATHWAY',
      patient: { uid: PATIENT_UID },
      resourceContext: {
        resourceType: 'care_pathway_instance',
        resourceId: PATHWAY_INSTANCE_ID,
      },
      requireResolvedPatient: true,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.accessSource).toBe('break_glass');
    expect(decision.breakGlassId).toBe(45);
    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledTimes(2);
  });

  it('resolves encounter UUID resources back to the patient context', async () => {
    const encounterId = '33333333-3333-4333-8333-333333333333';
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce(patientLookup());

    const patient = await resolvePatientForResourceAccess(reqFor('DOCTOR'), {
      resourceType: 'encounter',
      resourceId: encounterId,
    });

    expect(patient).toEqual({ id: 15, uid: PATIENT_UID });
    expect(prismaMock.$queryRawUnsafe.mock.calls[0][2]).toBe(encounterId);
  });

  it('resolves pathway and handoff UUID resources through tenant-scoped patient joins', async () => {
    const pathwayId = '33333333-3333-4333-8333-333333333333';
    const handoffId = '44444444-4444-4444-8444-444444444444';
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce(patientLookup())
      .mockResolvedValueOnce(patientLookup());

    const pathwayPatient = await resolvePatientForResourceAccess(reqFor('DOCTOR'), {
      resourceType: 'care_pathway_instance',
      resourceId: pathwayId,
    });
    const handoffPatient = await resolvePatientForResourceAccess(reqFor('DOCTOR'), {
      resourceType: 'care_handoff_instance',
      resourceId: handoffId,
    });

    expect(pathwayPatient).toEqual({ id: 15, uid: PATIENT_UID });
    expect(handoffPatient).toEqual({ id: 15, uid: PATIENT_UID });
    expect(prismaMock.$queryRawUnsafe.mock.calls[0][0]).toContain('FROM care_pathway_instances');
    expect(prismaMock.$queryRawUnsafe.mock.calls[0][1]).toBe('00000000-0000-4000-8000-000000000001');
    expect(prismaMock.$queryRawUnsafe.mock.calls[0][2]).toBe(pathwayId);
    expect(prismaMock.$queryRawUnsafe.mock.calls[1][0]).toContain('FROM care_handoff_instances');
    expect(prismaMock.$queryRawUnsafe.mock.calls[1][2]).toBe(handoffId);
  });

  it('resolves owned clinical resource ids through tenant-scoped patient joins', async () => {
    const problemId = '33333333-3333-4333-8333-333333333333';
    const medRecId = '44444444-4444-4444-8444-444444444444';
    const patientEncounterId = '55555555-5555-4555-8555-555555555555';
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce(patientLookup())
      .mockResolvedValueOnce(patientLookup())
      .mockResolvedValueOnce(patientLookup())
      .mockResolvedValueOnce(patientLookup());

    await resolvePatientForResourceAccess(reqFor('DOCTOR'), {
      resourceType: 'patient_problem',
      resourceId: problemId,
    });
    await resolvePatientForResourceAccess(reqFor('DOCTOR'), {
      resourceType: 'medication_reconciliation',
      resourceId: medRecId,
    });
    await resolvePatientForResourceAccess(reqFor('DOCTOR'), {
      resourceType: 'patient_encounter',
      resourceId: patientEncounterId,
    });
    await resolvePatientForResourceAccess(reqFor('DOCTOR'), {
      resourceType: 'radiology_order',
      resourceId: '12',
    });

    expect(prismaMock.$queryRawUnsafe.mock.calls[0][0]).toContain('FROM patient_problems');
    expect(prismaMock.$queryRawUnsafe.mock.calls[0][1]).toBe('00000000-0000-4000-8000-000000000001');
    expect(prismaMock.$queryRawUnsafe.mock.calls[1][0]).toContain('FROM medication_reconciliations');
    expect(prismaMock.$queryRawUnsafe.mock.calls[2][0]).toContain('FROM patient_encounters');
    expect(prismaMock.$queryRawUnsafe.mock.calls[3][0]).toContain('FROM radiology_orders');
  });

  // Explainer-source resolvers added for the clinical-AI patient-explainer
  // IDOR guards (#7). Each must tenant-scope the lookup and join the
  // explainer's source table back to the owning patient.
  it('resolves investigation / prescription / invoice source ids through tenant-scoped patient joins', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce(patientLookup())
      .mockResolvedValueOnce(patientLookup())
      .mockResolvedValueOnce(patientLookup());

    await resolvePatientForResourceAccess(reqFor('DOCTOR'), {
      resourceType: 'investigation',
      resourceId: '42',
    });
    await resolvePatientForResourceAccess(reqFor('DOCTOR'), {
      resourceType: 'prescription',
      resourceId: '7',
    });
    await resolvePatientForResourceAccess(reqFor('DOCTOR'), {
      resourceType: 'invoice',
      resourceId: '11',
    });

    expect(prismaMock.$queryRawUnsafe.mock.calls[0][0]).toContain('FROM investigations');
    expect(prismaMock.$queryRawUnsafe.mock.calls[0][0]).toContain('i.tenant_id = $1::uuid');
    expect(prismaMock.$queryRawUnsafe.mock.calls[0][1]).toBe('00000000-0000-4000-8000-000000000001');
    expect(prismaMock.$queryRawUnsafe.mock.calls[1][0]).toContain('FROM prescriptions');
    expect(prismaMock.$queryRawUnsafe.mock.calls[1][0]).toContain('rx.tenant_id = $1::uuid');
    expect(prismaMock.$queryRawUnsafe.mock.calls[2][0]).toContain('FROM invoices');
    expect(prismaMock.$queryRawUnsafe.mock.calls[2][0]).toContain('inv.tenant_id = $1::uuid');
  });

  // The intra-tenant IDOR property: even when the explainer's source row
  // resolves to a real same-tenant patient, an actor with NO care
  // relationship to that patient is denied. This is exactly what the
  // route-level patientAccessGuardForResource('INVESTIGATION', ...) enforces
  // when a tenant is flipped to 'enforce'.
  it('denies an out-of-relationship clinician composing an explainer for a resolved patient', async () => {
    prismaMock.$queryRawUnsafe
      // resolvePatientForResourceAccess: investigation → patient row
      .mockResolvedValueOnce(patientLookup())
      // resolvePatientForAccess re-resolution inside authorize → patient row
      .mockResolvedValueOnce(patientLookup())
      // care_team / referral / appointment / admission relationship probes → none
      .mockResolvedValue([]);
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const patient = await resolvePatientForResourceAccess(
      reqFor('DOCTOR', { body: { investigation_id: 42 } }),
      { resourceType: 'investigation', resourceId: '42' },
    );
    expect(patient).toEqual({ id: 15, uid: PATIENT_UID });

    const decision = await authorizePatientAccessRequest(
      reqFor('DOCTOR', { body: { investigation_id: 42 } }),
      {
        policyCode: ACCESS_POLICY_CODES.PATIENT_INVESTIGATION_VIEW,
        recordType: 'INVESTIGATION',
        patient,
        resourceContext: { resourceType: 'investigation', resourceId: '42' },
        requireResolvedPatient: true,
      },
    );

    expect(decision.allowed).toBe(false);
    expect(decision.accessDecision).toBe('deny');
    expect(decision.reason).toMatch(/relationship/i);
  });
});
