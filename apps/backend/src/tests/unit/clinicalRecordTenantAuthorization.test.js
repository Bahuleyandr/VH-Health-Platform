import { jest } from '@jest/globals';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const PROBLEM = '33333333-3333-4333-8333-333333333333';
const MEDREC = '44444444-4444-4444-8444-444444444444';

const queryRawUnsafeMock = jest.fn();
const transactionMock = jest.fn(async (callback) => callback({
  $queryRawUnsafe: queryRawUnsafeMock,
}));

const diagnosesMock = {
  findUnique: jest.fn(),
  findFirst: jest.fn(),
  updateMany: jest.fn(),
  update: jest.fn(),
  findMany: jest.fn(),
  create: jest.fn(),
};

const prismaMock = {
  $queryRawUnsafe: queryRawUnsafeMock,
  $transaction: transactionMock,
  diagnoses: diagnosesMock,
  users: { findFirst: jest.fn() },
  icd10_codes: { findFirst: jest.fn(), findMany: jest.fn() },
};

const recordCanonicalClinicalEventMock = jest.fn();
const recordClinicalAuditEventMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  setTenantTx: async (_tenantId, fn) => fn({ $queryRawUnsafe: queryRawUnsafeMock }),
  setTenant: async (_tenantId, fn) => fn({ $queryRawUnsafe: queryRawUnsafeMock }),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn({ $queryRawUnsafe: queryRawUnsafeMock }),
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

jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: recordCanonicalClinicalEventMock,
  recordClinicalAuditEvent: recordClinicalAuditEventMock,
  recordMedicationSafetyReviews: jest.fn(async () => []),
}));

jest.unstable_mockModule('../../services/doctor/doctorRefService.js', () => ({
  resolveDoctorRef: jest.fn(),
}));

jest.unstable_mockModule('../../services/terminology/terminologyService.js', () => ({
  validateCode: jest.fn(async () => ({ valid: true, mode: 'test' })),
}));

jest.unstable_mockModule('../../services/terminology/clinicalCodeBindingService.js', () => ({
  attachResourceCodings: jest.fn(async (rows) => rows),
  legacyIcd10Coding: jest.fn(() => null),
  listResourceCodings: jest.fn(async () => []),
  mergeClinicalCodings: jest.fn((...codings) => codings.filter(Boolean)),
  replaceResourceCodings: jest.fn(async () => []),
}));

const {
  listProblems,
  updateProblem,
} = await import('../../services/clinical/problemListService.js');
const {
  decideItem,
  listReconciliations,
} = await import('../../services/clinical/medicationReconciliationService.js');
const {
  updateDiagnosisStatus,
} = await import('../../services/emr/diagnosisService.js');
const {
  linkStudy,
  listPatientStudies,
} = await import('../../services/radiology/pacsService.js');

beforeEach(() => {
  jest.clearAllMocks();
  queryRawUnsafeMock.mockReset();
  transactionMock.mockClear();
  for (const fn of Object.values(diagnosesMock)) fn.mockReset();
});

