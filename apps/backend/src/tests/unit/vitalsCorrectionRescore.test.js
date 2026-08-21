// Audit 2026-08-10 R4 pins for correctVitals in
// src/services/emr/vitalsChartService.js:
//
// Correcting a NEWS2-input field must re-derive the clinical state that was
// computed from the ORIGINAL values — previously a corrected SpO2 98→88 left
// the stale reassuring NEWS2/deterioration record untouched. Pinned here:
//
//   * a scoring-input correction re-runs persistNews2 on the CORRECTED row
//     values, inside the correction tx, linked via vitalsChartId;
//   * every prior live score for the row is superseded by the new score
//     (supersedeNews2ForVitalsRow on the same tx);
//   * escalation + anomaly detection re-run POST-COMMIT (same split as
//     recordVitals);
//   * a notes-only correction changes no scoring input and skips all of it.

import { jest } from '@jest/globals';

const usersFindUniqueMock = jest.fn();
const setTenantTxMock = jest.fn();
const checkVitalAnomaliesMock = jest.fn();
const recordCanonicalMock = jest.fn();
const currentCanonicalTransactionRevisionMock = jest.fn();
const resolveSpo2ScaleMock = jest.fn();
const persistNews2Mock = jest.fn();
const supersedeMock = jest.fn();
const retireSupersededTasksMock = jest.fn();
const escalateNews2Mock = jest.fn();
const isNews2EscalationFreshMock = jest.fn();

const PATIENT_UID = 'a1111111-2222-4333-8444-555555550003';
const NURSE_UID = 'b2222222-3333-4444-8555-666666660004';
const TENANT_ID = '55555555-5555-4555-8555-555555555555';
const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const VITALS_ID = 42;

const existingRow = {
  id: VITALS_ID,
  patient_uid: PATIENT_UID,
  encounter_id: null,
  encounter_uid: null,
  source: 'staff',
  spo2: 98,
  respiratory_rate: 16,
  heart_rate: null,
  systolic_bp: null,
  diastolic_bp: null,
  temperature: null,
  consciousness: null,
  supplemental_o2: false,
  o2_flow_rate: 0,
  notes: null,
  recorded_by: NURSE_UID,
  recorded_at: new Date(),
  created_at: new Date(),
};

// correctVitals reads the correction-window anchor from the LOCKED guard row's
// epoch twins, not from the delegate read — a timestamptz materialised by the
// driver is shifted by the database session timezone, and the window is only
// five minutes. Keep both mocks describing the same row so a test cannot pin a
// timestamp on one and silently exercise the other.
function setExisting(overrides = {}) {
  const row = { ...existingRow, ...overrides };
  const epoch = (v) => (v == null ? null : BigInt(new Date(v).getTime()));
  findUniqueMock.mockResolvedValue({ ...row });
  __txClient.$queryRawUnsafe.mockResolvedValue([{
    effective_state_unchanged: false,
    recorded_at_epoch_ms: epoch(row.recorded_at),
    created_at_epoch_ms: epoch(row.created_at),
  }]);
  return row;
}

const findUniqueMock = jest.fn();
const updateMock = jest.fn();
const auditCreateMock = jest.fn();

const __txClient = {
  vitals_chart: { findUnique: findUniqueMock, update: updateMock },
  users: { findUnique: usersFindUniqueMock },
  audit_logs: { create: auditCreateMock },
  $executeRawUnsafe: jest.fn().mockResolvedValue(1),
  $queryRawUnsafe: jest.fn(),
};

const __prismaDefaultMock = {
  users: { findUnique: usersFindUniqueMock },
  $queryRawUnsafe: jest.fn().mockResolvedValue([]),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: setTenantTxMock,
  setTenant: async (_t, fn) => fn(__prismaDefaultMock),
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
  recordCanonicalClinicalEvent: recordCanonicalMock,
  currentCanonicalTransactionRevision: currentCanonicalTransactionRevisionMock,
}));
jest.unstable_mockModule('../../services/clinical/news2Service.js', () => ({
  resolveSpo2ScaleForPatient: resolveSpo2ScaleMock,
  persistNews2: persistNews2Mock,
  supersedeNews2ForVitalsRow: supersedeMock,
  retireSupersededNews2TasksAfterReplacement: retireSupersededTasksMock,
  escalateNews2: escalateNews2Mock,
  isNews2EscalationFresh: isNews2EscalationFreshMock,
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  DEFAULT_TENANT_ID,
  requireTenantId: (tenantId) => tenantId || DEFAULT_TENANT_ID,
}));

