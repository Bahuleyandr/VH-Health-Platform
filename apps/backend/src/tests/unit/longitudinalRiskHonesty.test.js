import { jest } from '@jest/globals';

const queryRawUnsafe = jest.fn();
const scoreAdherenceRisk = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafe },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { debug: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

jest.unstable_mockModule('../../services/gamification/adherenceRiskService.js', () => ({
  scoreAdherenceRisk,
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: (tenantId) => tenantId || '00000000-0000-4000-8000-000000000001',
}));

const {
  getLatestRisk,
  scoreLongitudinalRisk,
} = await import('../../services/ai/longitudinalRiskService.js');

const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const PATIENT_UID = '11111111-1111-4111-8111-111111111111';
const ADMISSION = { id: 17, patient_uid: PATIENT_UID, patient_id: 23 };

beforeEach(() => {
  queryRawUnsafe.mockReset();
  scoreAdherenceRisk.mockReset();
  scoreAdherenceRisk.mockResolvedValue({ score: 20, band: 'low', source: 'heuristic' });
});

// The readmission bump is driven by `last_discharge_epoch_ms`, the absolute
// instant twin, not by `last_discharge` (PR #881). Every fixture below passes
// `last_discharge: null`, so this branch was never exercised with a real date —
// and a dropped twin reads as "no prior discharge", silently removing up to 30
// points of readmission risk while every existing assertion still passes. That
// is the same class of synthetic-zero this file exists to prevent.
const DAY_MS = 24 * 60 * 60 * 1000;

function admissionHistory({ cnt, daysSinceDischarge = null, avgLos = null }) {
  const row = { cnt, avg_los: avgLos, last_discharge: null, last_discharge_epoch_ms: null };
  if (daysSinceDischarge != null) {
    const at = new Date(Date.now() - daysSinceDischarge * DAY_MS);
    row.last_discharge = at.toISOString();
    row.last_discharge_epoch_ms = BigInt(at.getTime());
  }
  return [row];
}

function mockScoringRun(history) {
  queryRawUnsafe
    .mockResolvedValueOnce([ADMISSION])
    .mockResolvedValueOnce(history)
    .mockResolvedValueOnce([])                                    // diagnoses
    .mockResolvedValueOnce([{ active: 0 }])                       // abdm_consents
    .mockResolvedValueOnce([{ delivered: 0, last_delivered: null }]) // abdm_data_requests
    .mockResolvedValueOnce([{ active: 0 }])                       // patient_consents
    .mockResolvedValueOnce([{ id: 91 }]);                         // snapshot insert
}

test('a discharge inside 30 days adds the readmission bump', async () => {
  mockScoringRun(admissionHistory({ cnt: 1, daysSinceDischarge: 10 }));

  const result = await scoreLongitudinalRisk({
    admissionId: ADMISSION.id, req: { tenantId: TENANT_ID },
  });

  // 20 for one prior admission + 30 for a discharge inside 30 days.
  expect(result.readmission_score).toBe(50);
  expect(result.contributors.readmission).toMatchObject({
    prior_admissions_180d: 1,
    readmission_within_30d: 10,
  });
});

test('a discharge inside 60 days adds the smaller bump instead', async () => {
  mockScoringRun(admissionHistory({ cnt: 1, daysSinceDischarge: 45 }));

  const result = await scoreLongitudinalRisk({
    admissionId: ADMISSION.id, req: { tenantId: TENANT_ID },
  });

  // 20 + 15, and the 30-day contributor must not appear.
  expect(result.readmission_score).toBe(35);
  expect(result.contributors.readmission).toMatchObject({ readmission_within_60d: 45 });
  expect(result.contributors.readmission.readmission_within_30d).toBeUndefined();
});

test('a prior admission with no recorded discharge earns no readmission bump', async () => {
  mockScoringRun(admissionHistory({ cnt: 1 }));

  const result = await scoreLongitudinalRisk({
    admissionId: ADMISSION.id, req: { tenantId: TENANT_ID },
  });

  expect(result.readmission_score).toBe(20);
  expect(result.contributors.readmission.readmission_within_30d).toBeUndefined();
  expect(result.contributors.readmission.readmission_within_60d).toBeUndefined();
});

test('an adherence scorer fault cannot become a low authoritative risk score', async () => {
  queryRawUnsafe.mockResolvedValueOnce([ADMISSION]);
  scoreAdherenceRisk.mockRejectedValueOnce(new Error('adherence store unavailable'));

  await expect(scoreLongitudinalRisk({ admissionId: ADMISSION.id, req: { tenantId: TENANT_ID } }))
    .rejects.toThrow('adherence store unavailable');
});

test('an admissions history fault cannot contribute a synthetic zero', async () => {
  queryRawUnsafe
    .mockResolvedValueOnce([ADMISSION])
    .mockRejectedValueOnce(new Error('admissions history unavailable'));

  await expect(scoreLongitudinalRisk({ admissionId: ADMISSION.id, req: { tenantId: TENANT_ID } }))
    .rejects.toThrow('admissions history unavailable');
});

test('a diagnoses fault cannot contribute a synthetic zero', async () => {
  queryRawUnsafe
    .mockResolvedValueOnce([ADMISSION])
    .mockResolvedValueOnce([{ cnt: 0, avg_los: null, last_discharge: null, last_discharge_epoch_ms: null }])
    .mockRejectedValueOnce(new Error('diagnoses unavailable'));

  await expect(scoreLongitudinalRisk({ admissionId: ADMISSION.id, req: { tenantId: TENANT_ID } }))
    .rejects.toThrow('diagnoses unavailable');
});

test('snapshot persistence failure rejects instead of returning an unaudited risk band', async () => {
  queryRawUnsafe
    .mockResolvedValueOnce([ADMISSION])
    .mockResolvedValueOnce([{ cnt: 0, avg_los: null, last_discharge: null, last_discharge_epoch_ms: null }])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ active: 0 }])
    .mockResolvedValueOnce([{ delivered: 0, last_delivered: null }])
    .mockResolvedValueOnce([{ active: 0 }])
    .mockRejectedValueOnce(new Error('snapshot writer unavailable'));

  await expect(scoreLongitudinalRisk({ admissionId: ADMISSION.id, req: { tenantId: TENANT_ID } }))
    .rejects.toThrow('snapshot writer unavailable');
});

