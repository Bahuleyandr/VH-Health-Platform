import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jest } from '@jest/globals';

const queryMock = jest.fn();
const executeMock = jest.fn();
const setTenantTxMock = jest.fn();
const canonicalMock = jest.fn();

const tx = {
  $queryRawUnsafe: queryMock,
  $executeRawUnsafe: executeMock,
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryMock },
  setTenantTx: setTenantTxMock,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: canonicalMock,
}));

const {
  presentNews2Record,
  updatePatientSpo2Scale,
} = await import('../../services/clinical/news2Service.js');

const TENANT = '11111111-1111-4111-8111-111111111111';
const PATIENT = '22222222-2222-4222-8222-222222222222';
const ACTOR = '33333333-3333-4333-8333-333333333333';

describe('P4 NEWS2 presentation contract', () => {
  it('suppresses a partial score risk/action while retaining explicit incompleteness', () => {
    expect(presentNews2Record({
      total_score: 0,
      clinical_risk: 'low',
      escalation_action: 'Routine monitoring every 12 hours',
      partial_score: true,
      missing_params: ['temperature', 'systolic_bp'],
    })).toEqual(expect.objectContaining({
      total_score: 0,
      clinical_risk: null,
      escalation_action: null,
      partial_score: true,
      missing_params: ['temperature', 'systolic_bp'],
      risk_band_available: false,
      display: expect.stringMatching(/partial.*risk band unavailable/i),
    }));
  });

  it('preserves the risk/action of a complete score', () => {
    expect(presentNews2Record({
      total_score: 5,
      clinical_risk: 'medium',
      escalation_action: 'Urgent review',
      partial_score: false,
      missing_params: null,
    })).toEqual(expect.objectContaining({
      clinical_risk: 'medium',
      escalation_action: 'Urgent review',
      risk_band_available: true,
    }));
  });
});

describe('P4 audited patient Scale-2 writer', () => {
  beforeEach(() => {
    queryMock.mockReset();
    executeMock.mockReset();
    canonicalMock.mockReset();
    setTenantTxMock.mockReset().mockImplementation(async (_tenantId, fn) => fn(tx));
    queryMock
      .mockResolvedValueOnce([{ uid: PATIENT, news2_spo2_scale: 1 }])
      .mockResolvedValueOnce([{ uid: PATIENT, news2_spo2_scale: 2 }]);
    canonicalMock.mockResolvedValue({ timeline: { id: 1 }, audit: { id: 2 } });
  });

  it('updates only the tenant patient and records the before/after clinical audit pair', async () => {
    const result = await updatePatientSpo2Scale({
      tenantId: TENANT,
      patientUid: PATIENT,
      spo2Scale: 2,
      actorUid: ACTOR,
      actorRole: 'DOCTOR',
      idempotencyKey: 'scale-change-1',
      requestId: 'request-1',
    });

    expect(result).toMatchObject({ news2_spo2_scale: 2, changed: true });
    const update = queryMock.mock.calls.find(([sql]) => /UPDATE users/.test(sql));
    expect(update[0]).toMatch(/tenant_id = \$2::uuid/);
    expect(update[0]).toMatch(/role = 'PATIENT'/);
    expect(update).toEqual(expect.arrayContaining([PATIENT, TENANT, 2]));
    expect(canonicalMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'news2.spo2_scale_updated',
      patientUid: PATIENT,
      actorUid: ACTOR,
      beforeState: { news2_spo2_scale: 1 },
      afterState: { news2_spo2_scale: 2 },
      timelineIdempotencyKey: expect.stringMatching(/[0-9a-f]{64}$/),
      auditIdempotencyKey: expect.stringMatching(/[0-9a-f]{64}$/),
    }), { db: tx, strict: true });
  });

  it('hashes the advertised 200-character request key into bounded canonical keys', async () => {
    const requestKey = 'k'.repeat(200);
    await updatePatientSpo2Scale({
      tenantId: TENANT,
      patientUid: PATIENT,
      spo2Scale: 2,
      actorUid: ACTOR,
      actorRole: 'DOCTOR',
      idempotencyKey: requestKey,
    });

    const event = canonicalMock.mock.calls[0][0];
    const digest = createHash('sha256').update(requestKey, 'utf8').digest('hex');
    expect(event.timelineIdempotencyKey.endsWith(digest)).toBe(true);
    expect(event.auditIdempotencyKey.endsWith(digest)).toBe(true);
    expect(event.timelineIdempotencyKey.length).toBeLessThanOrEqual(220);
    expect(event.auditIdempotencyKey.length).toBeLessThanOrEqual(220);
    expect(event.auditIdempotencyKey).not.toContain(requestKey);
  });

  it.each([0, 3, '2x', null, true, [2]])('rejects invalid scale %p before opening a transaction', async (spo2Scale) => {
    await expect(updatePatientSpo2Scale({
      tenantId: TENANT,
      patientUid: PATIENT,
      spo2Scale,
      actorUid: ACTOR,
      idempotencyKey: 'scale-change-invalid',
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(setTenantTxMock).not.toHaveBeenCalled();
  });
});

describe('P4 read-surface and route wiring', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const backend = path.resolve(here, '..', '..', '..');
  const read = (relative) => fs.readFileSync(path.join(backend, relative), 'utf8');

  it.each([
    'src/services/emr/clinicalTimelineService.js',
    'src/services/downtime/wardDowntimePackService.js',
    'src/services/downtime/continuityPackProducers.js',
    'src/services/clinical/icuChartingService.js',
  ])('%s selects partial_score and missing_params', (relative) => {
    const source = read(relative);
    expect(source).toMatch(/partial_score/);
    expect(source).toMatch(/missing_params/);
  });

  it('mounts an idempotent, clinical-role, patient-access-guarded Scale-2 PATCH', () => {
    const source = read('src/routes/patient/patientSearchRoutes.js');
    expect(source).toMatch(/router\.patch\(\s*['"]\/:uid\/news2-spo2-scale['"]/);
    expect(source).toMatch(/requireRole\(\.\.\.CLINICAL_STAFF_ROUTE_ROLES\)/);
    expect(source).toMatch(/requireIdempotencyKey\([^)]*patient_news2_spo2_scale/);
    expect(source).toMatch(/guardClinicalNews2ScaleWrite/);
    expect(source).toMatch(/updatePatientSpo2Scale/);
    expect(source).not.toMatch(/guardClinicalNews2ScaleWrite[\s\S]{0,180}careTeamModeGoverned:\s*true/);
  });
});
