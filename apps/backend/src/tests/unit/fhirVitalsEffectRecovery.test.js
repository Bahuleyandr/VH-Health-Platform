import { jest } from '@jest/globals';

const setTenantTxMock = jest.fn();
const queryMock = jest.fn();
const checkVitalAnomaliesMock = jest.fn();
const calculateNews2Mock = jest.fn();
const escalateNews2Mock = jest.fn();
const isNews2EscalationFreshMock = jest.fn();

const tx = {
  $queryRawUnsafe: queryMock,
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: jest.fn() },
  setTenantTx: setTenantTxMock,
  setTenant: async (_tenantId, fn) => fn(tx),
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
  recordCanonicalClinicalEvent: jest.fn(),
  currentCanonicalTransactionRevision: jest.fn(),
}));
jest.unstable_mockModule('../../services/clinical/news2Service.js', () => ({
  calculateNEWS2: calculateNews2Mock,
  escalateNews2: escalateNews2Mock,
  isNews2EscalationFresh: isNews2EscalationFreshMock,
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  DEFAULT_TENANT_ID: '00000000-0000-4000-8000-000000000001',
  requireTenantId: (tenantId) => tenantId,
}));

const { reconcileRecordedVitalsEffects } = await import('../../services/emr/vitalsChartService.js');

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const PATIENT_UID = '22222222-2222-4222-8222-222222222222';
const RECORDED_AT = new Date('2026-08-11T18:00:00.000Z');

const recoveredRow = {
  id: 42,
  patient_uid: PATIENT_UID,
  patient_id: 88,
  recorded_by_id: 55,
  heart_rate: 132,
  systolic_bp: 92,
  diastolic_bp: 60,
  temperature: 38.1,
  spo2: 88,
  respiratory_rate: 28,
  supplemental_o2: false,
  consciousness: 'A',
  urine_albumin: null,
  recorded_at: RECORDED_AT,
  news2_id: 701,
  spo2_scale: 1,
  total_score: 8,
  clinical_risk: 'high',
};

function reset({ fresh = true } = {}) {
  setTenantTxMock.mockReset().mockImplementation(async (_tenantId, fn) => fn(tx));
  queryMock.mockReset().mockResolvedValue([{ ...recoveredRow }]);
  checkVitalAnomaliesMock.mockReset().mockResolvedValue([{ vital_name: 'oxygen_saturation' }]);
  calculateNews2Mock.mockReset().mockReturnValue({
    scorable: true,
    totalScore: 8,
    clinicalRisk: 'high',
    escalationAction: 'Immediate assessment',
    scores: { spo2: 3 },
    anyParamThree: true,
  });
  escalateNews2Mock.mockReset().mockResolvedValue({ skipped: false });
  isNews2EscalationFreshMock.mockReset().mockReturnValue(fresh);
}

describe('FHIR committed-effect recovery', () => {
  it('propagates source time and vitals identity so a fresh recovery escalates and links its anomaly', async () => {
    reset({ fresh: true });
    const onNews2EffectsCompleted = jest.fn();
    const onClinicalAlertsPersisted = jest.fn();

    await reconcileRecordedVitalsEffects({
      tenantId: TENANT_ID,
      vitalsChartId: 42,
      news2Pending: true,
      anomalyPending: true,
      onNews2EffectsCompleted,
      onClinicalAlertsPersisted,
    });

    expect(queryMock.mock.calls[0][0]).toMatch(/vitals\.recorded_at/);
    expect(escalateNews2Mock).toHaveBeenCalledWith(
      PATIENT_UID,
      expect.objectContaining({
        id: 701,
        recorded_at: RECORDED_AT,
        vitals_chart_id: 42,
      }),
      expect.any(Object),
      { tenantId: TENANT_ID },
    );
    expect(checkVitalAnomaliesMock).toHaveBeenCalledWith(
      88,
      expect.objectContaining({ oxygen_saturation: 88 }),
      expect.objectContaining({
        source: 'fhir',
        tenantId: TENANT_ID,
        sourceVitalsChartId: 42,
        onClinicalAlertsPersisted,
      }),
    );
    expect(onNews2EffectsCompleted).toHaveBeenCalledWith(expect.objectContaining({
      vitals: expect.objectContaining({ id: 42, recorded_at: RECORDED_AT }),
      news2: { id: 701 },
    }));
  });

  it('reconciles historical recovery receipts without creating a current anomaly', async () => {
    reset({ fresh: false });
    const onClinicalAlertsPersisted = jest.fn();

    await reconcileRecordedVitalsEffects({
      tenantId: TENANT_ID,
      vitalsChartId: 42,
      news2Pending: true,
      anomalyPending: true,
      onClinicalAlertsPersisted,
    });

    expect(escalateNews2Mock).toHaveBeenCalledWith(
      PATIENT_UID,
      expect.objectContaining({ recorded_at: RECORDED_AT, vitals_chart_id: 42 }),
      expect.any(Object),
      { tenantId: TENANT_ID },
    );
    expect(checkVitalAnomaliesMock).not.toHaveBeenCalled();
    expect(onClinicalAlertsPersisted).toHaveBeenCalledWith({ tx, alerts: [] });
  });

  it('does not replay completed clinical effects on an idempotent retry', async () => {
    reset({ fresh: true });
    await reconcileRecordedVitalsEffects({
      tenantId: TENANT_ID,
      vitalsChartId: 42,
      news2Pending: true,
      anomalyPending: true,
    });
    expect(escalateNews2Mock).toHaveBeenCalledTimes(1);
    expect(checkVitalAnomaliesMock).toHaveBeenCalledTimes(1);

    await reconcileRecordedVitalsEffects({
      tenantId: TENANT_ID,
      vitalsChartId: 42,
      news2Pending: false,
      anomalyPending: false,
    });
    expect(escalateNews2Mock).toHaveBeenCalledTimes(1);
    expect(checkVitalAnomaliesMock).toHaveBeenCalledTimes(1);
  });
});
