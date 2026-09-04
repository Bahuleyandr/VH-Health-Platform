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
const cancelWorkflowSlaMock = jest.fn(async () => []);
const assertPrivilegeForGateMock = jest.fn(async () => ({ allowed: true }));
const isGateEnabledMock = jest.fn(key => process.env[key] === 'true');
const privilegeKeyMock = jest.fn(value => String(value).trim().toLowerCase());

const __prismaDefaultMock = { $queryRawUnsafe: queryUnsafeMock };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: setTenantTxMock,
  isTenantTransactionClient: value => value === __prismaDefaultMock
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: tenantId => tenantId || '00000000-0000-4000-8000-000000000001'
}));

jest.unstable_mockModule('../../services/billing/billingV2Service.js', () => ({
  addInvoiceItem: jest.fn(),
  createDraftInvoice: jest.fn()
}));

jest.unstable_mockModule('../../services/pharmacy/inventoryV2Service.js', () => ({
  recordMovementTx: jest.fn()
}));

jest.unstable_mockModule('../../services/pharmacySupply/pharmacySupplyService.js', () => ({
  reserveStock: jest.fn()
}));

jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  cancelWorkflowSla: cancelWorkflowSlaMock,
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

// NL-13 P1e: keep this suite's graph tight — completion emission is
// best-effort and covered by cathQuickWinsService.test.js.
const emitCathFollowUpsMock = jest.fn(async () => ({ created: [], skipped: [] }));
jest.unstable_mockModule('../../services/clinical/cathQuickWinsService.js', () => ({
  emitCathProcedureCompletionFollowUps: emitCathFollowUpsMock
}));

// Device reuse widened cathLabService's import graph again: the reuse service
// pulls cdsEngine and the outbox, and bloodborneMarkerService pulls setTenant —
// neither of which this suite's prisma/canonical mocks provide. Both are
// covered end to end by cath-device-reuse.deep.test.js, so stub the boundary
// rather than loading their graphs here.
jest.unstable_mockModule('../../services/clinical/cathDeviceReuseService.js', () => ({
  applyDeviceTransitionTx: jest.fn(),
  captureReusedDeviceTx: jest.fn(),
  getReprocessingSettings: jest.fn(async () => ({
    reactive_patient_rule: 'discard', unknown_serology_rule: 'warn', serology_validity_days: 90
  })),
  markDeviceInCaseTx: jest.fn()
}));
jest.unstable_mockModule('../../services/clinical/bloodborneMarkerService.js', () => ({
  resolveReuseStatus: jest.fn(async () => ({
    status: 'unknown', reasons: ['HIV not on record'], markers: [], validity_days: 90
  }))
}));

const {
  READINESS_TYPES,
  addContrastRadiationRecord,
  addDeviceLink,
  cathLabPrivilegeGateConfig,
  evaluateReadinessGate,
  recordProcedureLog,
  transitionCaseStatus,
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
  cancelWorkflowSlaMock.mockClear();
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

describe('transitionCaseStatus SLA lifecycle (SLA-halves G1)', () => {
  function mockTransition(fromStatus, target, slaRuleCode) {
    // caseById SELECT, then the status UPDATE ... RETURNING, then
    // updateCaseCanonicalRefs UPDATE (and any billing readback) return [].
    queryUnsafeMock.mockImplementation(async (sql) => {
      if (sql.includes('FROM cath_lab_cases') && sql.includes('SELECT')) {
        return [{ ...cathCase(fromStatus), sla_rule_code: slaRuleCode }];
      }
      if (sql.includes('UPDATE cath_lab_cases') && sql.includes('RETURNING *')) {
        return [{ ...cathCase(target), status: target, sla_rule_code: slaRuleCode }];
      }
      return [];
    });
  }

  test('cancelling a case cancels (never completes) its SLA clock', async () => {
    mockTransition('scheduled', 'cancelled', 'cath_lab_turnaround');

    const result = await transitionCaseStatus(
      42,
      { tenantId: TENANT, status: 'cancelled', reason: 'patient unfit' },
      { actorUid: ACTOR, actorRole: 'DOCTOR' }
    );

    expect(result.status).toBe('cancelled');
    expect(cancelWorkflowSlaMock).toHaveBeenCalledTimes(1);
    expect(cancelWorkflowSlaMock).toHaveBeenCalledWith(
      {
        tenantId: TENANT,
        ruleCode: 'cath_lab_turnaround',
        sourceTable: 'cath_lab_cases',
        sourceId: '42',
        metadata: { cancel_reason: 'patient unfit', cancelled_by: ACTOR }
      },
      { db: __prismaDefaultMock }
    );
    expect(completeWorkflowSlaMock).not.toHaveBeenCalled();
  });

  test('completing a case still completes its SLA clock and never cancels it', async () => {
    mockTransition('in_progress', 'completed', 'cath_lab_turnaround');

    const result = await transitionCaseStatus(
      42,
      { tenantId: TENANT, status: 'completed' },
      { actorUid: ACTOR, actorRole: 'DOCTOR' }
    );

    expect(result.status).toBe('completed');
    expect(completeWorkflowSlaMock).toHaveBeenCalledTimes(1);
    expect(cancelWorkflowSlaMock).not.toHaveBeenCalled();
  });

  test('cancelling a case without an SLA rule code touches no SLA', async () => {
    mockTransition('scheduled', 'cancelled', null);

    await transitionCaseStatus(
      42,
      { tenantId: TENANT, status: 'cancelled' },
      { actorUid: ACTOR, actorRole: 'DOCTOR' }
    );

    expect(cancelWorkflowSlaMock).not.toHaveBeenCalled();
    expect(completeWorkflowSlaMock).not.toHaveBeenCalled();
  });
});
