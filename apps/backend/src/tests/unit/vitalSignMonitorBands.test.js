// C-H1 regression pins for the vital-sign classification bands in
// src/utils/clinical/vitalSignMonitor.js.
//
// Headline: SpO2 = 100 is a NORMAL physiological value and must never
// classify as CRITICAL (it used to: critical_max was a finite 100 and both
// classifiers compare `>= critical_max` inclusively, so a perfectly
// oxygenated patient fired the code-blue fan-out). SpO2 now has no upper
// critical band — high-side alerts are unreachable, low-side unchanged.
//
// The rest of the matrix FREEZES today's inclusive-comparator semantics for
// every other monitored vital: value == critical_min/max → CRITICAL,
// value == min/max → normal, just outside min/max → WARNING. The SpO2 fix
// must not shift any of those boundaries.

import { jest } from '@jest/globals';

const queryRawMock = jest.fn();
const executeRawMock = jest.fn();
const setTenantTxMock = jest.fn();
const enqueueCriticalResultTaskMock = jest.fn();
const emitVitalAnomalyMock = jest.fn();
const emitCodeBlueMock = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryRawMock,
  $executeRawUnsafe: executeRawMock,
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: setTenantTxMock,
  setTenant: async (_t, fn) => fn(__prismaDefaultMock),
}));
jest.unstable_mockModule('../../utils/sentry.js', () => ({
  default: { captureException: jest.fn() },
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../../utils/websocket/realtimeEmitter.js', () => ({
  emitVitalAnomaly: emitVitalAnomalyMock,
  emitCodeBlue: emitCodeBlueMock,
}));
jest.unstable_mockModule('../../utils/notifications/notificationDispatcher.js', () => ({
  dispatch: jest.fn().mockResolvedValue(undefined),
}));
jest.unstable_mockModule('../../services/results/resultsInboxService.js', () => ({
  enqueueCriticalResultTask: enqueueCriticalResultTaskMock,
}));
const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  DEFAULT_TENANT_ID,
  requireTenantId: (tenantId) => tenantId || DEFAULT_TENANT_ID,
}));

const { classifyVitalAnomalyCandidates, checkVitalAnomalies } = await import(
  '../../utils/clinical/vitalSignMonitor.js'
);

const PATIENT_ID = 4242;

// One classification run = one resolvePatientContext query on plain prisma.
async function classify(vitals, { ageYears = 50, isPregnant = false } = {}) {
  queryRawMock.mockReset();
  queryRawMock
    .mockResolvedValueOnce([{ age_years: ageYears, is_pregnant: isPregnant }])
    .mockResolvedValue([]);
  return classifyVitalAnomalyCandidates(PATIENT_ID, vitals);
}

async function severityOf(vitalName, value, ctx) {
  const candidates = await classify({ [vitalName]: value }, ctx);
  if (candidates.length === 0) return null;
  expect(candidates).toHaveLength(1);
  expect(candidates[0].vital_name).toBe(vitalName);
  return candidates[0].severity;
}

describe('C-H1 — SpO2 = 100 is normal, never CRITICAL', () => {
  it('adult SpO2 100 produces NO candidate at all', async () => {
    expect(await severityOf('oxygen_saturation', 100)).toBeNull();
  });

  it('adult SpO2 99 and 96 are normal', async () => {
    expect(await severityOf('oxygen_saturation', 99)).toBeNull();
    expect(await severityOf('oxygen_saturation', 96)).toBeNull();
  });

  it('adult SpO2 low-side edges unchanged: 92 normal, 91 WARNING, 86 WARNING, 85 CRITICAL, 80 CRITICAL', async () => {
    expect(await severityOf('oxygen_saturation', 92)).toBeNull();
    expect(await severityOf('oxygen_saturation', 91)).toBe('WARNING');
    expect(await severityOf('oxygen_saturation', 86)).toBe('WARNING');
    expect(await severityOf('oxygen_saturation', 85)).toBe('CRITICAL');
    expect(await severityOf('oxygen_saturation', 80)).toBe('CRITICAL');
  });

  it('paediatric SpO2 100 produces no candidate; low side unchanged (94 normal, 93 WARNING, 88 CRITICAL)', async () => {
    const paed = { ageYears: 8 };
    expect(await severityOf('oxygen_saturation', 100, paed)).toBeNull();
    expect(await severityOf('oxygen_saturation', 94, paed)).toBeNull();
    expect(await severityOf('oxygen_saturation', 93, paed)).toBe('WARNING');
    expect(await severityOf('oxygen_saturation', 88, paed)).toBe('CRITICAL');
  });

  it('checkVitalAnomalies with SpO2 100 returns no alerts and fires NO persistence or code-blue fan-out', async () => {
    queryRawMock.mockReset();
    setTenantTxMock.mockReset();
    emitCodeBlueMock.mockReset();
    emitVitalAnomalyMock.mockReset();
    queryRawMock.mockImplementation(async (sql) => {
      if (/FOR (?:NO KEY )?UPDATE/i.test(sql)) {
        return [{
          id: PATIENT_ID,
          uid: 'a1111111-2222-4333-8444-555555550042',
          is_active: true,
          status: 'active',
          merged_into_uid: null,
          is_deleted: false,
        }];
      }
      if (/DATE_PART|maternity_pregnancies/i.test(sql)) {
        return [{ age_years: 50, is_pregnant: false }];
      }
      return [];
    });
    setTenantTxMock.mockImplementation(async (_tenantId, fn) => fn(__prismaDefaultMock));

    const alerts = await checkVitalAnomalies(PATIENT_ID, { oxygen_saturation: 100 }, {
      recordedBy: 'nurse-uid',
      tenantId: DEFAULT_TENANT_ID,
    });

    expect(alerts).toEqual([]);
    expect(setTenantTxMock).toHaveBeenCalledTimes(1);
    expect(queryRawMock.mock.calls.some((call) => /INSERT INTO clinical_alerts/i.test(call[0]))).toBe(false);
    expect(emitCodeBlueMock).not.toHaveBeenCalled();
    expect(emitVitalAnomalyMock).not.toHaveBeenCalled();
  });
});

