// Re-review 2026-08-10 CLIN-3 / CLIN-4 / H1 pins for icuService lifecycle
// writes:
//   * discharge has a state guard (409 on non-active) — no silent
//     double-discharge;
//   * DNR/code-status flips append to icu_code_status_history and emit the
//     canonical timeline+audit pair in the same tx (tx-revision keys);
//   * admission creation emits the canonical pair in the minting tx;
//   * flowsheet/assessment writes reject implausible values before any
//     INSERT.

import { jest } from '@jest/globals';
import { AppError } from '../../utils/AppError.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const PATIENT = '22222222-2222-4222-8222-222222222222';
const ACTOR = '33333333-3333-4333-8333-333333333333';

const queryRawMock = jest.fn();
const txQueryRawMock = jest.fn();
const tx = { $queryRawUnsafe: txQueryRawMock };
const setTenantTxMock = jest.fn(async (_tenantId, fn) => fn(tx));
const closeAssociationsMock = jest.fn(async () => []);
const recordCanonicalMock = jest.fn(async () => ({ timeline: { id: 1 }, audit: { id: 2 } }));
const revisionMock = jest.fn(async () => '4242');

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawMock },
  setTenantTx: setTenantTxMock,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule('../../services/clinical/marService.js', () => ({
  scheduleMedications: jest.fn(async () => []),
}));
jest.unstable_mockModule('../../services/clinical/icuChartingService.js', () => ({
  closeIcuDeviceAssociationsForAdmission: closeAssociationsMock,
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: (tenantId) => tenantId || TENANT,
}));
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: recordCanonicalMock,
  currentCanonicalTransactionRevision: revisionMock,
}));

const icu = await import('../../services/clinical/icuService.js');

beforeEach(() => {
  queryRawMock.mockReset();
  txQueryRawMock.mockReset();
  setTenantTxMock.mockClear();
  closeAssociationsMock.mockClear();
  recordCanonicalMock.mockClear();
  revisionMock.mockClear();
});