describe('clinical record tenant authorization invariants', () => {
  it('tenant-scopes problem-list patient reads', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    await listProblems(PATIENT, { tenantId: TENANT, status: 'active' });

    const [sql, ...params] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toContain('p.tenant_id = $2::uuid');
    expect(sql).toContain('p.status = $3');
    expect(params).toEqual([PATIENT, TENANT, 'active']);
  });

  it('tenant-scopes problem updates by resource id', async () => {
    const existing = {
      id: PROBLEM,
      tenant_id: TENANT,
      patient_uid: PATIENT,
      title: 'Diabetes',
      status: 'active',
      icd10_code: 'E11',
      updated_at: new Date('2026-06-11T10:00:00.000Z'),
    };
    queryRawUnsafeMock
      .mockResolvedValueOnce([existing])
      .mockResolvedValueOnce([{ ...existing, status: 'resolved' }]);

    await updateProblem(PROBLEM, { status: 'resolved' }, {
      tenantId: TENANT,
      actorUid: ACTOR,
      actorRole: 'DOCTOR',
    });

    expect(queryRawUnsafeMock.mock.calls[0][0]).toContain('tenant_id = $2::uuid');
    expect(queryRawUnsafeMock.mock.calls[0][2]).toBe(TENANT);
    expect(queryRawUnsafeMock.mock.calls[1][0]).toContain('WHERE id = $1::uuid AND tenant_id = $16::uuid');
    expect(queryRawUnsafeMock.mock.calls[1][16]).toBe(TENANT);
  });

  it('tenant-scopes medication reconciliation reads and item decisions', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);
    await listReconciliations(PATIENT, { tenantId: TENANT, recType: 'admission' });
    expect(queryRawUnsafeMock.mock.calls[0][0]).toContain('tenant_id = $2::uuid');
    expect(queryRawUnsafeMock.mock.calls[0].slice(1)).toEqual([PATIENT, TENANT, 'admission']);

    queryRawUnsafeMock.mockReset();
    queryRawUnsafeMock
      // 1) reconciliation header fetch (getReconciliation)
      .mockResolvedValueOnce([{
        id: MEDREC,
        tenant_id: TENANT,
        patient_uid: PATIENT,
        patient_id: 1,
        encounter_id: null,
        rec_type: 'admission',
        status: 'in_progress',
      }])
      // 2) existing-item fetch (used for change-detail + safety-review medication name)
      .mockResolvedValueOnce([{
        id: 9, medication_name: 'Metformin', dose: '500mg', frequency: 'BD', route: 'PO', source: 'home',
      }])
      // 3) item UPDATE ... RETURNING (now inside the atomic prisma.$transaction)
      .mockResolvedValueOnce([{
        id: 9, medication_name: 'Metformin', decision: 'continue', safety_review_id: null, decided_by: ACTOR,
      }]);

    await decideItem(MEDREC, 9, { decision: 'continue' }, {
      tenantId: TENANT,
      actorUid: ACTOR,
      actorRole: 'PHARMACY_STAFF',
    });

    // All three queries must be tenant-scoped: header read, item read, and the
    // atomic item UPDATE (tenant_id moved to $11 with the structured-change columns).
    expect(queryRawUnsafeMock.mock.calls[0][0]).toContain('tenant_id = $2::uuid');
    expect(queryRawUnsafeMock.mock.calls[0][2]).toBe(TENANT);
    expect(queryRawUnsafeMock.mock.calls[1][0]).toContain('tenant_id = $3::uuid');
    expect(queryRawUnsafeMock.mock.calls[1][3]).toBe(TENANT);
    expect(queryRawUnsafeMock.mock.calls[2][0]).toContain('AND tenant_id = $11::uuid');
    expect(queryRawUnsafeMock.mock.calls[2][11]).toBe(TENANT);
  });

  it('tenant-scopes diagnosis status updates', async () => {
    diagnosesMock.findUnique.mockResolvedValueOnce({
      id: 7,
      status: 'active',
      patient_uid: PATIENT,
    });
    diagnosesMock.findFirst
      .mockResolvedValueOnce({ id: 7 })
      .mockResolvedValueOnce({
        id: 7,
        tenant_id: TENANT,
        patient_uid: PATIENT,
        encounter_id: null,
        description: 'Hypertension',
        diagnosis_type: 'secondary',
        status: 'resolved',
        updated_at: new Date('2026-06-11T10:00:00.000Z'),
      });
    diagnosesMock.updateMany.mockResolvedValueOnce({ count: 1 });

    await updateDiagnosisStatus(7, 'resolved', null, ACTOR, { tenantId: TENANT });

    expect(diagnosesMock.findFirst.mock.calls[0][0]).toMatchObject({
      where: { id: 7, tenant_id: TENANT },
    });
    expect(diagnosesMock.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 7, tenant_id: TENANT },
    }));
  });

  it('tenant-scopes PACS patient study reads and order linking', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);
    await listPatientStudies(PATIENT, { tenantId: TENANT });
    expect(queryRawUnsafeMock.mock.calls[0][0]).toContain('tenant_id = $2::uuid');
    expect(queryRawUnsafeMock.mock.calls[0].slice(1)).toEqual([PATIENT, TENANT]);

    queryRawUnsafeMock.mockReset();
    queryRawUnsafeMock
      .mockResolvedValueOnce([{
        id: 12,
        tenant_id: TENANT,
        patient_uid: PATIENT,
        modality: 'CT',
        body_part: 'Chest',
        status: 'ordered',
        pacs_study_instance_uid: null,
      }])
      .mockResolvedValueOnce([{
        id: 12,
        tenant_id: TENANT,
        patient_uid: PATIENT,
        modality: 'CT',
        body_part: 'Chest',
        status: 'ordered',
        pacs_study_instance_uid: '1.2.3',
      }]);

    await linkStudy(12, { studyInstanceUid: '1.2.3' }, {
      tenantId: TENANT,
      actorUid: ACTOR,
      actorRole: 'RADIOLOGY_TECHNICIAN',
    });

    expect(queryRawUnsafeMock.mock.calls[0][0]).toContain('ro.tenant_id = $2::uuid');
    expect(queryRawUnsafeMock.mock.calls[0][2]).toBe(TENANT);
    expect(queryRawUnsafeMock.mock.calls[1][0]).toContain('WHERE id = $1 AND tenant_id = $4::uuid');
    expect(queryRawUnsafeMock.mock.calls[1][4]).toBe(TENANT);
  });
});
