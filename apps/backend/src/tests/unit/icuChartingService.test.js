import { jest } from '@jest/globals';

const queryRawMock = jest.fn();
const executeRawMock = jest.fn();
const setTenantTxMock = jest.fn();
const timelineMock = jest.fn();
const auditMock = jest.fn();

const txMock = {
  $queryRawUnsafe: queryRawMock,
  $executeRawUnsafe: executeRawMock
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: txMock,
  setTenantTx: setTenantTxMock
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: tenantId => tenantId || '00000000-0000-4000-8000-000000000001'
}));

jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordTimelineEvent: timelineMock,
  recordClinicalAuditEvent: auditMock
}));

const {
  closeIcuDeviceAssociationsForAdmission,
  getIcuChartView,
  linkDeviceObservation,
  recordScoringOutput,
  startLinePresence
} = await import('../../services/clinical/icuChartingService.js');

const TENANT = '11111111-1111-4111-8111-111111111111';
const PATIENT = '22222222-2222-4222-8222-222222222222';
const ACTOR = '33333333-3333-4333-8333-333333333333';

function admission(overrides = {}) {
  return {
    id: 12,
    tenant_id: TENANT,
    patient_uid: PATIENT,
    admission_id: 44,
    unit_code: 'ICU-A',
    bed_no: 'A1',
    admitted_at: new Date('2026-07-09T08:00:00.000Z'),
    discharged_at: null,
    status: 'active',
    monitoring_interval_minutes: 15,
    ...overrides
  };
}

