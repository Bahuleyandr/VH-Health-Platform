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
    .mockResolvedValueOnce([{ cnt: 0, avg_los: null, last_discharge: null }])
    .mockRejectedValueOnce(new Error('diagnoses unavailable'));

  await expect(scoreLongitudinalRisk({ admissionId: ADMISSION.id, req: { tenantId: TENANT_ID } }))
    .rejects.toThrow('diagnoses unavailable');
});

test('snapshot persistence failure rejects instead of returning an unaudited risk band', async () => {
  queryRawUnsafe
    .mockResolvedValueOnce([ADMISSION])
    .mockResolvedValueOnce([{ cnt: 0, avg_los: null, last_discharge: null }])
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
    .mockResolvedValueOnce([{ cnt: 0, avg_los: null, last_discharge: null }])
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
