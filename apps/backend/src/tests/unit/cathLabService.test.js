import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const setTenantTxMock = jest.fn(async (_tenantId, fn) => fn(__prismaDefaultMock));
const recordCanonicalClinicalEventMock = jest.fn(async () => ({
  timeline: { id: '44444444-4444-4444-8444-444444444444' },
  audit: { id: '55555555-5555-4555-8555-555555555555' }
}));
// NL13-P1f: cathLabService now reaches cathSchedulingRegistryService, which
// imports the audit-only recorder — the module mock must export it too.
const recordClinicalAuditEventMock = jest.fn(async () => ({
  id: '66666666-6666-4666-8666-666666666666'
}));
const startWorkflowSlaMock = jest.fn();
const completeWorkflowSlaMock = jest.fn();
const assertPrivilegeForGateMock = jest.fn(async () => ({ allowed: true }));
const isGateEnabledMock = jest.fn(key => process.env[key] === 'true');
const privilegeKeyMock = jest.fn(value => String(value).trim().toLowerCase());

const __prismaDefaultMock = { $queryRawUnsafe: queryUnsafeMock };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: setTenantTxMock
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: tenantId => tenantId || '00000000-0000-4000-8000-000000000001'
}));

jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  completeWorkflowSla: completeWorkflowSlaMock,
  recordCanonicalClinicalEvent: recordCanonicalClinicalEventMock,
  recordClinicalAuditEvent: recordClinicalAuditEventMock,
  startWorkflowSla: startWorkflowSlaMock
}));

jest.unstable_mockModule('../../services/staff/credentialingService.js', () => ({
  assertPrivilegeForGate: assertPrivilegeForGateMock,
  isGateEnabled: isGateEnabledMock,
  privilegeKey: privilegeKeyMock
}));

const {
  READINESS_TYPES,
  addContrastRadiationRecord,
  addDeviceLink,
  cathLabPrivilegeGateConfig,
  evaluateReadinessGate,
  recordProcedureLog,
  validateCaseTransition,
  validateContrastRadiationInput
} = await import('../../services/clinical/cathLabService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '11111111-1111-4111-8111-111111111111';
const ENCOUNTER = '22222222-2222-4222-8222-222222222222';
const ACTOR = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  queryUnsafeMock.mockReset();
  setTenantTxMock.mockClear();
  recordCanonicalClinicalEventMock.mockClear();
  startWorkflowSlaMock.mockClear();
  completeWorkflowSlaMock.mockClear();
  assertPrivilegeForGateMock.mockClear();
  isGateEnabledMock.mockClear();
  privilegeKeyMock.mockClear();
  delete process.env.CATH_LAB_PRIVILEGE_KEY;
  delete process.env.CATH_LAB_PRIVILEGE_GATE_ENABLED;
});

function cathCase(status = 'ready') {
  return {
    id: 42,
    tenant_id: TENANT,
    patient_uid: PATIENT,
    encounter_id: ENCOUNTER,
    requested_procedure: 'Primary PCI',
    status,
    sla_rule_code: null,
    sla_instance_id: null
  };
}

function clearedReadinessRows() {
  return READINESS_TYPES.map((check_type, index) => ({
    id: index + 1,
    check_type,
    status: check_type === 'blood_bank' ? 'not_applicable' : 'pass',
    required: true
  }));
}

describe('cathLabService guards', () => {
  test('blocks procedure start until every required readiness check is clear', () => {
    const gate = evaluateReadinessGate([
      { check_type: 'consent', status: 'pass', required: true },
      { check_type: 'labs', status: 'fail', required: true },
      { check_type: 'blood_bank', status: 'pending', required: false }
    ]);

    expect(gate.ready).toBe(false);
    expect(gate.blocking).toEqual(
      expect.arrayContaining([
        { check_type: 'labs', reason: 'fail' },
        { check_type: 'allergy_renal_risk', reason: 'missing' }
      ])
    );
  });

  test('allows only explicit case status transitions', () => {
    expect(validateCaseTransition('ready', 'in_progress')).toBe('in_progress');
    expect(() => validateCaseTransition('scheduled', 'completed')).toThrow(
      'Invalid state transition'
    );
  });

  test('requires at least one non-negative contrast or radiation metric', () => {
    expect(validateContrastRadiationInput({ contrast_volume_ml: 125 })).toMatchObject({
      contrast_volume_ml: 125
    });
    expect(() => validateContrastRadiationInput({})).toThrow('At least one contrast');
    expect(() => validateContrastRadiationInput({ air_kerma_mgy: -1 })).toThrow('non-negative');
  });

  test('keeps the cath-lab privilege gate inert until the owner-supplied key is enabled', () => {
    expect(cathLabPrivilegeGateConfig()).toEqual({
      key: 'cath_lab_owner_supplied_privilege',
      enabled: false
    });

    process.env.CATH_LAB_PRIVILEGE_KEY = 'CATH_PRIV_OWNER_APPROVED';
    process.env.CATH_LAB_PRIVILEGE_GATE_ENABLED = 'true';

    expect(cathLabPrivilegeGateConfig()).toEqual({
      key: 'cath_priv_owner_approved',
      enabled: true
    });
  });
});

