// Unit pins for the recordVitals write-path guards in
// src/services/emr/vitalsChartService.js:
//
//   * C-M4 — hard plausibility bounds reject impossible core-vital values and
//     out-of-window recorded_at BEFORE any transaction opens; device/fhir
//     ingest is exempt from the backdate bound.
//   * C-M2 — the resolved tenant is passed into checkVitalAnomalies so
//     warning-only alert batches persist under the patient's tenant.
//   * C-M7 — the NEWS2 SpO2 scale is resolved per patient via
//     news2Service.resolveSpo2ScaleForPatient and passed to persistNews2
//     (contract: the scorer-unification change exports that helper; it is
//     mocked here so this test does not depend on its internals).
//   * correctVitals re-validates the core vitals against the same bounds.

import { jest } from '@jest/globals';

const usersFindUniqueMock = jest.fn();
const queryRawMock = jest.fn();
const setTenantTxMock = jest.fn();
const checkVitalAnomaliesMock = jest.fn();
const recordCanonicalMock = jest.fn();
const resolveSpo2ScaleMock = jest.fn();
const persistNews2Mock = jest.fn();
const escalateNews2Mock = jest.fn();

const PATIENT_UID = 'a1111111-2222-4333-8444-555555550003';
const PATIENT_TENANT = '55555555-5555-4555-8555-555555555555';
const NURSE_UID = 'b2222222-3333-4444-8555-666666660004';
const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';

const vitalsCreateMock = jest.fn(async ({ data }) => ({
  id: 321,
  patient_uid: data.patient_uid,
  encounter_id: data.encounter_id ?? null,
  encounter_uid: data.encounter_uid ?? null,
  source: data.source,
  source_device: data.source_device ?? null,
  recorded_by: data.recorded_by,
  recorded_at: data.recorded_at ?? new Date(),
  weight_kg: null,
  height_cm: null,
}));

const __txClient = {
  vitals_chart: { create: vitalsCreateMock },
  $executeRawUnsafe: jest.fn().mockResolvedValue(1),
  $queryRawUnsafe: jest.fn().mockResolvedValue([]),
};

const __prismaDefaultMock = {
  users: { findUnique: usersFindUniqueMock },
  $queryRawUnsafe: queryRawMock,
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: setTenantTxMock,
  setTenant: async (_t, fn) => fn(__prismaDefaultMock),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../../utils/clinical/vitalSignMonitor.js', () => ({
  checkVitalAnomalies: checkVitalAnomaliesMock,
}));
jest.unstable_mockModule('../../services/clinical/growthPercentileService.js', () => ({
  computeGrowthSnapshot: jest.fn().mockResolvedValue(null),
}));
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: recordCanonicalMock,
}));
jest.unstable_mockModule('../../services/clinical/news2Service.js', () => ({
  resolveSpo2ScaleForPatient: resolveSpo2ScaleMock,
  persistNews2: persistNews2Mock,
  escalateNews2: escalateNews2Mock,
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  DEFAULT_TENANT_ID,
  requireTenantId: (tenantId) => tenantId || DEFAULT_TENANT_ID,
}));

const { recordVitals, correctVitals } = await import('../../services/emr/vitalsChartService.js');

function resetAll() {
  usersFindUniqueMock.mockReset();
  queryRawMock.mockReset();
  setTenantTxMock.mockReset();
  checkVitalAnomaliesMock.mockReset();
  recordCanonicalMock.mockReset();
  resolveSpo2ScaleMock.mockReset();
  persistNews2Mock.mockReset();
  escalateNews2Mock.mockReset();
  vitalsCreateMock.mockClear();

  usersFindUniqueMock.mockImplementation(async ({ where }) => {
    if (where?.uid === PATIENT_UID) {
      return { id: 777, uid: PATIENT_UID, role: 'PATIENT', tenant_id: PATIENT_TENANT };
    }
    if (where?.uid === NURSE_UID) return { id: 55 };
    return null;
  });
  queryRawMock.mockResolvedValue([]);
  setTenantTxMock.mockImplementation(async (_tenantId, fn) => fn(__txClient));
  checkVitalAnomaliesMock.mockResolvedValue([]);
  recordCanonicalMock.mockResolvedValue({ timeline: { id: 1 }, audit: { id: 2 } });
  resolveSpo2ScaleMock.mockResolvedValue(2);
  persistNews2Mock.mockResolvedValue({
    record: { id: 9, total_score: 0 },
    computed: { totalScore: 0, scores: {} },
  });
  escalateNews2Mock.mockResolvedValue(undefined);
}

const baseWrite = { patient_uid: PATIENT_UID, recorded_by: NURSE_UID };