const { correctVitals } = await import('../../services/emr/vitalsChartService.js');

function resetAll() {
  usersFindUniqueMock.mockReset();
  setTenantTxMock.mockReset();
  checkVitalAnomaliesMock.mockReset();
  recordCanonicalMock.mockReset();
  currentCanonicalTransactionRevisionMock.mockReset().mockResolvedValue('321');
  resolveSpo2ScaleMock.mockReset();
  persistNews2Mock.mockReset();
  supersedeMock.mockReset();
  retireSupersededTasksMock.mockReset();
  escalateNews2Mock.mockReset();
  isNews2EscalationFreshMock.mockReset().mockReturnValue(true);
  findUniqueMock.mockReset();
  updateMock.mockReset();
  auditCreateMock.mockReset();
  __txClient.$queryRawUnsafe.mockReset();

  usersFindUniqueMock.mockImplementation(async ({ where }) => {
    if (where?.uid === PATIENT_UID) return { id: 777 };
    if (where?.uid === NURSE_UID) return { id: 55 };
    return null;
  });
  setTenantTxMock.mockImplementation(async (_tenantId, fn) => fn(__txClient));
  setExisting();
  updateMock.mockImplementation(async ({ data }) => ({ ...existingRow, ...data }));
  auditCreateMock.mockResolvedValue({ id: 1 });
  checkVitalAnomaliesMock.mockResolvedValue([{
    patient_id: 777,
    vital_name: 'oxygen_saturation',
    value: 88,
    severity: 'WARNING',
    message: 'oxygen saturation 88% is low',
    recorded_by: 55,
  }]);
  recordCanonicalMock.mockResolvedValue({ timeline: { id: 1 }, audit: { id: 2 } });
  resolveSpo2ScaleMock.mockResolvedValue(1);
  persistNews2Mock.mockResolvedValue({
    record: { id: 909, total_score: 3 },
    computed: {
      totalScore: 3,
      clinicalRisk: 'low_medium',
      escalationAction: 'Urgent clinical review',
      scores: { spo2: 3 },
      anyParamThree: true,
    },
  });
  escalateNews2Mock.mockResolvedValue(undefined);
  supersedeMock.mockResolvedValue({
    activeAlertIdsByVitalName: { oxygen_saturation: 17 },
  });
  retireSupersededTasksMock.mockResolvedValue({ tasksSuperseded: 1 });
}

