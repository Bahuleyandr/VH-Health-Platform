import { createHash } from 'node:crypto';

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
const HANDOFF_INSTANCE_ID = '66666666-6666-4666-8666-666666666666';

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
      rawRole: role,
      tenant_id: '00000000-0000-4000-8000-000000000001',
      ...extras.user,
    },
    ...extras,
  };
}

function patientLookup() {
  return [{ id: 15, uid: PATIENT_UID }];
}

function ownershipIdempotencyKey(operation, rawKey, actorUid = ACTOR_UID) {
  const digest = createHash('sha256')
    .update(JSON.stringify({ operation, rawKey }))
    .digest('hex');
  return `u:${actorUid}:${digest}`;
}

function idempotencyHeader(rawKey) {
  return (name) => String(name).toLowerCase() === 'idempotency-key' ? rawKey : undefined;
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
    expect(prismaMock.$queryRawUnsafe.mock.calls[2][0])
      .toMatch(/UPPER\(BTRIM\(COALESCE\(a\.status, ''\)\)\) NOT IN/);
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

  it('allows but marks an unresolved patient denial in shadow mode', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([]);
    const req = reqFor('DOCTOR');

    const decision = await authorizePatientAccessRequest(req, {
      policyCode: ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW,
      recordType: 'MEDICAL_RECORD',
      patient: { id: 15 },
      requireResolvedPatient: true,
      shadowMode: true,
    });

    expect(decision).toEqual(expect.objectContaining({
      allowed: true,
      shadow_denied: true,
      shadow_mode: true,
      no_patient_context: true,
    }));
    expect(req.patientAccessDecision).toEqual(expect.objectContaining({
      allowed: false,
      shadow_mode: true,
      no_patient_context: true,
    }));
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
    expect(prismaMock.$queryRawUnsafe.mock.calls[3][0])
      .toMatch(/LOWER\(BTRIM\(COALESCE\(status, ''\)\)\) IN \('admitted', 'transferred'\)/);
  });

  it('grants ICU_STAFF the inpatient admission relationship only for MAR access', async () => {
    prismaMock.$queryRawUnsafe.mockImplementation(async (sql) => {
      if (sql.includes('FROM users') && sql.includes('role = \'PATIENT\'')) {
        return patientLookup();
      }
      if (/SELECT id\s+FROM admissions/.test(sql)) return [{ id: 27 }];
      return [];
    });
    prismaMock.$executeRawUnsafe.mockResolvedValue(undefined);

    const marDecision = await authorizePatientAccessRequest(reqFor('ICU_STAFF', {
      method: 'POST',
      originalUrl: '/api/v1/clinical/mar/41/hold',
      query: {},
      body: {},
    }), {
      policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
      recordType: 'MAR',
      patient: { uid: PATIENT_UID },
    });

    expect(marDecision.allowed).toBe(true);
    expect(marDecision.accessSource).toBe('admission');
    expect(marDecision.actor_role).toBe('ICU_STAFF');
    expect(prismaMock.$executeRawUnsafe.mock.calls[0][4]).toBe('ICU_STAFF');

    prismaMock.$queryRawUnsafe.mockClear();
    prismaMock.$executeRawUnsafe.mockClear();

    const genericDecision = await authorizePatientAccessRequest(reqFor('ICU_STAFF', {
      method: 'POST',
      originalUrl: '/api/v1/clinical/progress-notes',
      query: {},
      body: {},
    }), {
      policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
      recordType: 'CLINICAL_WORKFLOW',
      patient: { uid: PATIENT_UID },
    });

    expect(genericDecision.allowed).toBe(false);
    expect(genericDecision.actor_role).toBe('ICU_STAFF');
    expect(prismaMock.$queryRawUnsafe.mock.calls.some(
      ([sql]) => /SELECT id\s+FROM admissions/.test(sql),
    )).toBe(false);
    expect(prismaMock.$executeRawUnsafe.mock.calls[0][4]).toBe('ICU_STAFF');
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

  it.each([
    [ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS, 'GET'],
    [ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE, 'POST'],
  ])('allows the current exact covering-transfer recipient for %s', async (policyCode, method) => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce(patientLookup())
      .mockResolvedValueOnce([{
        id: HANDOFF_INSTANCE_ID,
        care_pathway_instance_id: PATHWAY_INSTANCE_ID,
      }]);
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizePatientAccessRequest(reqFor('RADIOLOGIST', {
      method,
      originalUrl: `/api/v1/care-pathways/handoffs/${HANDOFF_INSTANCE_ID}/accept`,
      query: {},
    }), {
      policyCode,
      recordType: 'CARE_PATHWAY',
      patient: { uid: PATIENT_UID },
      resourceContext: {
        resourceType: 'care_handoff_instance',
        resourceId: HANDOFF_INSTANCE_ID,
      },
      requireResolvedPatient: true,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.accessSource).toBe('care_pathway_transfer_recipient');
    expect(decision.careHandoffInstanceId).toBe(HANDOFF_INSTANCE_ID);
    expect(decision.carePathwayInstanceId).toBe(PATHWAY_INSTANCE_ID);

    const recipientLookup = prismaMock.$queryRawUnsafe.mock.calls[1];
    expect(recipientLookup[0]).toContain('FROM care_handoff_instances chi');
    expect(recipientLookup[0]).toContain("chi.handoff_type = 'covering_clinician_reassignment'");
    expect(recipientLookup[0]).toContain("chi.recipient_kind = 'user'");
    expect(recipientLookup[0]).toContain('chi.intended_recipient_uid = $4::uuid');
    expect(recipientLookup[0]).toContain("chi.status = 'requested'");
    expect(recipientLookup[0]).toContain("chi.status = 'accepted'");
    expect(recipientLookup[0]).not.toContain("chi.status = 'declined'");
    expect(recipientLookup[0]).not.toContain("chi.status = 'cancelled'");
    expect(recipientLookup[0]).toContain('chi.accepted_by_uid = chi.intended_recipient_uid');
    expect(recipientLookup[0]).toContain("review_task.status = 'completed'");
    expect(recipientLookup[0]).toContain('review_task.workflow_run_id IS NULL');
    expect(recipientLookup[0]).toContain('review_task.workflow_step_id IS NULL');
    expect(recipientLookup[0]).toContain("review_task.related_resource_type = 'care_handoff_instance'");
    expect(recipientLookup[0]).toContain('review_task.related_resource_id = chi.id::text');
    expect(recipientLookup[0]).toContain('review_task.assigned_to_uid = chi.intended_recipient_uid');
    expect(recipientLookup[0]).toContain('review_task.assigned_to_role IS NULL');
    expect(recipientLookup[0]).toContain('review_task.workflow_sla_instance_id IS NULL');
    expect(recipientLookup[0]).toContain("review_task.sla_completion_semantics = 'none'");
    expect(recipientLookup[0]).toContain('UPPER(BTRIM(recipient.role)) = $5::text');
    expect(recipientLookup[0]).toContain('recipient.is_active = TRUE');
    expect(recipientLookup[0]).toContain("LOWER(COALESCE(recipient.status, '')) = 'active'");
    expect(recipientLookup[0]).toContain('recipient.is_deleted IS FALSE');
    expect(recipientLookup[0]).toContain('recipient.deleted_at IS NULL');
    expect(recipientLookup.slice(1)).toEqual([
      '00000000-0000-4000-8000-000000000001',
      HANDOFF_INSTANCE_ID,
      PATIENT_UID,
      ACTOR_UID,
      'RADIOLOGIST',
    ]);
    expect(prismaMock.$executeRawUnsafe.mock.calls[0][6])
      .toBe('care_pathway_transfer_recipient');
    expect(JSON.parse(prismaMock.$executeRawUnsafe.mock.calls[0][13]))
      .toEqual(expect.objectContaining({
        care_handoff_instance_id: HANDOFF_INSTANCE_ID,
        care_pathway_instance_id: PATHWAY_INSTANCE_ID,
      }));
  });

  it.each(['requested', 'accepted', 'declined', 'cancelled'])(
    'allows the exact recipient to read a coherent %s covering transfer without granting broader workflow access',
    async () => {
      prismaMock.$queryRawUnsafe
        .mockResolvedValueOnce(patientLookup())
        .mockResolvedValueOnce([{
          id: HANDOFF_INSTANCE_ID,
          care_pathway_instance_id: PATHWAY_INSTANCE_ID,
        }]);
      prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

      const decision = await authorizePatientAccessRequest(reqFor('RADIOLOGIST', {
        method: 'GET',
        originalUrl: `/api/v1/care-pathways/handoffs/${HANDOFF_INSTANCE_ID}`,
        query: {},
      }), {
        policyCode: ACCESS_POLICY_CODES.PATIENT_CARE_PATHWAY_TRANSFER_READ,
        recordType: 'CARE_PATHWAY',
        patient: { uid: PATIENT_UID },
        resourceContext: {
          resourceType: 'care_handoff_instance',
          resourceId: HANDOFF_INSTANCE_ID,
        },
        requireResolvedPatient: true,
      });

      expect(decision.allowed).toBe(true);
      expect(decision.accessSource).toBe('care_pathway_transfer_recipient');
      expect(decision.careHandoffInstanceId).toBe(HANDOFF_INSTANCE_ID);
      expect(decision.carePathwayInstanceId).toBe(PATHWAY_INSTANCE_ID);
      const recipientLookup = prismaMock.$queryRawUnsafe.mock.calls[1];
      expect(recipientLookup[0]).toContain("chi.handoff_type = 'covering_clinician_reassignment'");
      expect(recipientLookup[0]).toContain("chi.recipient_kind = 'user'");
      expect(recipientLookup[0]).toContain('chi.intended_recipient_uid = $4::uuid');
      expect(recipientLookup[0]).toContain("chi.status = 'requested'");
      expect(recipientLookup[0]).toContain("chi.status = 'accepted'");
      expect(recipientLookup[0]).toContain("chi.status = 'declined'");
      expect(recipientLookup[0]).toContain("chi.status = 'cancelled'");
      expect(recipientLookup[0]).toContain('review_task.cancellation_reason IS NOT DISTINCT FROM chi.decline_reason');
      expect(recipientLookup[0]).toContain('review_task.cancellation_reason IS NOT DISTINCT FROM chi.cancellation_reason');
      expect(recipientLookup[0]).toContain("evidence.transition_scope = 'handoff'");
      expect(recipientLookup[0]).toContain("WHEN 'accepted' THEN 'pathway_owner_transfer_accepted'");
      expect(recipientLookup[0]).toContain("WHEN 'declined' THEN 'pathway_owner_transfer_declined'");
      expect(recipientLookup[0]).toContain("WHEN 'cancelled' THEN 'pathway_owner_transfer_cancelled'");
      expect(recipientLookup[0]).toContain("evidence.source_resource_type = 'care_handoff_instance'");
      expect(recipientLookup[0]).toContain('evidence.source_resource_id = chi.id::text');
      expect(recipientLookup[0]).toContain('evidence.effect_ordinal = 0');
      expect(recipientLookup[0]).toContain("evidence.new_state ->> 'transfer_status' = chi.status");
      expect(recipientLookup[0]).toContain('UPPER(BTRIM(recipient.role)) = $5::text');
      expect(recipientLookup[0]).not.toContain("chi.recipient_kind = 'role'");
      expect(recipientLookup.slice(1)).toEqual([
        '00000000-0000-4000-8000-000000000001',
        HANDOFF_INSTANCE_ID,
        PATIENT_UID,
        ACTOR_UID,
        'RADIOLOGIST',
      ]);
      expect(prismaMock.$executeRawUnsafe.mock.calls[0][6])
        .toBe('care_pathway_transfer_recipient');
    },
  );

  it.each([
    'wrong recipient',
    'inactive recipient',
    'database role moved after token issue',
    'unbound task',
    'terminal state without immutable transition evidence',
  ])('denies the dedicated covering-transfer read when the relationship is %s', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce(patientLookup())
      .mockResolvedValueOnce([]);
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizePatientAccessRequest(reqFor('RADIOLOGIST', {
      method: 'GET',
      query: {},
    }), {
      policyCode: ACCESS_POLICY_CODES.PATIENT_CARE_PATHWAY_TRANSFER_READ,
      recordType: 'CARE_PATHWAY',
      patient: { uid: PATIENT_UID },
      resourceContext: {
        resourceType: 'care_handoff_instance',
        resourceId: HANDOFF_INSTANCE_ID,
      },
      requireResolvedPatient: true,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.accessSource).toBe('unknown');
    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledTimes(2);
  });

  it.each([
    'wrong recipient',
    'inactive recipient',
    'deleted recipient',
    'database role no longer matches the authenticated role',
    'request source owner has changed',
  ])('denies a covering-transfer recipient when the relationship is %s', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce(patientLookup())
      .mockResolvedValueOnce([]);
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizePatientAccessRequest(reqFor('RADIOLOGIST', {
      method: 'POST',
      originalUrl: `/api/v1/care-pathways/handoffs/${HANDOFF_INSTANCE_ID}/accept`,
      query: {},
    }), {
      policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
      recordType: 'CARE_PATHWAY',
      patient: { uid: PATIENT_UID },
      resourceContext: {
        resourceType: 'care_handoff_instance',
        resourceId: HANDOFF_INSTANCE_ID,
      },
      requireResolvedPatient: true,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.accessSource).toBe('unknown');
    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledTimes(2);
  });

  it('never probes transfer-recipient authority for an invalid handoff UUID', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce(patientLookup());
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizePatientAccessRequest(reqFor('RADIOLOGIST', { query: {} }), {
      policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
      recordType: 'CARE_PATHWAY',
      patient: { uid: PATIENT_UID },
      resourceContext: {
        resourceType: 'care_handoff_instance',
        resourceId: 'not-a-uuid',
      },
      requireResolvedPatient: true,
    });

    expect(decision.allowed).toBe(false);
    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  });

  it('allows only the current exact role holder to reach an unnamed pathway claim', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce(patientLookup())
      .mockResolvedValueOnce([{ id: PATHWAY_INSTANCE_ID, task_id: 731 }]);
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizePatientAccessRequest(reqFor('RADIOLOGIST', {
      method: 'POST',
      originalUrl: `/api/v1/care-pathways/instances/${PATHWAY_INSTANCE_ID}/claim`,
      query: {},
      get: idempotencyHeader('claim-retry-1'),
    }), {
      policyCode: ACCESS_POLICY_CODES.PATIENT_CARE_PATHWAY_QUEUE_CLAIM,
      recordType: 'CARE_PATHWAY',
      patient: { uid: PATIENT_UID },
      resourceContext: {
        resourceType: 'care_pathway_instance',
        resourceId: PATHWAY_INSTANCE_ID,
      },
      requireResolvedPatient: true,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.accessSource).toBe('care_pathway_role_queue_claimant');
    expect(decision.carePathwayInstanceId).toBe(PATHWAY_INSTANCE_ID);
    expect(decision.carePathwayTaskId).toBe(731);

    const claimantLookup = prismaMock.$queryRawUnsafe.mock.calls[1];
    expect(claimantLookup[0]).toContain('cpi.owning_clinician_uid IS NULL');
    expect(claimantLookup[0]).toContain("cpi.clinical_status IN ('planned', 'active', 'on_hold')");
    expect(claimantLookup[0]).toContain('step.step_key = run.current_step_key');
    expect(claimantLookup[0]).toContain("step.step_kind IN ('task', 'approval')");
    expect(claimantLookup[0]).toContain("task.status IN ('open', 'in_progress', 'blocked', 'overdue')");
    expect(claimantLookup[0]).toContain("task.related_resource_type = 'care_pathway_instance'");
    expect(claimantLookup[0]).toContain('task.related_resource_id = cpi.id::text');
    expect(claimantLookup[0]).toContain('task.assigned_to_uid IS NULL');
    expect(claimantLookup[0]).toContain('UPPER(BTRIM(task.assigned_to_role)) = $5::text');
    expect(claimantLookup[0]).toContain('UPPER(BTRIM(claimant.role)) = $7::text');
    expect(claimantLookup[0]).toContain('claimant.is_active = TRUE');
    expect(claimantLookup[0]).toContain("LOWER(COALESCE(claimant.status, '')) = 'active'");
    expect(claimantLookup[0]).toContain('claimant.is_deleted IS FALSE');
    expect(claimantLookup[0]).toContain('claimant.deleted_at IS NULL');
    expect(claimantLookup[0]).toContain("evidence.transition_key = 'pathway_owner_claimed'");
    expect(claimantLookup[0]).toContain("evidence.transition_scope = 'pathway'");
    expect(claimantLookup[0]).toContain("evidence.source_resource_type = 'care_pathway_instance'");
    expect(claimantLookup[0]).toContain('evidence.source_resource_id = cpi.id::text');
    expect(claimantLookup[0]).toContain('evidence.actor_uid = $4::uuid');
    expect(claimantLookup[0]).toContain('evidence.idempotency_key = $6::text');
    expect(claimantLookup[0]).toContain('evidence.effect_ordinal = 0');
    expect(claimantLookup.slice(1)).toEqual([
      '00000000-0000-4000-8000-000000000001',
      PATHWAY_INSTANCE_ID,
      PATIENT_UID,
      ACTOR_UID,
      'RADIOLOGIST',
      ownershipIdempotencyKey('claim_care_pathway_owner', 'claim-retry-1'),
      'RADIOLOGIST',
    ]);
    expect(prismaMock.$executeRawUnsafe.mock.calls[0][6])
      .toBe('care_pathway_role_queue_claimant');
    expect(JSON.parse(prismaMock.$executeRawUnsafe.mock.calls[0][13]))
      .toEqual(expect.objectContaining({
        care_pathway_instance_id: PATHWAY_INSTANCE_ID,
        care_pathway_task_id: 731,
      }));
  });

  it('allows an exact claim replay only through its immutable actor-and-key transition', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce(patientLookup())
      .mockResolvedValueOnce([{ id: PATHWAY_INSTANCE_ID, task_id: null }]);
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizePatientAccessRequest(reqFor('RADIOLOGIST', {
      method: 'POST',
      originalUrl: `/api/v1/care-pathways/instances/${PATHWAY_INSTANCE_ID}/claim`,
      query: {},
      get: idempotencyHeader('claim-retry-2'),
    }), {
      policyCode: ACCESS_POLICY_CODES.PATIENT_CARE_PATHWAY_QUEUE_CLAIM,
      recordType: 'CARE_PATHWAY',
      patient: { uid: PATIENT_UID },
      resourceContext: {
        resourceType: 'care_pathway_instance',
        resourceId: PATHWAY_INSTANCE_ID,
      },
      requireResolvedPatient: true,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.accessSource).toBe('care_pathway_role_queue_claimant');
    const claimantLookup = prismaMock.$queryRawUnsafe.mock.calls[1];
    expect(claimantLookup.slice(1)).toEqual([
      '00000000-0000-4000-8000-000000000001',
      PATHWAY_INSTANCE_ID,
      PATIENT_UID,
      ACTOR_UID,
      'RADIOLOGIST',
      ownershipIdempotencyKey('claim_care_pathway_owner', 'claim-retry-2'),
      'RADIOLOGIST',
    ]);
  });

  it('uses the canonical queue role while requiring exact raw database-role parity for an alias', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce(patientLookup())
      .mockResolvedValueOnce([{ id: PATHWAY_INSTANCE_ID, task_id: 732 }]);
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizePatientAccessRequest(reqFor('DUTY_DOCTOR', {
      method: 'POST',
      query: {},
      user: {
        id: 9,
        uid: ACTOR_UID,
        role: 'DUTY_DOCTOR',
        rawRole: 'DMO',
        tenant_id: '00000000-0000-4000-8000-000000000001',
      },
      get: idempotencyHeader('alias-claim'),
    }), {
      policyCode: ACCESS_POLICY_CODES.PATIENT_CARE_PATHWAY_QUEUE_CLAIM,
      recordType: 'CARE_PATHWAY',
      patient: { uid: PATIENT_UID },
      resourceContext: {
        resourceType: 'care_pathway_instance',
        resourceId: PATHWAY_INSTANCE_ID,
      },
      requireResolvedPatient: true,
    });

    expect(decision.allowed).toBe(true);
    const claimantLookup = prismaMock.$queryRawUnsafe.mock.calls[1];
    expect(claimantLookup[5]).toBe('DUTY_DOCTOR');
    expect(claimantLookup[7]).toBe('DMO');
  });

  it.each([undefined, '', 'bad key with spaces'])('never derives claim replay evidence from an invalid Idempotency-Key %p', async (rawKey) => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce(patientLookup())
      .mockResolvedValueOnce([]);
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    await authorizePatientAccessRequest(reqFor('RADIOLOGIST', {
      method: 'POST',
      query: {},
      get: idempotencyHeader(rawKey),
    }), {
      policyCode: ACCESS_POLICY_CODES.PATIENT_CARE_PATHWAY_QUEUE_CLAIM,
      recordType: 'CARE_PATHWAY',
      patient: { uid: PATIENT_UID },
      resourceContext: {
        resourceType: 'care_pathway_instance',
        resourceId: PATHWAY_INSTANCE_ID,
      },
      requireResolvedPatient: true,
    });

    expect(prismaMock.$queryRawUnsafe.mock.calls[1][6]).toBeNull();
  });

  it.each(['requested recipient', 'exact declined replay'])(
    'allows a %s only through the dedicated transfer-decline policy',
    async () => {
      prismaMock.$queryRawUnsafe
        .mockResolvedValueOnce(patientLookup())
        .mockResolvedValueOnce([{
          id: HANDOFF_INSTANCE_ID,
          care_pathway_instance_id: PATHWAY_INSTANCE_ID,
          task_id: 844,
        }]);
      prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

      const decision = await authorizePatientAccessRequest(reqFor('RADIOLOGIST', {
        method: 'POST',
        originalUrl: `/api/v1/care-pathways/handoffs/${HANDOFF_INSTANCE_ID}/decline`,
        query: {},
        get: idempotencyHeader('decline-retry-1'),
      }), {
        policyCode: ACCESS_POLICY_CODES.PATIENT_CARE_PATHWAY_TRANSFER_DECLINE,
        recordType: 'CARE_PATHWAY',
        patient: { uid: PATIENT_UID },
        resourceContext: {
          resourceType: 'care_handoff_instance',
          resourceId: HANDOFF_INSTANCE_ID,
        },
        requireResolvedPatient: true,
      });

      expect(decision.allowed).toBe(true);
      expect(decision.accessSource).toBe('care_pathway_transfer_decline_recipient');
      expect(decision.careHandoffInstanceId).toBe(HANDOFF_INSTANCE_ID);
      expect(decision.carePathwayInstanceId).toBe(PATHWAY_INSTANCE_ID);
      expect(decision.carePathwayTaskId).toBe(844);
      const declineLookup = prismaMock.$queryRawUnsafe.mock.calls[1];
      expect(declineLookup[0]).toContain("chi.status = 'requested'");
      expect(declineLookup[0]).toContain("chi.status = 'declined'");
      expect(declineLookup[0]).toContain("evidence.transition_key = 'pathway_owner_transfer_declined'");
      expect(declineLookup[0]).toContain("evidence.transition_scope = 'handoff'");
      expect(declineLookup[0]).toContain("evidence.source_resource_type = 'care_handoff_instance'");
      expect(declineLookup[0]).toContain('evidence.source_resource_id = chi.id::text');
      expect(declineLookup[0]).toContain('evidence.actor_uid = $4::uuid');
      expect(declineLookup[0]).toContain('evidence.idempotency_key = $6::text');
      expect(declineLookup[0]).toContain('evidence.effect_ordinal = 0');
      expect(declineLookup.slice(1)).toEqual([
        '00000000-0000-4000-8000-000000000001',
        HANDOFF_INSTANCE_ID,
        PATIENT_UID,
        ACTOR_UID,
        'RADIOLOGIST',
        ownershipIdempotencyKey(
          'decline_care_pathway_owner_transfer',
          'decline-retry-1',
        ),
      ]);
      expect(prismaMock.$executeRawUnsafe.mock.calls[0][6])
        .toBe('care_pathway_transfer_decline_recipient');
    },
  );

  it('does not expose declined-transfer replay authority to ordinary workflow policies', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce(patientLookup())
      .mockResolvedValueOnce([]);
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizePatientAccessRequest(reqFor('RADIOLOGIST', {
      method: 'POST',
      query: {},
      get: idempotencyHeader('decline-retry-ordinary'),
    }), {
      policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
      recordType: 'CARE_PATHWAY',
      patient: { uid: PATIENT_UID },
      resourceContext: {
        resourceType: 'care_handoff_instance',
        resourceId: HANDOFF_INSTANCE_ID,
      },
      requireResolvedPatient: true,
    });

    expect(decision.allowed).toBe(false);
    const ordinaryLookupSql = prismaMock.$queryRawUnsafe.mock.calls[1][0];
    expect(ordinaryLookupSql).not.toContain('pathway_owner_transfer_declined');
    expect(ordinaryLookupSql).not.toContain('care_pathway_transfer_decline_recipient');
  });

  it.each([
    'named instance',
    'wrong current step role',
    'missing actionable current-step task',
    'inactive claimant',
    'database role moved after token issue',
    'cross-tenant claimant',
  ])('denies claim-only pathway access for a %s', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce(patientLookup())
      .mockResolvedValueOnce([]);
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizePatientAccessRequest(reqFor('RADIOLOGIST', {
      method: 'POST',
      originalUrl: `/api/v1/care-pathways/instances/${PATHWAY_INSTANCE_ID}/claim`,
      query: {},
    }), {
      policyCode: ACCESS_POLICY_CODES.PATIENT_CARE_PATHWAY_QUEUE_CLAIM,
      recordType: 'CARE_PATHWAY',
      patient: { uid: PATIENT_UID },
      resourceContext: {
        resourceType: 'care_pathway_instance',
        resourceId: PATHWAY_INSTANCE_ID,
      },
      requireResolvedPatient: true,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.accessSource).toBe('unknown');
    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledTimes(2);
  });

  it('never grants ordinary pathway access through the claim-only relationship', async () => {
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
    const claimantQueries = prismaMock.$queryRawUnsafe.mock.calls.filter(
      ([sql]) => sql.includes('care_pathway_role_queue_claimant')
        || sql.includes('JOIN users claimant'),
    );
    expect(claimantQueries).toHaveLength(0);
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
        rawRole: 'RADIOLOGIST',
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

  it('resolves an ED continuity visit through an exact tenant-scoped patient join', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce(patientLookup());

    const patient = await resolvePatientForResourceAccess(reqFor('DOCTOR'), {
      resourceType: 'emergency_visit',
      resourceId: '73',
    });

    expect(patient).toEqual({ id: 15, uid: PATIENT_UID });
    expect(prismaMock.$queryRawUnsafe.mock.calls[0][0])
      .toContain('FROM emergency_visits visit');
    expect(prismaMock.$queryRawUnsafe.mock.calls[0][0])
      .toContain('visit.tenant_id = $1::uuid');
    expect(prismaMock.$queryRawUnsafe.mock.calls[0].slice(1)).toEqual([
      '00000000-0000-4000-8000-000000000001',
      73,
    ]);
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

  it('resolves every patient-owned oncology resource through a tenant-scoped join', async () => {
    const resourceTypes = [
      ['chemo_treatment_plan', 'chemo_treatment_plans', 73],
      ['chemo_cycle', 'chemo_cycles', 73],
      ['chair_booking', 'chair_bookings', 73],
      ['chemo_administration', 'chemo_administrations', 73],
      ['pathology_report', 'ap_reports', '73'],
      ['oncology_diagnosis', 'oncology_diagnoses', '73'],
      ['oncology_staging_record', 'oncology_staging_records', '73'],
      ['oncology_toxicity_event', 'oncology_toxicity_events', '73'],
      ['tumor_board_case', 'tumor_board_cases', '73'],
      ['tumor_board_recommendation', 'tumor_board_recommendations', '73'],
    ];
    prismaMock.$queryRawUnsafe.mockResolvedValue(patientLookup());

    for (const [resourceType] of resourceTypes) {
      const patient = await resolvePatientForResourceAccess(reqFor('DOCTOR'), {
        resourceType,
        resourceId: '73',
      });
      expect(patient).toEqual({ id: 15, uid: PATIENT_UID });
    }

    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledTimes(resourceTypes.length);
    resourceTypes.forEach(([, table, expectedId], index) => {
      const [sql, tenantId, resourceId] = prismaMock.$queryRawUnsafe.mock.calls[index];
      expect(sql).toContain(`FROM ${table}`);
      expect(sql).toContain('tenant_id = $1::uuid');
      expect(tenantId).toBe('00000000-0000-4000-8000-000000000001');
      expect(resourceId).toBe(expectedId);
    });
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

describe('patient realtime subscription access decisions', () => {
  const realtimeAccess = {
    policyCode: ACCESS_POLICY_CODES.PATIENT_REALTIME_SUBSCRIBE,
    recordType: 'REALTIME_PATIENT_CHANNEL',
    patient: { uid: PATIENT_UID },
    requireResolvedPatient: true,
    shadowMode: false,
  };

  it('allows the patient owner after resolving the subject inside the tenant', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce(patientLookup());
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const req = reqFor('PATIENT', { query: {} });
    req.user.uid = PATIENT_UID;
    const decision = await authorizePatientAccessRequest(req, realtimeAccess);

    expect(decision).toMatchObject({
      allowed: true,
      accessSource: 'guardian',
      policy_code: 'patient.realtime.subscribe',
      patient_uid: PATIENT_UID,
    });
    expect(prismaMock.$queryRawUnsafe.mock.calls[0][1]).toBe(
      '00000000-0000-4000-8000-000000000001',
    );
  });

  it('attributes a delegated-subject decision to the guardian actor', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce(patientLookup());
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const req = reqFor('PATIENT', {
      query: {},
      acting: {
        actorUid: ACTOR_UID,
        actorRole: 'PATIENT',
        actorRawRole: 'PATIENT',
        subjectUid: PATIENT_UID,
      },
    });
    req.user.uid = PATIENT_UID;
    const decision = await authorizePatientAccessRequest(req, realtimeAccess);

    expect(decision).toMatchObject({ allowed: true, actor_uid: ACTOR_UID });
    expect(prismaMock.$executeRawUnsafe.mock.calls[0][3]).toBe(ACTOR_UID);
  });

  it('allows an active care-team member without broad role-owned access', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce(patientLookup())
      .mockResolvedValueOnce([{ id: 72, care_team_id: 44 }]);
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizePatientAccessRequest(reqFor('DOCTOR', { query: {} }), realtimeAccess);

    expect(decision).toMatchObject({
      allowed: true,
      accessSource: 'care_team',
      careTeamId: 44,
    });
    expect(prismaMock.$queryRawUnsafe.mock.calls[1][0]).toMatch(/care_team_members/);
    expect(prismaMock.$queryRawUnsafe.mock.calls[1][0])
      .toMatch(/LOWER\(BTRIM\(COALESCE\(ct\.team_kind, ''\)\)\) = 'longitudinal'/);
    expect(prismaMock.$queryRawUnsafe.mock.calls[1][0])
      .toMatch(/appointment\.appointment_date >= \(CURRENT_DATE - INTERVAL '30 days'\)/);
    expect(prismaMock.$queryRawUnsafe.mock.calls[1][0])
      .toMatch(/LOWER\(BTRIM\(COALESCE\(admission\.status, ''\)\)\) IN \('admitted', 'transferred'\)/);
  });

  it('allows an active break-glass decision', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce(patientLookup())
      .mockResolvedValueOnce([{ id: 45, reason: 'Emergency appointment access' }]);
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizePatientAccessRequest(reqFor('ADMIN', { query: {} }), realtimeAccess);

    expect(decision).toMatchObject({
      allowed: true,
      accessSource: 'break_glass',
      breakGlassId: 45,
    });
  });

  it.each(['DOCTOR', 'ADMIN', 'SUPER_ADMIN'])(
    'denies an unrelated %s without an active relationship',
    async (role) => {
      prismaMock.$queryRawUnsafe
        .mockResolvedValueOnce(patientLookup())
        .mockResolvedValue([]);
      prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

      const decision = await authorizePatientAccessRequest(reqFor(role, { query: {} }), realtimeAccess);

      expect(decision).toMatchObject({
        allowed: false,
        accessDecision: 'deny',
        policy_code: 'patient.realtime.subscribe',
      });
    },
  );

  it('denies when the patient does not resolve inside the socket tenant', async () => {
    const otherTenant = '00000000-0000-4000-8000-000000000002';
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([]);

    const req = reqFor('PATIENT', { tenantId: otherTenant, query: {} });
    req.user.uid = PATIENT_UID;
    req.user.tenant_id = otherTenant;
    const decision = await authorizePatientAccessRequest(req, realtimeAccess);

    expect(decision).toMatchObject({
      allowed: false,
      no_patient_context: true,
      policy_code: 'patient.realtime.subscribe',
    });
    expect(prismaMock.$queryRawUnsafe.mock.calls[0][1]).toBe(otherTenant);
  });
});