describe('recordVitals — NEWS2 SpO2 scale wiring (C-M7)', () => {
  it('resolves the patient scale on the tx client and passes it to persistNews2', async () => {
    resetAll();

    await recordVitals({ ...baseWrite, spo2: 96, respiratory_rate: 16 });

    expect(resolveSpo2ScaleMock).toHaveBeenCalledTimes(1);
    expect(resolveSpo2ScaleMock).toHaveBeenCalledWith(PATIENT_UID, { db: __txClient });
    expect(persistNews2Mock).toHaveBeenCalledTimes(1);
    const [uid, vitals, , options] = persistNews2Mock.mock.calls[0];
    expect(uid).toBe(PATIENT_UID);
    expect(vitals.spo2).toBe(96);
    // The resolved patient-level scale travels via options.spo2Scale — the
    // channel that wins over any per-reading vitals.spo2_scale. The created
    // vitals row's id rides along so a later correction can find and
    // supersede this score (migration 652 linkage).
    expect(options).toEqual({ db: __txClient, spo2Scale: 2, vitalsChartId: 321 });
  });

  it('rolls back instead of persisting vitals with an unresolved scoring scale', async () => {
    resetAll();
    resolveSpo2ScaleMock.mockRejectedValueOnce(new Error('scale lookup unavailable'));

    await expect(recordVitals({ ...baseWrite, spo2: 97, supplemental_o2: true }))
      .rejects.toThrow('scale lookup unavailable');

    expect(vitalsCreateMock).toHaveBeenCalledTimes(1);
    expect(persistNews2Mock).not.toHaveBeenCalled();
    expect(checkVitalAnomaliesMock).not.toHaveBeenCalled();
  });
});

describe('recordVitals — tenant passed to the anomaly monitor (C-M2)', () => {
  it('checkVitalAnomalies receives the resolved patient tenant in context', async () => {
    resetAll();

    await recordVitals({ ...baseWrite, heart_rate: 155 });

    expect(checkVitalAnomaliesMock).toHaveBeenCalledTimes(1);
    const [patientId, vitalsForCheck, context] = checkVitalAnomaliesMock.mock.calls[0];
    expect(patientId).toBe(777);
    expect(vitalsForCheck).toEqual({ heart_rate: 155 });
    expect(context.tenantId).toBe(PATIENT_TENANT);
    expect(context.source).toBe('staff');
  });
});

describe('recordVitals — plausibility bounds (C-M4)', () => {
  it('rejects SpO2 101 with a 400 BEFORE any transaction opens', async () => {
    resetAll();
    await expect(recordVitals({ ...baseWrite, spo2: 101 }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/spo2 must be between 0 and 100/) });
    expect(setTenantTxMock).not.toHaveBeenCalled();
  });

  it('rejects HR 301, accepts the HR 300 boundary', async () => {
    resetAll();
    await expect(recordVitals({ ...baseWrite, heart_rate: 301 }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(setTenantTxMock).not.toHaveBeenCalled();

    resetAll();
    await expect(recordVitals({ ...baseWrite, heart_rate: 300 })).resolves.toBeTruthy();
    expect(setTenantTxMock).toHaveBeenCalledTimes(1);
  });

  it('validates temperature AFTER Fahrenheit→Celsius normalization (99°F is accepted)', async () => {
    resetAll();
    const result = await recordVitals({ ...baseWrite, temperature: 99, temperature_unit: 'F' });
    expect(result.vitals).toBeTruthy();
    // 99°F ≈ 37.2°C — stored and validated in Celsius.
    const created = vitalsCreateMock.mock.calls[0][0].data;
    expect(created.temperature).toBeCloseTo(37.2, 1);
  });

  it('rejects a recorded_at more than 5 minutes in the future', async () => {
    resetAll();
    await expect(recordVitals({
      ...baseWrite,
      heart_rate: 80,
      recorded_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    })).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/future/) });
    expect(setTenantTxMock).not.toHaveBeenCalled();
  });

  it('rejects a staff entry backdated beyond 72h; accepts 3h back-entry', async () => {
    resetAll();
    await expect(recordVitals({
      ...baseWrite,
      heart_rate: 80,
      recorded_at: new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString(),
    })).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/backdated/) });

    resetAll();
    await expect(recordVitals({
      ...baseWrite,
      heart_rate: 80,
      recorded_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    })).resolves.toBeTruthy();
  });

  it('device ingest is EXEMPT from the backdate bound (held-spool replays)', async () => {
    resetAll();
    await expect(recordVitals({
      ...baseWrite,
      heart_rate: 80,
      source: 'device',
      source_device: 'icu-monitor-3',
      recorded_at: new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString(),
    })).resolves.toBeTruthy();
    expect(setTenantTxMock).toHaveBeenCalledTimes(1);
  });
});

describe('correctVitals — plausibility bounds on corrections (C-M4)', () => {
  it('rejects an implausible corrected value before opening the correction tx', async () => {
    resetAll();
    await expect(correctVitals(5, { corrected_by: NURSE_UID, spo2: 150 }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/spo2/) });
    expect(setTenantTxMock).not.toHaveBeenCalled();
  });

  it('validates corrected temperature after Celsius conversion', async () => {
    resetAll();
    // 200°F ≈ 93°C → implausible, rejected.
    await expect(correctVitals(5, { corrected_by: NURSE_UID, temperature: 200, temperature_unit: 'F' }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/temperature/) });
  });
});