describe('correctVitals — NEWS2 re-score on scoring-input corrections (R4)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('SpO2 98→88: re-scores on the tx with corrected values, supersedes, escalates, re-checks anomalies', async () => {
    resetAll();

    await correctVitals(VITALS_ID, {
      corrected_by: NURSE_UID,
      tenantId: TENANT_ID,
      spo2: 88,
    });

    // Re-score ran on the tx client, from the CORRECTED row values, linked to
    // the corrected vitals row.
    expect(resolveSpo2ScaleMock).toHaveBeenCalledWith(PATIENT_UID, { db: __txClient });
    expect(persistNews2Mock).toHaveBeenCalledTimes(1);
    const [uid, vitals, recordedBy, options] = persistNews2Mock.mock.calls[0];
    expect(uid).toBe(PATIENT_UID);
    expect(vitals.spo2).toBe(88);
    expect(vitals.respiration_rate).toBe(16);
    expect(recordedBy).toBe(NURSE_UID);
    expect(options).toEqual({
      db: __txClient,
      spo2Scale: 1,
      vitalsChartId: VITALS_ID,
      recordedAt: existingRow.recorded_at,
    });

    // Prior live scores for the row are stamped superseded by the new score,
    // atomically with the insert (same tx).
    expect(supersedeMock).toHaveBeenCalledWith(VITALS_ID, 909, expect.objectContaining({
      db: __txClient,
      tenantId: TENANT_ID,
      correctedBy: NURSE_UID,
      patientId: 777,
      currentVitalAnomalies: expect.arrayContaining([
        expect.objectContaining({ vital_name: 'oxygen_saturation', value: 88 }),
      ]),
    }));
    expect(currentCanonicalTransactionRevisionMock).toHaveBeenCalledWith(__txClient);
    expect(recordCanonicalMock).toHaveBeenCalledWith(expect.objectContaining({
      timelineIdempotencyKey: `vitals_chart:${VITALS_ID}:corrected:tx:321`,
      auditIdempotencyKey: `vitals_chart:${VITALS_ID}:audit:corrected:tx:321`,
    }), { db: __txClient, strict: true });

    // Escalation runs post-commit against the NEW score.
    expect(escalateNews2Mock).toHaveBeenCalledTimes(1);
    const [escUid, escRecord, , escOptions] = escalateNews2Mock.mock.calls[0];
    expect(escUid).toBe(PATIENT_UID);
    expect(escRecord.id).toBe(909);
    expect(escOptions).toEqual({ tenantId: TENANT_ID });

    // Anomaly detection re-runs on the corrected values.
    expect(checkVitalAnomaliesMock).toHaveBeenCalledTimes(2);
    const [patientId, vitalsForCheck, context] = checkVitalAnomaliesMock.mock.calls[1];
    expect(patientId).toBe(777);
    expect(vitalsForCheck.oxygen_saturation).toBe(88);
    expect(context.tenantId).toBe(TENANT_ID);
    expect(context.persistedClinicalAlertIdsByVitalName).toEqual({ oxygen_saturation: 17 });
    expect(checkVitalAnomaliesMock.mock.calls[0][2]).toEqual(expect.objectContaining({
      db: __txClient,
      classifyOnly: true,
      strictPatientContext: true,
    }));
  });

  it('a notes-only correction does NOT re-score, supersede, escalate, or re-check', async () => {
    resetAll();

    await correctVitals(VITALS_ID, {
      corrected_by: NURSE_UID,
      tenantId: TENANT_ID,
      notes: 'clarified probe position',
    });

    expect(persistNews2Mock).not.toHaveBeenCalled();
    expect(supersedeMock).not.toHaveBeenCalled();
    expect(escalateNews2Mock).not.toHaveBeenCalled();
    expect(checkVitalAnomaliesMock).not.toHaveBeenCalled();
  });

  it('returns an effective-state retry before update, canonical evidence, audit, or re-score', async () => {
    resetAll();
    __txClient.$queryRawUnsafe.mockResolvedValueOnce([{
      effective_state_unchanged: true,
    }]);

    const result = await correctVitals(VITALS_ID, {
      corrected_by: NURSE_UID,
      tenantId: TENANT_ID,
      spo2: 98,
    });

    expect(result).toMatchObject({ id: VITALS_ID, spo2: 98 });
    expect(updateMock).not.toHaveBeenCalled();
    expect(auditCreateMock).not.toHaveBeenCalled();
    expect(recordCanonicalMock).not.toHaveBeenCalled();
    expect(currentCanonicalTransactionRevisionMock).not.toHaveBeenCalled();
    expect(persistNews2Mock).not.toHaveBeenCalled();
    expect(supersedeMock).not.toHaveBeenCalled();
    expect(escalateNews2Mock).not.toHaveBeenCalled();
    expect(checkVitalAnomaliesMock).not.toHaveBeenCalled();
  });

  it('returns a replay of the SpO2 8→88 correction as a no-op after the five-minute window', async () => {
    resetAll();
    const now = Date.parse('2026-08-12T00:00:00.000Z');
    const dateNow = jest.spyOn(Date, 'now').mockReturnValue(now);
    findUniqueMock.mockResolvedValue({
      ...existingRow,
      spo2: 88,
      recorded_at: new Date(now - (10 * 60 * 1000)),
      created_at: new Date(now - (10 * 60 * 1000)),
    });
    __txClient.$queryRawUnsafe.mockResolvedValueOnce([{ effective_state_unchanged: true }]);

    await expect(correctVitals(VITALS_ID, {
      corrected_by: NURSE_UID,
      tenantId: TENANT_ID,
      spo2: 88,
    })).resolves.toMatchObject({ id: VITALS_ID, spo2: 88 });

    expect(updateMock).not.toHaveBeenCalled();
    expect(recordCanonicalMock).not.toHaveBeenCalled();
    expect(supersedeMock).not.toHaveBeenCalled();
    dateNow.mockRestore();
  });

  it('allows a genuine mutation exactly at five minutes', async () => {
    resetAll();
    const now = Date.parse('2026-08-12T00:00:00.000Z');
    const dateNow = jest.spyOn(Date, 'now').mockReturnValue(now);
    setExisting({
      recorded_at: new Date(now - (5 * 60 * 1000)),
      created_at: new Date(now - (5 * 60 * 1000)),
    });

    await expect(correctVitals(VITALS_ID, {
      corrected_by: NURSE_UID,
      tenantId: TENANT_ID,
      spo2: 88,
    })).resolves.toMatchObject({ id: VITALS_ID, spo2: 88 });
    expect(updateMock).toHaveBeenCalledTimes(1);
    dateNow.mockRestore();
  });

  it('rejects a genuine mutation one millisecond after five minutes', async () => {
    resetAll();
    const now = Date.parse('2026-08-12T00:00:00.000Z');
    const dateNow = jest.spyOn(Date, 'now').mockReturnValue(now);
    setExisting({
      recorded_at: new Date(now - (5 * 60 * 1000) - 1),
      created_at: new Date(now - (5 * 60 * 1000) - 1),
    });

    await expect(correctVitals(VITALS_ID, {
      corrected_by: NURSE_UID,
      tenantId: TENANT_ID,
      spo2: 88,
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(updateMock).not.toHaveBeenCalled();
    dateNow.mockRestore();
  });

  it('retires the stale score when the corrected row has no scorable NEWS2 parameter', async () => {
    resetAll();
    persistNews2Mock.mockResolvedValue(null);

    await correctVitals(VITALS_ID, {
      corrected_by: NURSE_UID,
      tenantId: TENANT_ID,
      heart_rate: 15,
    });

    expect(persistNews2Mock).toHaveBeenCalledTimes(1);
    expect(supersedeMock).toHaveBeenCalledWith(VITALS_ID, null, expect.objectContaining({
      db: __txClient,
      tenantId: TENANT_ID,
      correctedBy: NURSE_UID,
      patientId: 777,
    }));
    expect(escalateNews2Mock).not.toHaveBeenCalled();
    // Anomaly re-check still runs — it is not gated on NEWS2 scorability.
    expect(checkVitalAnomaliesMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the reconciled alert durable when post-commit fan-out fails', async () => {
    resetAll();
    checkVitalAnomaliesMock
      .mockResolvedValueOnce([{
        patient_id: 777,
        vital_name: 'oxygen_saturation',
        value: 88,
        severity: 'WARNING',
        message: 'oxygen saturation remains low',
        recorded_by: 55,
      }])
      .mockRejectedValueOnce(new Error('notification fabric unavailable'));

    await expect(correctVitals(VITALS_ID, {
      corrected_by: NURSE_UID,
      tenantId: TENANT_ID,
      spo2: 88,
    })).rejects.toMatchObject({ statusCode: 500 });

    expect(supersedeMock).toHaveBeenCalledWith(VITALS_ID, 909, expect.objectContaining({
      currentVitalAnomalies: expect.arrayContaining([
        expect.objectContaining({ vital_name: 'oxygen_saturation' }),
      ]),
    }));
  });

  it('derives oxygen therapy state and re-scores when FHIR oxygen flow is corrected', async () => {
    resetAll();
    const fhirRow = {
      ...existingRow,
      source: 'fhir',
      spo2: 94,
      supplemental_o2: true,
      o2_flow_rate: 2,
    };
    findUniqueMock.mockResolvedValue(fhirRow);
    updateMock.mockImplementation(async ({ data }) => ({ ...fhirRow, ...data }));

    await correctVitals(VITALS_ID, {
      corrected_by: NURSE_UID,
      tenantId: TENANT_ID,
      o2_flow_rate: 0,
    });

    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ o2_flow_rate: 0, supplemental_o2: false }),
    }));
    expect(persistNews2Mock).toHaveBeenCalledWith(
      PATIENT_UID,
      expect.objectContaining({ supplemental_o2: false }),
      NURSE_UID,
      expect.objectContaining({ db: __txClient, vitalsChartId: VITALS_ID }),
    );
    expect(supersedeMock).toHaveBeenCalledWith(
      VITALS_ID,
      909,
      expect.objectContaining({
        db: __txClient,
        tenantId: TENANT_ID,
        correctedBy: NURSE_UID,
        currentVitalAnomalies: expect.any(Array),
      }),
    );
  });
});