describe('cathLabService procedure and device ledgers', () => {
  test('records a procedure log only after readiness and emits the canonical timeline/audit event', async () => {
    const procedure = {
      id: 7,
      tenant_id: TENANT,
      case_id: 42,
      patient_uid: PATIENT,
      encounter_id: ENCOUNTER,
      procedure_type: 'Primary PCI',
      access_site: 'radial',
      status: 'finalized'
    };
    queryUnsafeMock
      .mockResolvedValueOnce([cathCase('ready')])
      .mockResolvedValueOnce(clearedReadinessRows())
      .mockResolvedValueOnce([procedure])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await recordProcedureLog(
      42,
      {
        tenantId: TENANT,
        procedure_type: 'Primary PCI',
        access_site: 'radial'
      },
      { actorUid: ACTOR, actorRole: 'CARDIOLOGIST' }
    );

    expect(result).toMatchObject({ id: 7, procedure_type: 'Primary PCI' });
    expect(assertPrivilegeForGateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        staffUid: ACTOR,
        privilegeName: 'cath_lab_owner_supplied_privilege',
        gate: 'cath_lab_procedure_log',
        enabled: false
      })
    );
    expect(recordCanonicalClinicalEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        patientUid: PATIENT,
        encounterId: ENCOUNTER,
        eventType: 'cath_lab.procedure_logged',
        sourceTable: 'cath_procedure_logs',
        sourceId: 7,
        payload: expect.objectContaining({
          case_id: 42,
          procedure_type: 'Primary PCI',
          privilege_gate: {
            key: 'cath_lab_owner_supplied_privilege',
            enforced: false
          }
        }),
        tags: ['cath_lab', 'nl13_p1']
      }),
      { db: __prismaDefaultMock }
    );
    expect(queryUnsafeMock.mock.calls[2][0]).toContain('INSERT INTO cath_procedure_logs');
  });

  test('rejects device links that do not point at an active same-patient NL-7 association', async () => {
    queryUnsafeMock.mockResolvedValueOnce([cathCase()]).mockResolvedValueOnce([]);

    await expect(
      addDeviceLink(
        42,
        {
          tenantId: TENANT,
          device_patient_association_id: 9
        },
        { actorUid: ACTOR }
      )
    ).rejects.toMatchObject({
      code: 'CATH_LAB_DEVICE_ASSOCIATION_INACTIVE'
    });
    expect(setTenantTxMock).toHaveBeenCalledWith(TENANT, expect.any(Function));
  });

  test('writes contrast/radiation records inside the tenant transaction', async () => {
    queryUnsafeMock.mockResolvedValueOnce([cathCase()]).mockResolvedValueOnce([
      {
        id: 88,
        tenant_id: TENANT,
        case_id: 42,
        patient_uid: PATIENT,
        contrast_volume_ml: 90,
        air_kerma_mgy: null
      }
    ]);

    const record = await addContrastRadiationRecord(
      42,
      {
        tenantId: TENANT,
        contrast_volume_ml: 90,
        aerb_evidence_owner: 'Owner-supplied AERB evidence'
      },
      { actorUid: ACTOR }
    );

    expect(record).toMatchObject({ id: 88, contrast_volume_ml: 90 });
    expect(setTenantTxMock).toHaveBeenCalledWith(TENANT, expect.any(Function));
    expect(queryUnsafeMock.mock.calls[1][0]).toContain(
      'INSERT INTO cath_contrast_radiation_records'
    );
  });
});
