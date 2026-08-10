import { jest } from '@jest/globals';

const queryRawUnsafe = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafe },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: (tenantId) => tenantId || '00000000-0000-4000-8000-000000000001',
}));

const { scoreDeterioration } = await import('../../services/ai/deteriorationEarlyWarningService.js');

const PATIENT_UID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const VITAL = {
  heart_rate: 92,
  systolic_bp: 118,
  diastolic_bp: 74,
  temperature: 37,
  spo2: 96,
  respiratory_rate: 18,
  recorded_at: new Date('2026-08-11T08:00:00Z'),
};

beforeEach(() => {
  queryRawUnsafe.mockReset();
});

test('a vitals database fault is not reclassified as no recent vitals and stable', async () => {
  queryRawUnsafe.mockRejectedValueOnce(new Error('database unavailable'));

  await expect(scoreDeterioration({ patientUid: PATIENT_UID, tenantId: TENANT_ID }))
    .rejects.toThrow('database unavailable');
});

test('a clean empty vitals result retains the explicit no-vitals decision-support response', async () => {
  queryRawUnsafe.mockResolvedValueOnce([]);

  await expect(scoreDeterioration({ patientUid: PATIENT_UID, tenantId: TENANT_ID }))
    .resolves.toMatchObject({
      score: 0,
      band: 'stable',
      contributors: { reason: 'no_vitals_in_last_4h' },
      vitals_sample_count: 0,
    });
});

test('a lab database fault is not scored as zero abnormal signals', async () => {
  queryRawUnsafe
    .mockResolvedValueOnce([VITAL])
    .mockRejectedValueOnce(new Error('database unavailable'));

  await expect(scoreDeterioration({ patientUid: PATIENT_UID, tenantId: TENANT_ID }))
    .rejects.toThrow('database unavailable');
});

test('snapshot persistence may degrade without falsifying the computed score', async () => {
  queryRawUnsafe
    .mockResolvedValueOnce([VITAL])
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(new Error('snapshot writer unavailable'));

  const result = await scoreDeterioration({ patientUid: PATIENT_UID, tenantId: TENANT_ID });

  expect(result.snapshot_id).toBeNull();
  expect(result).toMatchObject({
    patient_uid: PATIENT_UID,
    score: 2.5,
    band: 'stable',
    vitals_sample_count: 1,
  });
});
