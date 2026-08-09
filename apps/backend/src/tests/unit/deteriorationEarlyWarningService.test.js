import { jest } from '@jest/globals';

const findUnique = jest.fn();
const queryRawUnsafe = jest.fn();
jest.unstable_mockModule('../../lib/prisma.js', () => ({ default: { users: { findUnique }, $queryRawUnsafe: queryRawUnsafe } }));
jest.unstable_mockModule('../../logging/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
const getClinicalAiModule = jest.fn();
jest.unstable_mockModule('../../services/ai/clinicalAiModuleService.js', () => ({ getClinicalAiModule, default: { getClinicalAiModule } }));
const resolvePatientContext = jest.fn();
jest.unstable_mockModule('../../utils/clinical/vitalSignMonitor.js', () => ({ resolvePatientContext, default: { resolvePatientContext } }));
const persistCdsAlert = jest.fn();
jest.unstable_mockModule('../../services/emr/cdsEngine.js', () => ({ persistCdsAlert, default: { persistCdsAlert } }));

const { surfaceNews2Cds } = await import('../../services/cds/deteriorationEarlyWarningService.js');

const ADULT = { isPaediatric: false, isPregnant: false, ageYears: 50 };
beforeEach(() => {
  jest.clearAllMocks();
  findUnique.mockResolvedValue({ id: 7, tenant_id: 't1' });
  getClinicalAiModule.mockResolvedValue({ enabled: true });
  resolvePatientContext.mockResolvedValue(ADULT);
  queryRawUnsafe.mockResolvedValue([]); // no standing alert
  persistCdsAlert.mockResolvedValue({ persisted: true });
});
const news2 = (over) => ({ totalScore: 6, clinicalRisk: 'medium', escalationAction: 'x', scores: { heart_rate: 2 }, anyParamThree: false, ...over });

test('persists a warning cds_alert for an escalating score (5-6)', async () => {
  const r = await surfaceNews2Cds({ patientUid: 'p1', news2: news2() });
  expect(r.raised).toBe(true);
  expect(persistCdsAlert).toHaveBeenCalledWith(expect.objectContaining({ alertType: 'NEWS2_DETERIORATION', severity: 'warning', patientUid: 'p1' }));
});

test('persists a critical cds_alert for score >= 7', async () => {
  await surfaceNews2Cds({ patientUid: 'p1', news2: news2({ totalScore: 8, clinicalRisk: 'high' }) });
  expect(persistCdsAlert).toHaveBeenCalledWith(expect.objectContaining({ severity: 'critical' }));
});

test('raises on a single-parameter-3 even at low aggregate', async () => {
  const r = await surfaceNews2Cds({ patientUid: 'p1', news2: news2({ totalScore: 3, clinicalRisk: 'low_to_medium', anyParamThree: true }) });
  expect(r.raised).toBe(true);
  expect(persistCdsAlert).toHaveBeenCalledWith(expect.objectContaining({ severity: 'warning' }));
});

test('does not raise below threshold (score<5, no single-3)', async () => {
  const r = await surfaceNews2Cds({ patientUid: 'p1', news2: news2({ totalScore: 2, clinicalRisk: 'low_to_medium' }) });
  expect(r.raised).toBe(false);
  expect(persistCdsAlert).not.toHaveBeenCalled();
});

test('no-op when the module is disabled', async () => {
  getClinicalAiModule.mockResolvedValueOnce({ enabled: false });
  const r = await surfaceNews2Cds({ patientUid: 'p1', news2: news2() });
  expect(r.raised).toBe(false);
  expect(persistCdsAlert).not.toHaveBeenCalled();
});

test('no-op for a paediatric or pregnant patient', async () => {
  resolvePatientContext.mockResolvedValueOnce({ isPaediatric: true, isPregnant: false });
  const r = await surfaceNews2Cds({ patientUid: 'p1', news2: news2() });
  expect(r.raised).toBe(false);
  expect(persistCdsAlert).not.toHaveBeenCalled();
});

test('de-dups against a standing unacknowledged alert at equal-or-higher severity', async () => {
  queryRawUnsafe.mockResolvedValueOnce([{ severity: 'warning' }]); // standing warning
  const r = await surfaceNews2Cds({ patientUid: 'p1', news2: news2() }); // also warning
  expect(r.raised).toBe(false);
  expect(persistCdsAlert).not.toHaveBeenCalled();
});

test('escalates when the new severity is higher than the standing one', async () => {
  queryRawUnsafe.mockResolvedValueOnce([{ severity: 'warning' }]); // standing warning
  const r = await surfaceNews2Cds({ patientUid: 'p1', news2: news2({ totalScore: 8, clinicalRisk: 'high' }) }); // critical
  expect(r.raised).toBe(true);
  expect(persistCdsAlert).toHaveBeenCalledWith(expect.objectContaining({ severity: 'critical' }));
});

test('reports raised:false when persistence fails (no silent claim of success)', async () => {
  persistCdsAlert.mockResolvedValueOnce({ persisted: false, reason: 'persist_failed' });
  const r = await surfaceNews2Cds({ patientUid: 'p1', news2: news2() });
  expect(r.raised).toBe(false);
  expect(r.reason).toBe('persist_failed');
});
