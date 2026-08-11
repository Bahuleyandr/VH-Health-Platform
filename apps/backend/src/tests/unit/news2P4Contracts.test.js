import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jest } from '@jest/globals';

const queryMock = jest.fn();
const executeMock = jest.fn();
const setTenantTxMock = jest.fn();
const canonicalMock = jest.fn();
const supersedeTaskMock = jest.fn();

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
jest.unstable_mockModule('../../services/workflow/taskService.js', () => ({
  supersedeAcknowledgementTaskFromTrustedWorkflow: supersedeTaskMock,
}));

const {
  getPatientNEWS2History,
  presentNews2Record,
  supersedeNews2ForVitalsRow,
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

  it('never labels a latest partial score as stable or decreasing', async () => {
    queryMock.mockReset().mockResolvedValueOnce([
      {
        id: 2,
        total_score: 1,
        partial_score: true,
        missing_params: ['temperature'],
        superseded_at: null,
      },
      {
        id: 1,
        total_score: 8,
        partial_score: false,
        missing_params: null,
        superseded_at: null,
      },
    ]);

    await expect(getPatientNEWS2History(PATIENT, 10)).resolves.toMatchObject({
      trend: null,
      trend_available: false,
      trend_reason: 'latest_score_partial',
    });
  });

  it('returns an unavailable trend when fewer than two complete live scores exist', async () => {
    queryMock.mockReset().mockResolvedValueOnce([
      { id: 3, total_score: 4, partial_score: false, superseded_at: null },
      { id: 2, total_score: 9, partial_score: true, superseded_at: null },
      { id: 1, total_score: 1, partial_score: false, superseded_at: new Date() },
    ]);

    await expect(getPatientNEWS2History(PATIENT, 10)).resolves.toMatchObject({
      trend: null,
      trend_available: false,
      trend_reason: 'insufficient_complete_scores',
    });
  });

  it('ignores a partial prior row when comparing the two latest complete live scores', async () => {
    queryMock.mockReset().mockResolvedValueOnce([
      { id: 3, total_score: 3, partial_score: false, superseded_at: null },
      { id: 2, total_score: 9, partial_score: true, superseded_at: null },
      { id: 1, total_score: 1, partial_score: false, superseded_at: null },
    ]);

    await expect(getPatientNEWS2History(PATIENT, 10)).resolves.toMatchObject({
      trend: 'increasing',
      trend_available: true,
      trend_reason: null,
    });
  });
});

