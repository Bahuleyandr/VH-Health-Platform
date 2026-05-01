/**
 * Tier H operational-forecasting unit tests.
 */

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const getModuleMock = jest.fn();
const generateClinicalTextMock = jest.fn();
const runOutputDefensesMock = jest.fn(() => []);

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryUnsafeMock },
}));
jest.unstable_mockModule('../../services/ai/clinicalAiModuleService.js', () => ({
  getClinicalAiModule: getModuleMock,
}));
jest.unstable_mockModule('../../services/ai/localLlmClient.js', () => ({
  generateClinicalText: generateClinicalTextMock,
}));
jest.unstable_mockModule('../../services/ai/hallucinationDefenses.js', () => ({
  runOutputDefenses: runOutputDefensesMock,
}));

const {
  generateAmbulanceDemandForecast,
  generateLabTatDelayPrediction,
  generatePackageComplianceCheck,
  generatePatientFeedbackSummary,
  generateRadiologyTatDelayPrediction,
  generateSentimentAnalysis,
  generateSmartQueueOptimization,
  generateTariffOptimizationInsights,
} = await import('../../services/ai/tierHOperationalService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '11111111-1111-4111-8111-111111111111';

function defaultModule(moduleKey) {
  return { module_key: moduleKey, display_name: moduleKey, enabled: true,
    settings: { reviewRoles: ['ADMIN'], requiresClinicianSignoff: false } };
}

beforeEach(() => {
  queryUnsafeMock.mockReset();
  getModuleMock.mockReset();
  generateClinicalTextMock.mockReset();
  runOutputDefensesMock.mockReset().mockReturnValue([]);
  generateClinicalTextMock.mockResolvedValue({
    text: JSON.stringify({
      explanation_summary: 'OK', key_points: [], next_steps: [], when_to_seek_help: [],
      source_citations: [], safety_flags: [],
    }),
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    usedAi: true, provider: 'mock', model: 'm', estimatedCostMinor: 0,
  });
});

describe('lab_tat_delay_prediction', () => {
  it('drafts using auto-fetched queue', async () => {
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 1, test_name: 'CBC', status: 'pending', requested_at: '2026-05-01', hours_pending: 8 },
    ]);
    getModuleMock.mockResolvedValue(defaultModule('lab_tat_delay_prediction'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 100 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateLabTatDelayPrediction({ tenantId: TENANT });
    expect(out.module_key).toBe('lab_tat_delay_prediction');
  });
  it('drafts using supplied snapshot', async () => {
    getModuleMock.mockResolvedValue(defaultModule('lab_tat_delay_prediction'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 200 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateLabTatDelayPrediction({
      tenantId: TENANT,
      queueSnapshot: [{ id: 1, test_name: 'CBC', hours_pending: 6 }],
    });
    expect(out.module_key).toBe('lab_tat_delay_prediction');
  });
});

describe('radiology_tat_delay_prediction', () => {
  it('drafts using supplied snapshot', async () => {
    getModuleMock.mockResolvedValue(defaultModule('radiology_tat_delay_prediction'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 300 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateRadiologyTatDelayPrediction({
      tenantId: TENANT,
      queueSnapshot: [{ id: 1, modality: 'MRI', body_part: 'brain', hours_pending: 18 }],
    });
    expect(out.module_key).toBe('radiology_tat_delay_prediction');
  });
});

describe('ambulance_demand_forecast', () => {
  it('drafts forecast', async () => {
    getModuleMock.mockResolvedValue(defaultModule('ambulance_demand_forecast'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 400 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateAmbulanceDemandForecast({
      tenantId: TENANT, horizonHours: 12,
      recentDispatches: [{ id: 1, dispatched_at: '2026-04-30', dispatch_kind: 'emergency' }],
    });
    expect(out.module_key).toBe('ambulance_demand_forecast');
  });
});

describe('smart_queue_optimization', () => {
  it('rejects non-array snapshot', async () => {
    await expect(generateSmartQueueOptimization({
      tenantId: TENANT, queueSnapshot: 'not-an-array',
    })).rejects.toThrow(/queue_snapshot must be an array/);
  });
  it('drafts optimization', async () => {
    getModuleMock.mockResolvedValue(defaultModule('smart_queue_optimization'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 500 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateSmartQueueOptimization({
      tenantId: TENANT, queueLabel: 'opd',
      queueSnapshot: [{ id: 1, position: 1, urgency: 'normal' }],
    });
    expect(out.module_key).toBe('smart_queue_optimization');
  });
});

describe('tariff_optimization_insights', () => {
  it('drafts insights', async () => {
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 1, service_code: 'CONS-001', service_name: 'consultation', unit_price_minor: 50000 },
    ]);
    getModuleMock.mockResolvedValue(defaultModule('tariff_optimization_insights'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 600 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateTariffOptimizationInsights({ tenantId: TENANT });
    expect(out.module_key).toBe('tariff_optimization_insights');
  });
});

describe('package_compliance_check', () => {
  it('throws 404 when admission missing', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(generatePackageComplianceCheck({ tenantId: TENANT, admissionId: 1 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
  it('drafts compliance check', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, patient_uid: PATIENT, admission_date: '2026-04-30',
      package_code: 'PKG-CABG-A', total_charges: 250000,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    getModuleMock.mockResolvedValue(defaultModule('package_compliance_check'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 700 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generatePackageComplianceCheck({
      tenantId: TENANT, admissionId: 1,
    });
    expect(out.module_key).toBe('package_compliance_check');
  });
});

describe('patient_feedback_summary', () => {
  it('throws 404 when no feedback', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(generatePatientFeedbackSummary({ tenantId: TENANT, periodDays: 30 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
  it('drafts summary when feedback present', async () => {
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 1, comment: 'good service', rating: 5, nps_score: 9, created_at: '2026-05-01' },
    ]);
    getModuleMock.mockResolvedValue(defaultModule('patient_feedback_summary'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 800 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generatePatientFeedbackSummary({ tenantId: TENANT, periodDays: 30 });
    expect(out.module_key).toBe('patient_feedback_summary');
  });
});

describe('sentiment_analysis', () => {
  it('rejects too-short text', async () => {
    await expect(generateSentimentAnalysis({ tenantId: TENANT, text: 'hi' }))
      .rejects.toThrow(/at least 5 characters/);
  });
  it('drafts sentiment classification', async () => {
    getModuleMock.mockResolvedValue(defaultModule('sentiment_analysis'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 900 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateSentimentAnalysis({
      tenantId: TENANT, text: 'The wait time was unacceptable and the receptionist was rude.',
    });
    expect(out.module_key).toBe('sentiment_analysis');
  });
});