test('latest-risk lookup faults reject instead of looking like no prior assessment', async () => {
  queryRawUnsafe.mockRejectedValueOnce(new Error('risk snapshot store unavailable'));

  await expect(getLatestRisk({ admissionId: ADMISSION.id, tenantId: TENANT_ID }))
    .rejects.toThrow('risk snapshot store unavailable');
});

test('non-scoring ABDM enrichment may degrade only with an explicit unavailable contract', async () => {
  queryRawUnsafe
    .mockResolvedValueOnce([ADMISSION])
    .mockResolvedValueOnce([{ cnt: 0, avg_los: null, last_discharge: null, last_discharge_epoch_ms: null }])
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(new Error('ABDM consent store unavailable'))
    .mockRejectedValueOnce(new Error('ABDM request store unavailable'))
    .mockRejectedValueOnce(new Error('patient consent store unavailable'))
    .mockResolvedValueOnce([{ id: 91 }]);

  const result = await scoreLongitudinalRisk({
    admissionId: ADMISSION.id,
    req: { tenantId: TENANT_ID },
  });

  expect(result).toMatchObject({
    snapshot_id: 91,
    overall_score: 8,
    band: 'low',
    abdm_enrichment: {
      enrichment_available: false,
      enrichment_complete: false,
      reason: 'enrichment_unavailable',
      unavailable_components: ['abdm_consents', 'abdm_data_requests', 'patient_consents'],
    },
  });
});