describe('P4 correction consequence reconciliation', () => {
  beforeEach(() => {
    queryMock.mockReset();
    executeMock.mockReset().mockResolvedValue(1);
    supersedeTaskMock.mockReset().mockResolvedValue({ status: 'superseded' });
  });

  it('SpO2 8→88 keeps the warning alert but supersedes its old critical task/SLA and CDS state', async () => {
    queryMock.mockImplementation(async (sql, _tenantId, _oldScoreIds, alertIds) => {
      if (/FROM news2_scores/.test(sql)) return [{ id: 701 }];
      if (/FROM clinical_alerts/.test(sql)) {
        return [{
          id: 17,
          vital_name: 'oxygen_saturation',
          vital_value: 8,
          severity: 'CRITICAL',
        }];
      }
      if (/UPDATE cds_alerts/.test(sql)) return [{ id: 23 }];
      if (/FROM tasks/.test(sql)) {
        return alertIds?.includes('17')
          ? [{
            id: 29,
            related_resource_type: 'clinical_alert',
            related_resource_id: '17',
            workflow_sla_instance_id: '44444444-4444-4444-8444-444444444444',
          }]
          : [];
      }
      return [];
    });

    const result = await supersedeNews2ForVitalsRow(42, 909, {
      db: tx,
      tenantId: TENANT,
      correctedBy: ACTOR,
      patientId: 88,
      deferNews2TaskRetirement: true,
      replacementNews2: {
        totalScore: 3,
        clinicalRisk: 'low_to_medium',
        severity: 'warning',
        title: 'NEWS2 3 — low to medium',
        description: 'Urgent review',
      },
      currentVitalAnomalies: [{
        patient_id: 88,
        vital_name: 'oxygen_saturation',
        value: 88,
        severity: 'WARNING',
        message: 'oxygen saturation 88% remains abnormal',
        recorded_by: 55,
      }],
    });

    const alertUpdate = executeMock.mock.calls.find(([sql]) => /UPDATE clinical_alerts/.test(sql));
    expect(alertUpdate).toEqual([
      expect.any(String),
      [17],
      88,
      'WARNING',
      'oxygen saturation 88% remains abnormal',
      TENANT,
    ]);
    expect(supersedeTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 29,
      relatedResourceType: 'clinical_alert',
      relatedResourceId: '17',
      workflowSlaInstanceId: '44444444-4444-4444-8444-444444444444',
      supersessionReason: 'superseded_by_correction',
      tx,
    }));
    const cdsUpdate = queryMock.mock.calls.find(([sql]) => /UPDATE cds_alerts/.test(sql));
    expect(cdsUpdate).toEqual(expect.arrayContaining(['warning']));
    expect(result).toMatchObject({
      alertsResolved: 0,
      alertsReconciled: 1,
      cdsAlertsReconciled: 1,
      tasksSuperseded: 1,
      activeAlertIdsByVitalName: { oxygen_saturation: 17 },
    });
  });

  it('pregnant severe BP critical→normal resolves its linked CDS mirror and task/SLA idempotently', async () => {
    let replay = false;
    queryMock.mockImplementation(async (sql, _tenantId, _oldScoreIds, alertIds) => {
      if (/FROM news2_scores/.test(sql)) return replay ? [] : [{ id: 701 }];
      if (/FROM clinical_alerts/.test(sql)) {
        return replay ? [] : [{ id: 17, vital_name: 'systolic_bp', severity: 'CRITICAL' }];
      }
      if (/SELECT[\s\S]+FROM cds_alerts/.test(sql) && /PREGNANCY_HYPERTENSION/.test(sql)) {
        return replay ? [] : [{
          id: 23,
          alert_type: 'PREGNANCY_HYPERTENSION',
          severity: 'CRITICAL',
          clinical_alert_id: '17',
          vital_name: 'systolic_bp',
        }];
      }
      if (/UPDATE cds_alerts/.test(sql) && /PREGNANCY_HYPERTENSION/.test(sql)) return [{ id: 23 }];
      if (/UPDATE cds_alerts/.test(sql)) return [];
      if (/FROM tasks/.test(sql)) {
        return !replay && alertIds?.includes('17')
          ? [{
            id: 29,
            related_resource_type: 'clinical_alert',
            related_resource_id: '17',
            workflow_sla_instance_id: '44444444-4444-4444-8444-444444444444',
          }]
          : [];
      }
      return [];
    });

    const first = await supersedeNews2ForVitalsRow(42, null, {
      db: tx,
      tenantId: TENANT,
      correctedBy: ACTOR,
      patientId: 88,
      patientUid: PATIENT,
      currentVitalAnomalies: [],
    });
    expect(first).toMatchObject({
      alertsResolved: 1,
      cdsAlertsResolved: 1,
      cdsAlertsReconciled: 0,
      tasksSuperseded: 1,
    });
    expect(supersedeTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      relatedResourceId: '17',
      workflowSlaInstanceId: '44444444-4444-4444-8444-444444444444',
    }));

    replay = true;
    const second = await supersedeNews2ForVitalsRow(42, null, {
      db: tx,
      tenantId: TENANT,
      correctedBy: ACTOR,
      patientId: 88,
      patientUid: PATIENT,
      currentVitalAnomalies: [],
    });
    expect(second).toMatchObject({
      alertsResolved: 0,
      cdsAlertsResolved: 0,
      cdsAlertsReconciled: 0,
      tasksSuperseded: 0,
    });
    expect(supersedeTaskMock).toHaveBeenCalledTimes(1);
  });

  it('pregnant severe BP critical→warning updates one linked CDS mirror and retires the critical task/SLA', async () => {
    queryMock.mockImplementation(async (sql, _tenantId, _oldScoreIds, alertIds) => {
      if (/FROM news2_scores/.test(sql)) return [{ id: 701 }];
      if (/FROM clinical_alerts/.test(sql)) {
        return [{ id: 17, vital_name: 'systolic_bp', severity: 'CRITICAL' }];
      }
      if (/SELECT[\s\S]+FROM cds_alerts/.test(sql) && /PREGNANCY_HYPERTENSION/.test(sql)) {
        return [{
          id: 23,
          alert_type: 'PREGNANCY_HYPERTENSION',
          severity: 'CRITICAL',
          clinical_alert_id: '17',
          vital_name: 'systolic_bp',
        }];
      }
      if (/UPDATE cds_alerts/.test(sql) && /PREGNANCY_HYPERTENSION/.test(sql)) return [{ id: 23 }];
      if (/UPDATE cds_alerts/.test(sql)) return [];
      if (/FROM tasks/.test(sql)) {
        return alertIds?.includes('17')
          ? [{
            id: 29,
            related_resource_type: 'clinical_alert',
            related_resource_id: '17',
            workflow_sla_instance_id: '44444444-4444-4444-8444-444444444444',
          }]
          : [];
      }
      return [];
    });

    const result = await supersedeNews2ForVitalsRow(42, 909, {
      db: tx,
      tenantId: TENANT,
      correctedBy: ACTOR,
      patientId: 88,
      patientUid: PATIENT,
      currentVitalAnomalies: [{
        patient_id: 88,
        vital_name: 'systolic_bp',
        value: 142,
        unit: 'mmHg',
        severity: 'WARNING',
        normal_range: '90-139',
        cohort: 'pregnant',
        message: 'Pregnancy-induced hypertension: systolic BP remains high',
        recorded_by: 55,
        is_pregnancy_bp_signal: true,
      }],
    });

    expect(result).toMatchObject({
      alertsResolved: 0,
      alertsReconciled: 1,
      cdsAlertsResolved: 0,
      cdsAlertsReconciled: 1,
      tasksSuperseded: 1,
      activeAlertIdsByVitalName: { systolic_bp: 17 },
    });
    const pregnancyUpdate = queryMock.mock.calls.find(([sql]) => (
      /UPDATE cds_alerts/.test(sql) && /PREGNANCY_HYPERTENSION/.test(sql)
    ));
    expect(pregnancyUpdate).toEqual(expect.arrayContaining(['WARNING']));
    expect(supersedeTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      relatedResourceId: '17',
      workflowSlaInstanceId: '44444444-4444-4444-8444-444444444444',
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