describe('dischargeAdmission — state guard (CLIN-4)', () => {
  it('rejects an unknown disposition before any DB work', async () => {
    await expect(icu.dischargeAdmission({
      tenantId: TENANT, id: 5, disposition: 'vanished',
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(setTenantTxMock).not.toHaveBeenCalled();
  });

  it('409s when the admission is not active and writes nothing', async () => {
    txQueryRawMock.mockResolvedValueOnce([{ id: 5, status: 'discharged', patient_uid: PATIENT }]);
    await expect(icu.dischargeAdmission({
      tenantId: TENANT, id: 5, disposition: 'ward', actorUid: ACTOR,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'ICU_ADMISSION_NOT_ACTIVE',
      details: { status: 'discharged' },
    });
    expect(txQueryRawMock).toHaveBeenCalledTimes(1); // only the FOR UPDATE probe
    expect(recordCanonicalMock).not.toHaveBeenCalled();
    expect(closeAssociationsMock).not.toHaveBeenCalled();
  });

  it('discharges an active admission and emits the canonical pair in-tx', async () => {
    txQueryRawMock
      .mockResolvedValueOnce([{ id: 5, status: 'active', patient_uid: PATIENT }])
      .mockResolvedValueOnce([{
        id: 5, status: 'discharged', patient_uid: PATIENT, unit_code: 'MICU',
        discharged_at: new Date('2026-08-10T10:00:00Z'),
      }]);
    const row = await icu.dischargeAdmission({
      tenantId: TENANT, id: 5, disposition: 'ward', actorUid: ACTOR, actorRole: 'DOCTOR',
    });
    expect(row.status).toBe('discharged');
    expect(closeAssociationsMock).toHaveBeenCalledTimes(1);
    expect(recordCanonicalMock).toHaveBeenCalledTimes(1);
    const [input, options] = recordCanonicalMock.mock.calls[0];
    expect(options).toEqual({ db: tx });
    expect(input).toMatchObject({
      eventType: 'icu.discharged',
      patientUid: PATIENT,
      sourceTable: 'icu_admissions',
      timelineIdempotencyKey: 'icu_admissions:5:icu.discharged',
      auditIdempotencyKey: 'icu_admissions:5:audit:icu.discharged',
    });
  });

  it('records an ICU death as its own canonical event type', async () => {
    txQueryRawMock
      .mockResolvedValueOnce([{ id: 7, status: 'active', patient_uid: PATIENT }])
      .mockResolvedValueOnce([{
        id: 7, status: 'expired', patient_uid: PATIENT, unit_code: 'MICU',
        discharged_at: new Date(),
      }]);
    await icu.dischargeAdmission({
      tenantId: TENANT, id: 7, disposition: 'expired', actorUid: ACTOR,
    });
    expect(recordCanonicalMock.mock.calls[0][0]).toMatchObject({
      eventType: 'icu.death_recorded',
      eventStatus: 'expired',
    });
  });
});

describe('updateAdmissionCodeStatus — append-only history + canonical pair (CLIN-3)', () => {
  it('no-ops on an unchanged code status: no history row, no canonical emit', async () => {
    txQueryRawMock
      .mockResolvedValueOnce([{ id: 5, patient_uid: PATIENT, code_status: 'dnr' }]) // FOR UPDATE
      .mockResolvedValueOnce([{ id: 5, patient_uid: PATIENT, code_status: 'dnr' }]); // read-back
    const row = await icu.updateAdmissionCodeStatus({
      tenantId: TENANT, id: 5, code_status: 'dnr', set_by: ACTOR,
    });
    expect(row.code_status).toBe('dnr');
    expect(recordCanonicalMock).not.toHaveBeenCalled();
    const sqls = txQueryRawMock.mock.calls.map((c) => c[0]);
    expect(sqls.some((s) => s.includes('icu_code_status_history'))).toBe(false);
    expect(sqls.some((s) => s.includes('UPDATE icu_admissions'))).toBe(false);
  });

  it('a flip appends history and emits with a tx-revision key', async () => {
    txQueryRawMock.mockImplementation(async (sql) => {
      if (sql.includes('FOR UPDATE')) {
        return [{ id: 5, patient_uid: PATIENT, code_status: 'full_code' }];
      }
      if (sql.includes('UPDATE icu_admissions')) {
        return [{ id: 5, patient_uid: PATIENT, code_status: 'dnr' }];
      }
      return []; // history INSERT
    });
    const row = await icu.updateAdmissionCodeStatus({
      tenantId: TENANT, id: 5, code_status: 'dnr', set_by: ACTOR, actorRole: 'DOCTOR',
    });
    expect(row.code_status).toBe('dnr');

    const historyCall = txQueryRawMock.mock.calls.find(
      (c) => c[0].includes('INSERT INTO icu_code_status_history'),
    );
    expect(historyCall).toBeDefined();
    // (tenant, admissionId, patient_uid, previous, new, changed_by)
    expect(historyCall.slice(1)).toEqual([TENANT, 5, PATIENT, 'full_code', 'dnr', ACTOR]);

    expect(revisionMock).toHaveBeenCalledTimes(1);
    expect(recordCanonicalMock).toHaveBeenCalledTimes(1);
    expect(recordCanonicalMock.mock.calls[0][0]).toMatchObject({
      eventType: 'icu.code_status_changed',
      eventStatus: 'dnr',
      beforeState: { code_status: 'full_code' },
      afterState: { code_status: 'dnr' },
      timelineIdempotencyKey: 'icu_admissions:5:code_status:dnr:tx:4242',
      auditIdempotencyKey: 'icu_admissions:5:audit:code_status:dnr:tx:4242',
    });
    expect(recordCanonicalMock.mock.calls[0][1]).toEqual({ db: tx });
  });

  it('still rejects an off-vocabulary code status', async () => {
    await expect(icu.updateAdmissionCodeStatus({
      tenantId: TENANT, id: 5, code_status: 'no_code',
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(setTenantTxMock).not.toHaveBeenCalled();
  });
});

describe('createAdmission — canonical pair in the minting tx', () => {
  it('emits icu.admission_created with the insert-once fixed key', async () => {
    txQueryRawMock.mockResolvedValueOnce([{
      id: 9, patient_uid: PATIENT, status: 'active', unit_code: 'MICU',
      bed_no: 'B2', code_status: 'full_code', reason_for_icu: null, er_visit_id: null,
    }]);
    const row = await icu.createAdmission({
      tenantId: TENANT, actorUid: ACTOR, actorRole: 'DOCTOR',
      patient_uid: PATIENT, unit_code: 'MICU', bed_no: 'B2',
    });
    expect(row.id).toBe(9);
    expect(recordCanonicalMock).toHaveBeenCalledTimes(1);
    expect(recordCanonicalMock.mock.calls[0][0]).toMatchObject({
      eventType: 'icu.admission_created',
      patientUid: PATIENT,
      actorUid: ACTOR,
      timelineIdempotencyKey: 'icu_admissions:9:icu.admission_created',
      auditIdempotencyKey: 'icu_admissions:9:audit:icu.admission_created',
    });
    expect(recordCanonicalMock.mock.calls[0][1]).toEqual({ db: tx });
  });
});

describe('flowsheet + assessment writes — plausibility gate (H1)', () => {
  it('rejects spo2 990 before any flowsheet INSERT', async () => {
    queryRawMock.mockResolvedValueOnce([{ id: 5 }]); // admission-in-tenant probe
    await expect(icu.logFlowsheet({
      tenantId: TENANT, icu_admission_id: 5, spo2: 990,
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(queryRawMock).toHaveBeenCalledTimes(1); // probe only, no INSERT
  });

  it('rejects an out-of-scale SOFA sub-score before any assessment INSERT', async () => {
    queryRawMock.mockResolvedValueOnce([{ id: 5 }]);
    await expect(icu.recordAssessment({
      tenantId: TENANT, icu_admission_id: 5, assessment_kind: 'sofa', sofa_resp: 40,
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(queryRawMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a far-future recorded_at on the flowsheet', async () => {
    queryRawMock.mockResolvedValueOnce([{ id: 5 }]);
    await expect(icu.logFlowsheet({
      tenantId: TENANT, icu_admission_id: 5, hr: 80,
      recorded_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('accepts a plausible flowsheet entry', async () => {
    queryRawMock
      .mockResolvedValueOnce([{ id: 5 }]) // probe
      .mockResolvedValueOnce([{ id: 101, icu_admission_id: 5 }]); // INSERT
    const row = await icu.logFlowsheet({
      tenantId: TENANT, icu_admission_id: 5,
      hr: 82, spo2: 97, temp_c: 37.2, noradrenaline_mcg_kg_min: 0.12, urine_output_ml: 0,
    });
    expect(row.id).toBe(101);
    expect(queryRawMock).toHaveBeenCalledTimes(2);
  });
});

// The AppError import above keeps the suite honest if factories change shape.
void AppError;