describe('icuChartingService', () => {
  beforeEach(() => {
    queryRawMock.mockReset();
    executeRawMock.mockReset();
    setTenantTxMock.mockReset();
    timelineMock.mockReset();
    auditMock.mockReset();
    setTenantTxMock.mockImplementation(async (_tenantId, fn) => fn(txMock));
    timelineMock.mockResolvedValue({ id: 1 });
    auditMock.mockResolvedValue({ id: 2 });
  });

  it('adapts denominator line presence into device_presence_logs', async () => {
    queryRawMock
      .mockResolvedValueOnce([admission()])
      .mockResolvedValueOnce([{ id: 81 }])
      .mockResolvedValueOnce([
        {
          id: 91,
          tenant_id: TENANT,
          icu_admission_id: 12,
          patient_uid: PATIENT,
          presence_kind: 'central_line',
          denominator_device_type: 'central_line',
          device_presence_log_id: 81,
          started_at: new Date('2026-07-09T09:00:00.000Z'),
          stopped_at: null
        }
      ]);

    const row = await startLinePresence({
      tenantId: TENANT,
      icuAdmissionId: 12,
      actorUid: ACTOR,
      actorRole: 'doctor',
      presence_kind: 'central_line',
      display_label: 'Right IJ central line'
    });

    expect(row.device_presence_log_id).toBe(81);
    expect(queryRawMock.mock.calls[1][0]).toMatch(/INSERT INTO device_presence_logs/);
    expect(queryRawMock.mock.calls[1]).toContain('central_line');
    expect(timelineMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'icu.line_presence_started',
        patientUid: PATIENT,
        tenantId: TENANT
      }),
      { db: txMock }
    );
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'icu.line_presence.started',
        resourceTable: 'icu_line_tube_drain_events'
      }),
      { db: txMock }
    );
  });

  it('does not create denominator logs for non-denominator drains', async () => {
    queryRawMock.mockResolvedValueOnce([admission({ admission_id: null })]).mockResolvedValueOnce([
      {
        id: 92,
        tenant_id: TENANT,
        icu_admission_id: 12,
        patient_uid: PATIENT,
        presence_kind: 'surgical_drain',
        denominator_device_type: null,
        device_presence_log_id: null,
        started_at: new Date('2026-07-09T09:00:00.000Z'),
        stopped_at: null
      }
    ]);

    const row = await startLinePresence({
      tenantId: TENANT,
      icuAdmissionId: 12,
      actorUid: ACTOR,
      presence_kind: 'surgical_drain'
    });

    expect(row.device_presence_log_id).toBeNull();
    expect(queryRawMock.mock.calls.map(([sql]) => sql).join('\n')).not.toMatch(
      /device_presence_logs/
    );
  });

  it('suppresses reassuring copy for partial NEWS2 scores in the ICU chart', async () => {
    queryRawMock.mockImplementation(async (sql) => {
      if (/FROM icu_admissions/.test(sql)) return [admission()];
      if (/FROM news2_scores/.test(sql)) {
        return [{
          id: 71,
          patient_uid: PATIENT,
          recorded_at: new Date('2026-07-09T10:00:00.000Z'),
          total_score: 0,
          clinical_risk: 'low',
          escalation_action: 'Routine monitoring every 12 hours',
          partial_score: true,
          missing_params: ['temperature', 'systolic_bp'],
        }];
      }
      return [];
    });

    const result = await getIcuChartView({
      tenantId: TENANT,
      icuAdmissionId: 12,
      at: '2026-07-09T12:00:00.000Z',
    });

    expect(result.news2_scores[0]).toMatchObject({
      total_score: 0,
      clinical_risk: null,
      escalation_action: null,
      partial_score: true,
      risk_band_available: false,
      display: expect.stringMatching(/partial.*risk band unavailable/i),
    });
  });

  it('fails score output closed when protocol reference or reviewer is missing', async () => {
    await expect(
      recordScoringOutput({
        tenantId: TENANT,
        icuAdmissionId: 12,
        actorUid: ACTOR,
        scoring_kind: 'sofa',
        score_value: 6
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'ICU_SCORE_REFERENCE_REQUIRED'
    });
    expect(setTenantTxMock).not.toHaveBeenCalled();
  });

  it('allows explicit protocol-unavailable score outputs without mutating orders', async () => {
    queryRawMock.mockResolvedValueOnce([admission()]).mockResolvedValueOnce([
      {
        id: 33,
        tenant_id: TENANT,
        icu_admission_id: 12,
        patient_uid: PATIENT,
        scoring_kind: 'sbt',
        score_value: null,
        score_label: 'not available',
        review_status: 'protocol_unavailable',
        protocol_available: false,
        order_mutation_performed: false,
        recorded_at: new Date('2026-07-09T10:00:00.000Z')
      }
    ]);

    const row = await recordScoringOutput({
      tenantId: TENANT,
      icuAdmissionId: 12,
      actorUid: ACTOR,
      scoring_kind: 'sbt',
      review_status: 'protocol_unavailable',
      unavailable_reason: 'No local SBT protocol published'
    });

    expect(row.order_mutation_performed).toBe(false);
    expect(queryRawMock.mock.calls[1][0]).toMatch(/order_mutation_performed/);
    expect(queryRawMock.mock.calls[1][0]).toMatch(/FALSE/);
    expect(queryRawMock.mock.calls[1]).toContain(false);
  });

  it('rejects device vitals links that do not belong to the ICU patient', async () => {
    queryRawMock.mockResolvedValueOnce([admission()]).mockResolvedValueOnce([]);

    await expect(
      linkDeviceObservation({
        tenantId: TENANT,
        icuAdmissionId: 12,
        actorUid: ACTOR,
        vitals_chart_id: 777
      })
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(queryRawMock.mock.calls.map(([sql]) => sql).join('\n')).not.toMatch(
      /INSERT INTO icu_device_observation_links/
    );
  });

  it('closes ICU device associations with aligned SQL placeholders on discharge', async () => {
    queryRawMock.mockResolvedValueOnce([admission()]);

    await closeIcuDeviceAssociationsForAdmission({
      tx: txMock,
      tenantId: TENANT,
      icuAdmissionId: 12,
      actorUid: ACTOR,
      reason: 'discharge',
      stoppedAt: '2026-07-09T11:00:00.000Z'
    });

    expect(executeRawMock).toHaveBeenCalledTimes(3);
    const first = executeRawMock.mock.calls[0];
    expect(first[0]).toMatch(/UPDATE device_patient_associations/);
    expect(first[0]).not.toContain('$6');
    expect(first.slice(1)).toHaveLength(5);
    expect(first.slice(1)).toEqual([
      TENANT,
      PATIENT,
      '2026-07-09T11:00:00.000Z',
      ACTOR,
      'discharge'
    ]);
  });
});