describe('band-edge matrix — inclusive critical comparators FROZEN for the other vitals (adult)', () => {
  // [vital, critical_min, min, max, critical_max]
  const ADULT_EDGES = [
    ['heart_rate', 30, 40, 150, 180],
    ['systolic_bp', 60, 80, 160, 200],
    ['diastolic_bp', 40, 50, 100, 120],
    ['temperature', 34.0, 35.5, 38.5, 40.0],
    ['respiratory_rate', 6, 10, 24, 35],
    ['blood_glucose', 50, 70, 180, 400],
  ];

  it.each(ADULT_EDGES)(
    '%s: == critical edges CRITICAL, == min/max normal, just outside min/max WARNING',
    async (vital, criticalMin, min, max, criticalMax) => {
      // Inclusive critical edges.
      expect(await severityOf(vital, criticalMin)).toBe('CRITICAL');
      expect(await severityOf(vital, criticalMax)).toBe('CRITICAL');
      // min/max themselves are normal.
      expect(await severityOf(vital, min)).toBeNull();
      expect(await severityOf(vital, max)).toBeNull();
      // Just outside the normal band (but inside critical) is WARNING.
      expect(await severityOf(vital, min - 0.1)).toBe('WARNING');
      expect(await severityOf(vital, max + 0.1)).toBe('WARNING');
      // Just inside the critical edges is still WARNING.
      expect(await severityOf(vital, criticalMin + 0.1)).toBe('WARNING');
      expect(await severityOf(vital, criticalMax - 0.1)).toBe('WARNING');
    },
  );
});

describe('band-edge matrix — paediatric table frozen', () => {
  const PAED_EDGES = [
    ['heart_rate', 50, 70, 140, 200],
    ['systolic_bp', 60, 75, 115, 130],
    ['diastolic_bp', 35, 45, 80, 95],
    ['temperature', 34.0, 35.5, 38.0, 40.0],
    ['respiratory_rate', 10, 18, 40, 60],
    ['blood_glucose', 40, 60, 180, 400],
  ];
  const paed = { ageYears: 8 };

  it.each(PAED_EDGES)(
    '%s: critical edges CRITICAL, min/max normal',
    async (vital, criticalMin, min, max, criticalMax) => {
      expect(await severityOf(vital, criticalMin, paed)).toBe('CRITICAL');
      expect(await severityOf(vital, criticalMax, paed)).toBe('CRITICAL');
      expect(await severityOf(vital, min, paed)).toBeNull();
      expect(await severityOf(vital, max, paed)).toBeNull();
      expect(await severityOf(vital, min - 0.1, paed)).toBe('WARNING');
      expect(await severityOf(vital, max + 0.1, paed)).toBe('WARNING');
    },
  );
});

describe('pregnancy BP overrides frozen', () => {
  const preg = { ageYears: 30, isPregnant: true };

  it('systolic: 139 normal, 140 WARNING, 160 CRITICAL; diastolic: 89 normal, 90 WARNING, 110 CRITICAL', async () => {
    expect(await severityOf('systolic_bp', 139, preg)).toBeNull();
    expect(await severityOf('systolic_bp', 140, preg)).toBe('WARNING');
    expect(await severityOf('systolic_bp', 160, preg)).toBe('CRITICAL');
    expect(await severityOf('diastolic_bp', 89, preg)).toBeNull();
    expect(await severityOf('diastolic_bp', 90, preg)).toBe('WARNING');
    expect(await severityOf('diastolic_bp', 110, preg)).toBe('CRITICAL');
  });

  it('pregnant SpO2 100 stays normal (adult one-sided SpO2 range applies)', async () => {
    expect(await severityOf('oxygen_saturation', 100, preg)).toBeNull();
  });
});
