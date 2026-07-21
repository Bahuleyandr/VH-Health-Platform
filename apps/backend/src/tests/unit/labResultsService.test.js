import { jest } from '@jest/globals';
import { AppError } from '../../utils/AppError.js';

const queryRawUnsafeMock = jest.fn();
const executeRawUnsafeMock = jest.fn();
const emitCriticalLabAlertAcknowledgedMock = jest.fn();
const recordCanonicalClinicalEventMock = jest.fn();
const acknowledgeTaskMock = jest.fn();
const emitLabEventMock = jest.fn();
const lockResultsInboxResourceTxMock = jest.fn();
const materializeLabCriticalAlertGenerationMock = jest.fn();
const claimLabResultIngestCommandMock = jest.fn();
const completeLabResultIngestCommandMock = jest.fn();
const finaliseHttpIdempotencyInTxMock = jest.fn();
const resolveCurrentHumanActorTxMock = jest.fn();
const criticalDetectionResults = new Map();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryRawUnsafeMock,
  $executeRawUnsafe: executeRawUnsafeMock,
  // recordResultManual / signOffResults run their Phase-1 writes (detail row
  // + canonical pair) inside prisma.$transaction — passthrough to the same
  // mock client so the call sequences below stay observable.
  $transaction: async (fn) => fn(__prismaDefaultMock),
};
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  circuitBreakerStatus: jest.fn(() => ({ open: false, consecutiveFailures: 0 })),
  default: __prismaDefaultMock,
  isTenantTransactionClient: () => true,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

// labResultsService emits the canonical timeline/audit pair in-transaction;
// mock the canonical layer so the raw-call sequences stay lab-SQL-only and
// the emission itself is assertable. Factory exports the union of names the
// loaded import graph pulls from this module (ESM mock-graph law).
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: recordCanonicalClinicalEventMock,
  recordTimelineEvent: jest.fn().mockResolvedValue(null),
  recordClinicalAuditEvent: jest.fn().mockResolvedValue(null),
  startWorkflowSla: jest.fn().mockResolvedValue(null),
  completeWorkflowSla: jest.fn().mockResolvedValue(null),
  currentCanonicalTransactionRevision: jest.fn().mockResolvedValue(1),
  isSchemaMissing: jest.fn(() => false),
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.unstable_mockModule('../../services/clinical/canonicalOperationalBridgeService.js', () => ({
  emitCriticalLabAlertAcknowledged: emitCriticalLabAlertAcknowledgedMock,
}));

jest.unstable_mockModule('../../services/workflow/taskService.js', () => ({
  acknowledgeTask: acknowledgeTaskMock,
  acknowledgeLabCriticalAlertTaskFromTrustedWorkflow: acknowledgeTaskMock,
  LAB_CRITICAL_ALERT_ACK_CONTRACT_VERSION: 2,
}));

jest.unstable_mockModule('../../services/workflow/workflowHumanOwnerService.js', () => ({
  isTaskHumanOwnerRole: () => true,
  resolveCurrentHumanActorTx: resolveCurrentHumanActorTxMock,
}));

jest.unstable_mockModule('../../services/results/resultsInboxResourceLock.js', () => ({
  lockResultsInboxResourceTx: lockResultsInboxResourceTxMock,
}));

jest.unstable_mockModule('../../services/lab/labCriticalAlertService.js', () => ({
  materializeLabCriticalAlertGeneration: materializeLabCriticalAlertGenerationMock,
}));

jest.unstable_mockModule('../../services/lab/labResultIngestCommandService.js', () => ({
  claimLabResultIngestCommand: claimLabResultIngestCommandMock,
  completeLabResultIngestCommand: completeLabResultIngestCommandMock,
  finaliseHttpIdempotencyInTx: finaliseHttpIdempotencyInTxMock,
}));

jest.unstable_mockModule('../../utils/websocket/realtimeEmitter.js', () => ({
  emitLabEvent: emitLabEventMock,
}));

const {
  detectCriticalsForResults,
  recordResultManual,
  listLabWorklist,
  listIpdLabWorklist,
  signOffResults,
  acknowledgeAlert,
  classifySignedLabEpisode,
} = await import('../../services/lab/labResultsService.js');

describe('lab episode classification', () => {
  const signed = (overrides = {}) => ({
    id: 1,
    status: 'final',
    signed_off_at: new Date(),
    abnormal_flag: null,
    is_critical: false,
    value_text: '4.2',
    value_numeric: 4.2,
    ...overrides,
  });

  it.each([
    ['critical', [signed({ is_critical: true })]],
    ['abnormal', [signed({ abnormal_flag: 'H' })]],
    ['normal', [signed({ abnormal_flag: 'N' })]],
    ['indeterminate', [signed({ abnormal_flag: null, value_numeric: null, value_text: 'not reported' })]],
    ['critical', [signed({ abnormal_flag: 'H' }), signed({ is_critical: true })]],
  ])('classifies a complete signed panel as %s', (expected, rows) => {
    expect(classifySignedLabEpisode(rows)).toBe(expected);
  });
});

describe('labResultsService critical detection', () => {
  beforeEach(() => {
    queryRawUnsafeMock.mockReset();
    executeRawUnsafeMock.mockReset();
    emitCriticalLabAlertAcknowledgedMock.mockReset();
    executeRawUnsafeMock.mockResolvedValue(1);
    criticalDetectionResults.clear();
    materializeLabCriticalAlertGenerationMock.mockReset();
    materializeLabCriticalAlertGenerationMock.mockImplementation(async ({
      resultId,
      evaluateCriticality,
    }) => {
      const current = criticalDetectionResults.get(Number(resultId));
      const criticality = await evaluateCriticality({
        tx: __prismaDefaultMock,
        result: current,
      });
      if (!criticality.breached) {
        return {
          created: false,
          alert: null,
          state: criticality.matched
            ? 'within_active_critical_thresholds'
            : 'threshold_unavailable',
          criticality,
        };
      }
      return {
        created: true,
        alert: {
          id: 90 + Number(resultId),
          result_id: Number(resultId),
          patient_uid: current.patient_uid,
          threshold_breached: criticality.breachedSide,
        },
        state: 'critical',
        criticality,
      };
    });
  });

  it('maps TROPI / LOINC 10839-9 to the Troponin-I critical threshold', async () => {
    const tenantId = '00000000-0000-4000-8000-000000000001';
    const result = {
      id: 37,
      patient_uid: '5e89c1aa-df0c-4d19-9e7e-40af85486f24',
      loinc_code: '10839-9',
      test_code: 'TROPI',
      test_name: 'Troponin I',
      value_text: '0.85',
      value_numeric: '0.85',
      unit: 'ng/mL',
      is_critical: false,
    };
    criticalDetectionResults.set(result.id, result);

    queryRawUnsafeMock
      .mockResolvedValueOnce([{
        id: 17,
        loinc_code: '10839-9',
        test_code: 'TROPI',
        critical_low: null,
        critical_high: '0.04',
        test_name: 'Troponin I',
        unit: 'ng/mL',
        applies_to: 'all',
        match_rank: 0,
      }])
      .mockResolvedValueOnce([]);

    const alerts = await detectCriticalsForResults({ tenantId, results: [result] });

    expect(alerts).toHaveLength(1);
    expect(alerts[0].result_id).toBe(37);
    expect(result.is_critical).toBe(true);

    const thresholdLookup = queryRawUnsafeMock.mock.calls[0];
    expect(thresholdLookup[1]).toBe(tenantId);
    expect(thresholdLookup[2]).toEqual(expect.arrayContaining(['10839-9', '6598-7']));
    expect(thresholdLookup[3]).toEqual(expect.arrayContaining(['TROPI', 'TROP']));

    expect(materializeLabCriticalAlertGenerationMock).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId, resultId: 37 }),
    );
  });

  it('normalizes per-uL CBC counts before comparing x10^3/uL critical thresholds', async () => {
    const tenantId = '00000000-0000-4000-8000-000000000001';
    const patientUid = '5e89c1aa-df0c-4d19-9e7e-40af85486f24';
    const results = [
      {
        id: 29,
        patient_uid: patientUid,
        loinc_code: null,
        test_code: 'WBC',
        test_name: 'White blood cell count',
        value_text: '8200',
        value_numeric: '8200',
        unit: '/uL',
        is_critical: false,
      },
      {
        id: 30,
        patient_uid: patientUid,
        loinc_code: null,
        test_code: 'PLT',
        test_name: 'Platelet count',
        value_text: '245000',
        value_numeric: '245000',
        unit: '/uL',
        is_critical: false,
      },
    ];
    results.forEach((result) => criticalDetectionResults.set(result.id, result));

    queryRawUnsafeMock
      .mockResolvedValueOnce([{
        id: 18,
        loinc_code: null,
        test_code: 'WBC',
        critical_low: '2',
        critical_high: '30',
        test_name: 'White blood cell count',
        unit: '10^3/uL',
        applies_to: 'all',
        match_rank: 1,
      }])
      .mockResolvedValueOnce([{
        id: 19,
        loinc_code: null,
        test_code: 'PLT',
        critical_low: '30',
        critical_high: '1000',
        test_name: 'Platelet count',
        unit: '10^3/uL',
        applies_to: 'all',
        match_rank: 1,
      }]);

    const alerts = await detectCriticalsForResults({ tenantId, results });

    expect(alerts).toHaveLength(0);
    expect(results[0].is_critical).toBe(false);
    expect(results[1].is_critical).toBe(false);
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
  });
});

describe('labResultsService recordResultManual — investigation linkage', () => {
  const tenantId = '00000000-0000-4000-8000-000000000001';
  const patientUid = 'aaaa1111-2222-4333-8444-555555555555';

  beforeEach(() => {
    queryRawUnsafeMock.mockReset();
    executeRawUnsafeMock.mockReset();
    emitCriticalLabAlertAcknowledgedMock.mockReset();
    recordCanonicalClinicalEventMock.mockReset();
    recordCanonicalClinicalEventMock.mockResolvedValue({ timeline: null, audit: null });
    executeRawUnsafeMock.mockResolvedValue(1);
    claimLabResultIngestCommandMock.mockReset();
    claimLabResultIngestCommandMock.mockResolvedValue({
      replayed: false,
      command: { id: 501 },
    });
    completeLabResultIngestCommandMock.mockReset();
    completeLabResultIngestCommandMock.mockResolvedValue(undefined);
    finaliseHttpIdempotencyInTxMock.mockReset();
    finaliseHttpIdempotencyInTxMock.mockResolvedValue(undefined);
    materializeLabCriticalAlertGenerationMock.mockReset();
    materializeLabCriticalAlertGenerationMock.mockResolvedValue({
      created: false,
      alert: null,
      state: 'threshold_unavailable',
      criticality: { matched: false, breached: false },
    });
  });

  it('resolves investigation_id from booking_id when caller omits it, and advances investigations.status', async () => {
    // Sequence of $queryRawUnsafe calls inside recordResultManual for a
    // non-numeric value with no critical threshold and a booking_id:
    //   1-3) locked booking, patient, and investigation source validation
    //   4) lab_critical_thresholds probe (non-numeric branch) → empty
    //   5) lab_results dup-analyte probe (no prior finalised row) → empty
    //   6) lab_results INSERT
    //   7) investigation status advance
    //   8) final result reload after atomic materialization.
    const insertedResult = {
      id: 101,
      tenant_id: tenantId,
      booking_id: 7,
      investigation_id: 42,
      patient_uid: patientUid,
      patient_name: 'Canonical Patient',
      test_code: 'CBC',
      test_name: 'Complete Blood Count',
      value_text: 'No growth at 48 hours',
      value_numeric: null,
      unit: null,
      status: 'preliminary',
      is_critical: false,
    };
    queryRawUnsafeMock
      .mockResolvedValueOnce([{
        id: 7,
        patient_id: 23,
        investigation_id: 42,
        booking_status: 'COLLECTED',
      }])
      .mockResolvedValueOnce([{
        uid: patientUid,
        name: 'Canonical Patient',
      }])
      .mockResolvedValueOnce([{
        id: 42,
        patient_uid: patientUid,
        status: 'COLLECTED',
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([insertedResult])
      .mockResolvedValueOnce([{ id: 42 }])
      .mockResolvedValueOnce([insertedResult]);

    const { result } = await recordResultManual({
      tenantId,
      performed_by: 'lab-tech-uid',
      performed_by_role: 'LAB_TECHNICIAN',
      result: {
        booking_id: 7,
        patient_uid: patientUid,
        patient_name: 'Forged Patient Name',
        test_code: 'CBC',
        test_name: 'Complete Blood Count',
        value_text: 'No growth at 48 hours',
      },
    });

    expect(result.investigation_id).toBe(42);
    expect(result.patient_name).toBe('Canonical Patient');

    const bookingLock = queryRawUnsafeMock.mock.calls[0];
    expect(bookingLock[0]).toMatch(/FROM investigation_bookings AS booking/);
    expect(bookingLock[0]).toMatch(/FOR SHARE OF booking/);
    expect(bookingLock.slice(1)).toEqual([7, tenantId]);

    const patientLock = queryRawUnsafeMock.mock.calls[1];
    expect(patientLock[0]).toMatch(/FROM users AS patient/);
    expect(patientLock[0]).toMatch(/FOR SHARE OF patient/);
    expect(patientLock.slice(1)).toEqual([23, tenantId]);

    const investigationLock = queryRawUnsafeMock.mock.calls[2];
    expect(investigationLock[0]).toMatch(/FROM investigations AS investigation/);
    expect(investigationLock[0]).toMatch(/FOR UPDATE OF investigation/);
    expect(investigationLock.slice(1)).toEqual([42, tenantId]);

    // Canonical pair emitted in-transaction with actor attribution.
    expect(recordCanonicalClinicalEventMock).toHaveBeenCalledTimes(1);
    const canonicalInput = recordCanonicalClinicalEventMock.mock.calls[0][0];
    expect(canonicalInput.eventType).toBe('lab.result_recorded');
    expect(canonicalInput.patientUid).toBe(patientUid);
    expect(canonicalInput.actorUid).toBe('lab-tech-uid');
    expect(canonicalInput.actorRole).toBe('LAB_TECHNICIAN');
    expect(canonicalInput.sourceTable).toBe('lab_results');
    expect(recordCanonicalClinicalEventMock.mock.calls[0][1]).toMatchObject({ db: __prismaDefaultMock });

    // INSERT (call 6 — call 5 is the dup-analyte probe)
    // carries investigation_id=42 as $2.
    const insertCall = queryRawUnsafeMock.mock.calls[5];
    expect(insertCall[0]).toMatch(/INSERT INTO lab_results/);
    expect(insertCall[0]).toMatch(/investigation_id/);
    expect(insertCall[2]).toBe(42);
    expect(insertCall[4]).toBe('Canonical Patient');

    // The dup-analyte probe should also have happened (call 5).
    const dupProbe = queryRawUnsafeMock.mock.calls[4];
    expect(dupProbe[0]).toMatch(/FROM lab_results/);
    expect(dupProbe[0]).toMatch(/status IN/);
    expect(dupProbe[0]).toMatch(/tenant_id = \$3::uuid/);
    expect(dupProbe[3]).toBe(tenantId);

    const statusAdvance = queryRawUnsafeMock.mock.calls[6];
    expect(statusAdvance[0]).toMatch(/UPDATE investigations/);
    expect(statusAdvance[1]).toBe(42);
    expect(statusAdvance[2]).toEqual(
      expect.arrayContaining(['REQUESTED', 'PENDING', 'SCHEDULED', 'COLLECTED']),
    );
    expect(statusAdvance[3]).toBe(tenantId);
    expect(statusAdvance[0]).toMatch(/SET status = 'IN_PROGRESS'/);
    expect(statusAdvance[0]).toMatch(/tenant_id = \$3::uuid/);
  });

  it('rejects an investigation that belongs to a different patient before mutation', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{
      investigation_id: 42,
      investigation_patient_uid: 'bbbb1111-2222-4333-8444-555555555555',
      investigation_status: 'COLLECTED',
    }]);

    await expect(recordResultManual({
      tenantId,
      performed_by: 'lab-tech-uid',
      result: {
        investigation_id: 42,
        patient_uid: patientUid,
        test_code: 'K',
        test_name: 'Potassium',
        value_text: '4.1',
      },
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'LAB_RESULT_SOURCE_MISMATCH',
      message: 'Lab result source does not match the patient or investigation',
    });

    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
    expect(queryRawUnsafeMock.mock.calls[0][0]).toMatch(/FROM investigations AS investigation/);
    expect(queryRawUnsafeMock.mock.calls[0][0]).toMatch(/FOR UPDATE OF investigation/);
    expect(queryRawUnsafeMock.mock.calls[0].slice(1)).toEqual([42, tenantId]);
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
    expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
  });

  test.each(['CANCELLED', 'COMPLETED'])(
    'rejects a terminal %s investigation before result, command completion, or canonical mutation',
    async (investigationStatus) => {
      queryRawUnsafeMock.mockResolvedValueOnce([{
        investigation_id: 42,
        investigation_patient_uid: patientUid,
        investigation_status: investigationStatus,
        patient_name: 'Canonical Patient',
      }]);

      await expect(recordResultManual({
        tenantId,
        performed_by: 'lab-tech-uid',
        result: {
          investigation_id: 42,
          patient_uid: patientUid,
          test_code: 'K',
          test_name: 'Potassium',
          value_text: '4.1',
        },
      })).rejects.toMatchObject({
        statusCode: 400,
        code: 'LAB_RESULT_SOURCE_MISMATCH',
      });

      expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
      expect(queryRawUnsafeMock.mock.calls[0][0]).toMatch(/patient\.role = 'PATIENT'/);
      expect(queryRawUnsafeMock.mock.calls[0][0]).toMatch(/patient\.is_active = TRUE/);
      expect(completeLabResultIngestCommandMock).not.toHaveBeenCalled();
      expect(finaliseHttpIdempotencyInTxMock).not.toHaveBeenCalled();
      expect(materializeLabCriticalAlertGenerationMock).not.toHaveBeenCalled();
      expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
      expect(executeRawUnsafeMock).not.toHaveBeenCalled();
    },
  );

  it('rejects a direct investigation whose linked UID is not an active patient identity', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    await expect(recordResultManual({
      tenantId,
      performed_by: 'lab-tech-uid',
      result: {
        investigation_id: 42,
        patient_uid: patientUid,
        test_code: 'K',
        test_name: 'Potassium',
        value_text: '4.1',
      },
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'LAB_RESULT_SOURCE_MISMATCH',
    });

    const [sourceSql] = queryRawUnsafeMock.mock.calls[0];
    expect(sourceSql).toMatch(/JOIN users AS patient/);
    expect(sourceSql).toMatch(/patient\.role = 'PATIENT'/);
    expect(sourceSql).toMatch(/patient\.is_active = TRUE/);
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
    expect(completeLabResultIngestCommandMock).not.toHaveBeenCalled();
    expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
  });

  it('rejects a booking that belongs to a different patient before mutation', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{
        id: 7,
        patient_id: 24,
        investigation_id: 42,
        booking_status: 'COLLECTED',
      }])
      .mockResolvedValueOnce([{
        uid: 'bbbb1111-2222-4333-8444-555555555555',
        name: 'Different Patient',
      }]);

    await expect(recordResultManual({
      tenantId,
      performed_by: 'lab-tech-uid',
      result: {
        booking_id: 7,
        patient_uid: patientUid,
        test_code: 'K',
        test_name: 'Potassium',
        value_text: '4.1',
      },
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'LAB_RESULT_SOURCE_MISMATCH',
      message: 'Lab result source does not match the patient or investigation',
    });

    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(2);
    expect(queryRawUnsafeMock.mock.calls[0][0]).toMatch(/FROM investigation_bookings AS booking/);
    expect(queryRawUnsafeMock.mock.calls[0].slice(1)).toEqual([7, tenantId]);
    expect(queryRawUnsafeMock.mock.calls[1][0]).toMatch(/FROM users AS patient/);
    expect(queryRawUnsafeMock.mock.calls[1].slice(1)).toEqual([24, tenantId]);
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
    expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
  });

  test.each(['CANCELLED', 'COMPLETED'])(
    'rejects a terminal %s booking before resolving patient identity or mutating results',
    async (bookingStatus) => {
      queryRawUnsafeMock.mockResolvedValueOnce([{
        id: 7,
        patient_id: 23,
        investigation_id: 42,
        booking_status: bookingStatus,
      }]);

      await expect(recordResultManual({
        tenantId,
        performed_by: 'lab-tech-uid',
        result: {
          booking_id: 7,
          patient_uid: patientUid,
          test_code: 'K',
          test_name: 'Potassium',
          value_text: '4.1',
        },
      })).rejects.toMatchObject({
        statusCode: 400,
        code: 'LAB_RESULT_SOURCE_MISMATCH',
      });

      expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
      expect(queryRawUnsafeMock.mock.calls[0][0]).toMatch(/FROM investigation_bookings AS booking/);
      expect(completeLabResultIngestCommandMock).not.toHaveBeenCalled();
      expect(finaliseHttpIdempotencyInTxMock).not.toHaveBeenCalled();
      expect(materializeLabCriticalAlertGenerationMock).not.toHaveBeenCalled();
      expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
    },
  );

  it('rejects a booking whose linked user is not an active patient identity', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{
        id: 7,
        patient_id: 23,
        investigation_id: 42,
        booking_status: 'COLLECTED',
      }])
      .mockResolvedValueOnce([]);

    await expect(recordResultManual({
      tenantId,
      performed_by: 'lab-tech-uid',
      result: {
        booking_id: 7,
        patient_uid: patientUid,
        test_code: 'K',
        test_name: 'Potassium',
        value_text: '4.1',
      },
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'LAB_RESULT_SOURCE_MISMATCH',
    });

    const [patientSql] = queryRawUnsafeMock.mock.calls[1];
    expect(patientSql).toMatch(/FROM users AS patient/);
    expect(patientSql).toMatch(/patient\.role = 'PATIENT'/);
    expect(patientSql).toMatch(/patient\.is_active = TRUE/);
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(2);
    expect(completeLabResultIngestCommandMock).not.toHaveBeenCalled();
    expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
  });

  it('rejects a booking that is not linked to the asserted investigation before mutation', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{
        id: 7,
        patient_id: 23,
        investigation_id: 43,
        booking_status: 'COLLECTED',
      }])
      .mockResolvedValueOnce([{
        uid: patientUid,
        name: 'Canonical Patient',
      }]);

    await expect(recordResultManual({
      tenantId,
      performed_by: 'lab-tech-uid',
      result: {
        booking_id: 7,
        investigation_id: 42,
        patient_uid: patientUid,
        test_code: 'K',
        test_name: 'Potassium',
        value_text: '4.1',
      },
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'LAB_RESULT_SOURCE_MISMATCH',
    });

    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(2);
    expect(queryRawUnsafeMock.mock.calls[0][0]).toMatch(/FROM investigation_bookings AS booking/);
    expect(queryRawUnsafeMock.mock.calls[0].slice(1)).toEqual([7, tenantId]);
    expect(queryRawUnsafeMock.mock.calls[1][0]).toMatch(/FROM users AS patient/);
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
    expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
  });

  it('rejects manual result creation when no order or booking link exists', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([]);

    await expect(recordResultManual({
      tenantId,
      performed_by: 'lab-tech-uid',
      result: {
        patient_uid: patientUid,
        test_code: 'BLDCULT',
        test_name: 'Blood culture',
        value_text: 'No growth',
      },
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'LAB_RESULT_ORDER_LINK_REQUIRED',
    });

    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
    expect(claimLabResultIngestCommandMock).not.toHaveBeenCalled();
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('rejects pathologist sign-off for unlinked lab results', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{
      id: 102,
      patient_uid: patientUid,
      booking_id: null,
      investigation_id: null,
    }]);

    await expect(signOffResults({
      tenantId,
      signed_off_by: '33333333-3333-4333-8333-333333333333',
      signed_off_by_role: 'PATHOLOGIST',
      result_ids: [102],
      decision: 'verified',
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'LAB_RESULT_ORDER_LINK_REQUIRED',
      details: { result_ids: [102] },
    });
  });

  it('rejects an asserted patient_uid that does not own the selected result', async () => {
    const selected = [{
      id: 103,
      patient_uid: patientUid,
      booking_id: null,
      investigation_id: 42,
    }];
    queryRawUnsafeMock
      .mockResolvedValueOnce(selected)
      .mockResolvedValueOnce([{ lock_result: '' }])
      .mockResolvedValueOnce(selected);

    await expect(signOffResults({
      tenantId,
      signed_off_by: '33333333-3333-4333-8333-333333333333',
      signed_off_by_role: 'PATHOLOGIST',
      result_ids: [103],
      patient_uid: 'bbbb1111-2222-4333-8444-555555555555',
      decision: 'verified',
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'LAB_SIGNOFF_PATIENT_MISMATCH',
    });

    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(3);
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
    expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
  });

  it('rejects a mixed-patient result batch before creating a sign-off', async () => {
    const selected = [
      {
        id: 104,
        patient_uid: patientUid,
        booking_id: null,
        investigation_id: 42,
      },
      {
        id: 105,
        patient_uid: 'bbbb1111-2222-4333-8444-555555555555',
        booking_id: null,
        investigation_id: 42,
      },
    ];
    queryRawUnsafeMock
      .mockResolvedValueOnce(selected)
      .mockResolvedValueOnce([{ lock_result: '' }])
      .mockResolvedValueOnce(selected);

    await expect(signOffResults({
      tenantId,
      signed_off_by: '33333333-3333-4333-8333-333333333333',
      signed_off_by_role: 'PATHOLOGIST',
      result_ids: [104, 105],
      decision: 'verified',
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'LAB_SIGNOFF_MULTI_PATIENT_BATCH',
    });

    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(3);
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
    expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
  });

  it('rejects a booking assertion that differs from the locked selected result', async () => {
    const selected = [{
      id: 106,
      patient_uid: patientUid,
      booking_id: 7,
      investigation_id: null,
    }];
    queryRawUnsafeMock
      .mockResolvedValueOnce(selected)
      .mockResolvedValueOnce([{ lock_result: '' }])
      .mockResolvedValueOnce(selected);

    await expect(signOffResults({
      tenantId,
      signed_off_by: '33333333-3333-4333-8333-333333333333',
      signed_off_by_role: 'PATHOLOGIST',
      result_ids: [106],
      booking_id: 8,
      decision: 'verified',
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'LAB_SIGNOFF_BOOKING_MISMATCH',
      message: 'booking_id does not match the selected lab results',
    });

    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(3);
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
    expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
  });

  it('rejects a booking assertion for a mixed-booking selected batch', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([
      {
        id: 107,
        patient_uid: patientUid,
        booking_id: 7,
        investigation_id: 42,
      },
      {
        id: 108,
        patient_uid: patientUid,
        booking_id: 8,
        investigation_id: 43,
      },
    ]);

    await expect(signOffResults({
      tenantId,
      signed_off_by: '33333333-3333-4333-8333-333333333333',
      signed_off_by_role: 'PATHOLOGIST',
      result_ids: [107, 108],
      booking_id: 7,
      decision: 'verified',
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'LAB_SIGNOFF_MULTI_EPISODE_BATCH',
    });

    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
    expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
  });
});

describe('listLabWorklist STAT ordering (D45)', () => {
  const tenantId = '00000000-0000-4000-8000-000000000001';

  beforeEach(() => {
    queryRawUnsafeMock.mockReset();
    executeRawUnsafeMock.mockReset();
    emitCriticalLabAlertAcknowledgedMock.mockReset();
    acknowledgeTaskMock.mockReset();
    emitLabEventMock.mockReset();
    lockResultsInboxResourceTxMock.mockReset();
    queryRawUnsafeMock.mockResolvedValue([]);
    resolveCurrentHumanActorTxMock.mockReset();
    resolveCurrentHumanActorTxMock.mockImplementation(async ({
      actorUid,
      authenticatedRoles = [],
      authenticatedPrimaryRole = null,
      authenticatedRawRole = null,
    }) => {
      const role = authenticatedPrimaryRole || authenticatedRoles.find(Boolean);
      return {
        uid: String(actorUid).toLowerCase(),
        role,
        queueRole: role,
        rawRole: authenticatedRawRole || role,
      };
    });
  });

  it('orders STAT/URGENT bucket NEWEST-first within priority bucket', async () => {
    await listLabWorklist({ tenantId });
    const sql = queryRawUnsafeMock.mock.calls[0][0];
    // The STAT/URGENT branch sorts requested_at DESC so a fresh ER
    // STAT troponin lands above a stale never-cancelled STAT row from
    // a previous shift.
    expect(sql).toMatch(/IN \('STAT', 'URGENT'\)[\s\S]*requested_at\s*\n?\s*END DESC NULLS LAST/);
    // Non-STAT priority buckets keep oldest-first (fair FIFO) so
    // routine work still drains in arrival order.
    expect(sql).toMatch(/i\.requested_at ASC\s+LIMIT/);
    // Priority bucket ordering is preserved (STAT/URGENT = 1).
    expect(sql).toMatch(/WHEN 'STAT' THEN 1/);
    expect(sql).toMatch(/i\.tenant_id = \$1::uuid/);
    expect(sql).toMatch(/u\.tenant_id = \$1::uuid/);
    expect(sql).toMatch(/a\.tenant_id = \$1::uuid/);
    expect(sql).toMatch(/ev\.tenant_id = \$1::uuid/);
    expect(queryRawUnsafeMock.mock.calls[0].slice(1)).toEqual([tenantId, 100]);
  });

  it('scopes IPD worklist joins to the caller tenant', async () => {
    await listIpdLabWorklist({ tenantId, limit: 25 });

    const [sql, boundTenant, boundLimit] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toMatch(/i\.tenant_id = \$1::uuid/);
    expect(sql).toMatch(/u\.tenant_id = \$1::uuid/);
    expect(sql).toMatch(/a\.tenant_id = \$1::uuid/);
    expect(sql).toMatch(/b\.tenant_id = \$1::uuid/);
    expect(boundTenant).toBe(tenantId);
    expect(boundLimit).toBe(25);
  });

  it('locks the tenant-matched alert/result/task/SLA and delegates acknowledgement authority', async () => {
    const actorUid = '33333333-3333-4333-8333-333333333333';
    const patientUid = '5e89c1aa-df0c-4d19-9e7e-40af85486f24';
    const alert = {
      id: 7,
      tenant_id: tenantId,
      result_id: 37,
      patient_uid: patientUid,
      investigation_id: 91,
      acknowledged_at: null,
      acknowledgement_task_id: 82,
      generation_signoff_id: null,
      test_name: 'Troponin I',
      fired_at: new Date('2026-07-19T03:00:00.000Z'),
    };
    const linkedTask = { id: 82, status: 'open', workflow_sla_instance_id: 'sla-82' };
    const acknowledgedTask = {
      ...linkedTask,
      status: 'in_progress',
      metadata: {
        acknowledged_at: '2026-07-19T04:00:00.000Z',
        acknowledged_via: 'assignee',
        ack_contract_version: 2,
      },
    };
    const acknowledgedAlert = {
      ...alert,
      acknowledged_at: new Date('2026-07-19T04:00:00.000Z'),
      acknowledged_by: actorUid,
      read_back_method: 'phone',
    };
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ result_id: 37 }])
      .mockResolvedValueOnce([alert])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([linkedTask])
      .mockResolvedValueOnce([{
        id: 'sla-82', status: 'active', completed_at: null, metadata: {},
      }])
      .mockResolvedValueOnce([acknowledgedAlert])
      .mockResolvedValueOnce([{ recorded: true }]);
    acknowledgeTaskMock.mockResolvedValueOnce(acknowledgedTask);
    emitCriticalLabAlertAcknowledgedMock.mockResolvedValueOnce({ id: 'timeline-1' });

    const result = await acknowledgeAlert(7, {
      tenantId,
      acknowledged_by: actorUid,
      acknowledged_by_name: 'Dr Assignee',
      actorRoles: ['DOCTOR'],
      actorRole: 'DOCTOR',
      breakGlassId: 44,
      read_back_method: 'phone',
    });

    expect(result).toEqual(acknowledgedAlert);
    const pointerLookup = queryRawUnsafeMock.mock.calls[0];
    expect(pointerLookup[0]).toMatch(/SELECT result_id[\s\S]*FROM lab_critical_alerts[\s\S]*tenant_id = \$2::uuid/i);
    expect(pointerLookup.slice(1)).toEqual([7, tenantId]);

    const alertLock = queryRawUnsafeMock.mock.calls[1];
    expect(alertLock[0]).toMatch(/FROM lab_critical_alerts AS alert[\s\S]*JOIN lab_results AS result[\s\S]*result\.tenant_id = alert\.tenant_id[\s\S]*alert\.tenant_id = \$2::uuid[\s\S]*FOR UPDATE OF alert/i);
    expect(alertLock.slice(1)).toEqual([7, tenantId]);

    const latestSignoffLookup = queryRawUnsafeMock.mock.calls[2];
    expect(latestSignoffLookup[0]).toMatch(/FROM lab_pathologist_signoffs[\s\S]*decision IN \('corrected', 'amended'\)/i);
    expect(latestSignoffLookup.slice(1)).toEqual([tenantId, patientUid, 37]);

    const taskLock = queryRawUnsafeMock.mock.calls[3];
    expect(taskLock[0]).toMatch(/FROM tasks AS task[\s\S]*task\.related_resource_type = 'lab_result'[\s\S]*task\.related_resource_id = \$2::text[\s\S]*task\.patient_uid = \$3::uuid[\s\S]*task\.sla_completion_semantics = 'acknowledgement'[\s\S]*NOT EXISTS[\s\S]*newer_alert\.id > \$4::int[\s\S]*newer_signoff\.decision IN \('corrected', 'amended'\)[\s\S]*newer_signoff\.signed_at > \$5::timestamptz[\s\S]*FOR UPDATE OF task/i);
    expect(taskLock[0]).not.toMatch(/JOIN workflow_sla_instances/i);
    expect(taskLock.slice(1)).toEqual([
      tenantId,
      '37',
      patientUid,
      7,
      alert.fired_at,
      82,
    ]);
    expect(lockResultsInboxResourceTxMock).toHaveBeenCalledWith({
      tx: __prismaDefaultMock,
      tenantId,
      resourceType: 'lab_result',
      resourceId: '37',
    });

    const slaLock = queryRawUnsafeMock.mock.calls[4];
    expect(slaLock[0]).toMatch(/FROM workflow_sla_instances AS sla[\s\S]*sla\.id = \$2::uuid[\s\S]*sla\.rule_code = 'critical_result_ack'[\s\S]*sla\.source_table = 'lab_result'[\s\S]*sla\.source_id = \$3::text[\s\S]*FOR UPDATE OF sla/i);
    expect(slaLock.slice(1)).toEqual([tenantId, 'sla-82', '37']);
    expect(taskLock[0]).not.toMatch(/FOR UPDATE OF task, sla/i);
    expect(acknowledgeTaskMock).toHaveBeenCalledWith({
      tenantId,
      id: 82,
      alertId: 7,
      resultId: 37,
      patientUid,
      actorUid,
      actorRoles: ['DOCTOR'],
      actorPrimaryRole: 'DOCTOR',
      actorRawRole: 'DOCTOR',
      breakGlassId: 44,
      tx: __prismaDefaultMock,
    });

    const alertUpdate = queryRawUnsafeMock.mock.calls[5];
    expect(alertUpdate[0]).toMatch(/UPDATE lab_critical_alerts AS target_alert[\s\S]*target_alert\.id = \$5::int[\s\S]*target_alert\.tenant_id = \$6::uuid[\s\S]*target_alert\.acknowledged_at IS NULL[\s\S]*RETURNING target_alert\.id, target_alert\.tenant_id/i);
    expect(alertUpdate[0]).not.toMatch(/RETURNING \*/i);
    expect(alertUpdate[5]).toBe(7);
    expect(alertUpdate[6]).toBe(tenantId);
    expect(alertUpdate[7]).toBe(82);
    expect(alertUpdate[8]).toBe('2026-07-19T04:00:00.000Z');
    expect(emitCriticalLabAlertAcknowledgedMock).toHaveBeenCalledWith(expect.objectContaining({
      db: __prismaDefaultMock,
      alert: expect.objectContaining({
        ...alert,
        acknowledged_at: '2026-07-19T04:00:00.000Z',
        acknowledged_by: actorUid,
        acknowledged_by_name: 'Dr Assignee',
        read_back_method: 'phone',
      }),
      actorUid,
      actorRole: 'DOCTOR',
      payload: expect.objectContaining({ acknowledgement_authorization: 'assignee' }),
    }));
    expect(emitCriticalLabAlertAcknowledgedMock.mock.invocationCallOrder[0])
      .toBeLessThan(queryRawUnsafeMock.mock.invocationCallOrder[5]);
    expect(emitLabEventMock).toHaveBeenCalledWith('alert-acked', { tenantId });
    expect(emitCriticalLabAlertAcknowledgedMock.mock.invocationCallOrder[0])
      .toBeLessThan(emitLabEventMock.mock.invocationCallOrder[0]);
  });

  it('revalidates the current actor before direct alert replay or PHI read', async () => {
    resolveCurrentHumanActorTxMock.mockRejectedValueOnce(AppError.forbidden(
      'Current actor is inactive',
      'CURRENT_HUMAN_ACTOR_FORBIDDEN',
    ));
    queryRawUnsafeMock.mockResolvedValueOnce([{
      result_id: 37,
      patient_uid: '5e89c1aa-df0c-4d19-9e7e-40af85486f24',
    }]);

    await expect(acknowledgeAlert(7, {
      tenantId,
      acknowledged_by: '33333333-3333-4333-8333-333333333333',
      actorRoles: ['DOCTOR'],
      actorRole: 'DOCTOR',
      actorRawRole: 'DOCTOR',
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'CURRENT_HUMAN_ACTOR_FORBIDDEN',
    });

    expect(resolveCurrentHumanActorTxMock).toHaveBeenCalledTimes(1);
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
    expect(acknowledgeTaskMock).not.toHaveBeenCalled();
    expect(emitCriticalLabAlertAcknowledgedMock).not.toHaveBeenCalled();
  });

  it('rejects an unacknowledged stale alert generation before task or SLA mutation', async () => {
    const actorUid = '33333333-3333-4333-8333-333333333333';
    const patientUid = '5e89c1aa-df0c-4d19-9e7e-40af85486f24';
    const alert = {
      id: 7,
      tenant_id: tenantId,
      result_id: 37,
      patient_uid: patientUid,
      acknowledged_at: null,
      generation_signoff_id: 6,
      fired_at: new Date('2026-07-19T03:00:00.000Z'),
    };
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ result_id: 37 }])
      .mockResolvedValueOnce([alert])
      .mockResolvedValueOnce([{ id: 8 }]);

    await expect(acknowledgeAlert(7, {
      tenantId,
      acknowledged_by: actorUid,
      actorRoles: ['DOCTOR'],
    })).rejects.toMatchObject({
      statusCode: 403,
      message: 'Not authorized to acknowledge this critical alert',
    });

    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(3);
    expect(queryRawUnsafeMock.mock.calls[2][0]).toMatch(
      /FROM lab_pathologist_signoffs[\s\S]*decision IN \('corrected', 'amended'\)/i,
    );
    expect(queryRawUnsafeMock.mock.calls[2].slice(1)).toEqual([tenantId, patientUid, 37]);
    expect(acknowledgeTaskMock).not.toHaveBeenCalled();
    expect(emitCriticalLabAlertAcknowledgedMock).not.toHaveBeenCalled();
    expect(emitLabEventMock).not.toHaveBeenCalled();
  });

  it('does not mutate the alert or emit evidence when task acknowledgement denies the caller', async () => {
    const actorUid = '33333333-3333-4333-8333-333333333333';
    const patientUid = '5e89c1aa-df0c-4d19-9e7e-40af85486f24';
    const alert = {
      id: 7,
      tenant_id: tenantId,
      result_id: 37,
      patient_uid: patientUid,
      acknowledged_at: null,
      acknowledgement_task_id: 82,
      fired_at: new Date('2026-07-19T03:00:00.000Z'),
    };
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ result_id: 37 }])
      .mockResolvedValueOnce([alert])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 82,
        status: 'open',
        workflow_sla_instance_id: 'sla-82',
      }])
      .mockResolvedValueOnce([{ id: 'sla-82' }]);
    acknowledgeTaskMock.mockRejectedValueOnce(AppError.forbidden('Not authorized to acknowledge this task'));

    await expect(acknowledgeAlert(7, {
      tenantId,
      acknowledged_by: actorUid,
      actorRoles: ['NURSE'],
    })).rejects.toMatchObject({
      statusCode: 403,
      message: 'Not authorized to acknowledge this critical alert',
    });

    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(5);
    expect(queryRawUnsafeMock.mock.calls.every(([sql]) => /^\s*SELECT/i.test(sql))).toBe(true);
    expect(emitCriticalLabAlertAcknowledgedMock).not.toHaveBeenCalled();
    expect(emitLabEventMock).not.toHaveBeenCalled();
  });

  it('requires reconciliation for an authorized replay of an acknowledged unbound alert', async () => {
    const actorUid = '33333333-3333-4333-8333-333333333333';
    const patientUid = '5e89c1aa-df0c-4d19-9e7e-40af85486f24';
    const alert = {
      id: 7,
      tenant_id: tenantId,
      result_id: 37,
      patient_uid: patientUid,
      acknowledged_at: new Date('2026-07-19T04:00:00.000Z'),
      acknowledged_by: actorUid,
    };
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ result_id: 37 }])
      .mockResolvedValueOnce([alert])
      .mockResolvedValueOnce([]);

    await expect(acknowledgeAlert(7, {
      tenantId,
      acknowledged_by: actorUid,
      actorRoles: ['DOCTOR'],
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'LAB_CRITICAL_ALERT_ACK_RECONCILIATION_REQUIRED',
      message: 'Critical alert acknowledgement requires reconciliation',
    });

    expect(acknowledgeTaskMock).not.toHaveBeenCalled();
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(3);
    expect(emitCriticalLabAlertAcknowledgedMock).not.toHaveBeenCalled();
    expect(emitLabEventMock).not.toHaveBeenCalled();
  });

  it('allows an administrator to replay an exact versioned closed acknowledgement contract', async () => {
    const acknowledgedAt = new Date('2026-07-19T04:00:00.000Z');
    const acknowledgedBy = '33333333-3333-4333-8333-333333333333';
    const alert = {
      id: 7,
      tenant_id: tenantId,
      result_id: 37,
      patient_uid: '5e89c1aa-df0c-4d19-9e7e-40af85486f24',
      acknowledged_at: acknowledgedAt,
      acknowledged_by: acknowledgedBy,
      read_back_method: null,
      acknowledgement_task_id: 82,
      generation_signoff_id: null,
      generation_metadata: { corrected_state: 'critical' },
    };
    const task = {
      id: 82,
      status: 'in_progress',
      workflow_sla_instance_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      metadata: {
        acknowledged_at: acknowledgedAt.toISOString(),
        acknowledged_by: acknowledgedBy,
        acknowledged_via: 'assignee',
        ack_contract_version: 2,
      },
    };
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ result_id: 37 }])
      .mockResolvedValueOnce([alert])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ recorded: true }])
      .mockResolvedValueOnce([task]);

    await expect(acknowledgeAlert(7, {
      tenantId,
      acknowledged_by: '44444444-4444-4444-8444-444444444444',
      actorRoles: ['ADMIN'],
    })).resolves.toEqual(alert);

    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(5);
    expect(queryRawUnsafeMock.mock.calls[3][0]).toMatch(
      /record_lab_critical_alert_acknowledgement_receipt/i,
    );
    expect(queryRawUnsafeMock.mock.calls[3].slice(1)).toEqual([tenantId, 7, 82]);
    expect(queryRawUnsafeMock.mock.calls[4][0]).toMatch(
      /FROM lab_critical_alert_acknowledgement_receipts AS receipt[\s\S]*receipt\.ack_contract_version = 2[\s\S]*FOR UPDATE OF task/i,
    );
    expect(acknowledgeTaskMock).not.toHaveBeenCalled();
    expect(emitCriticalLabAlertAcknowledgedMock).not.toHaveBeenCalled();
    expect(emitLabEventMock).not.toHaveBeenCalled();
  });

  it('requires reconciliation when any closed-contract version marker is absent or mismatched', async () => {
    const actorUid = '33333333-3333-4333-8333-333333333333';
    const alert = {
      id: 7,
      tenant_id: tenantId,
      result_id: 37,
      patient_uid: '5e89c1aa-df0c-4d19-9e7e-40af85486f24',
      acknowledged_at: new Date('2026-07-19T04:00:00.000Z'),
      acknowledged_by: actorUid,
      acknowledgement_task_id: 82,
      generation_signoff_id: null,
      generation_metadata: { corrected_state: 'critical' },
    };
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ result_id: 37 }])
      .mockResolvedValueOnce([alert])
      .mockResolvedValueOnce([])
      // The exact task query excludes unversioned/version-mismatched rows.
      .mockResolvedValueOnce([]);

    await expect(acknowledgeAlert(7, {
      tenantId,
      acknowledged_by: actorUid,
      actorRoles: ['DOCTOR'],
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'LAB_CRITICAL_ALERT_ACK_RECONCILIATION_REQUIRED',
    });

    expect(queryRawUnsafeMock.mock.calls.every(([sql]) => /^\s*SELECT/i.test(sql))).toBe(true);
    expect(acknowledgeTaskMock).not.toHaveBeenCalled();
    expect(emitCriticalLabAlertAcknowledgedMock).not.toHaveBeenCalled();
  });

  it('requires reconciliation when canonical closed-contract evidence is duplicated', async () => {
    const actorUid = '33333333-3333-4333-8333-333333333333';
    const acknowledgedAt = new Date('2026-07-19T04:00:00.000Z');
    const alert = {
      id: 7,
      tenant_id: tenantId,
      result_id: 37,
      patient_uid: '5e89c1aa-df0c-4d19-9e7e-40af85486f24',
      acknowledged_at: acknowledgedAt,
      acknowledged_by: actorUid,
      acknowledgement_task_id: 82,
      generation_signoff_id: null,
      generation_metadata: { corrected_state: 'critical' },
    };
    const task = {
      id: 82,
      status: 'in_progress',
      workflow_sla_instance_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      metadata: {
        acknowledged_at: acknowledgedAt.toISOString(),
        acknowledged_by: actorUid,
        acknowledged_via: 'assignee',
        ack_contract_version: 2,
      },
    };
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ result_id: 37 }])
      .mockResolvedValueOnce([alert])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([task])
      .mockResolvedValueOnce([{ id: task.workflow_sla_instance_id }])
      .mockResolvedValueOnce([{
        receipt_comment_count: 1,
        timeline_count: 1,
        audit_count: 2,
      }]);

    await expect(acknowledgeAlert(7, {
      tenantId,
      acknowledged_by: actorUid,
      actorRoles: ['DOCTOR'],
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'LAB_CRITICAL_ALERT_ACK_RECONCILIATION_REQUIRED',
    });

    expect(acknowledgeTaskMock).not.toHaveBeenCalled();
    expect(emitCriticalLabAlertAcknowledgedMock).not.toHaveBeenCalled();
  });

  it('returns a generic denial for an acknowledged-alert replay by any other actor', async () => {
    const alert = {
      id: 7,
      tenant_id: tenantId,
      result_id: 37,
      patient_uid: '5e89c1aa-df0c-4d19-9e7e-40af85486f24',
      acknowledged_at: new Date('2026-07-19T04:00:00.000Z'),
      acknowledged_by: '33333333-3333-4333-8333-333333333333',
    };
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ result_id: 37 }])
      .mockResolvedValueOnce([alert])
      .mockResolvedValueOnce([]);

    await expect(acknowledgeAlert(7, {
      tenantId,
      acknowledged_by: '44444444-4444-4444-8444-444444444444',
      actorRoles: ['DOCTOR'],
    })).rejects.toMatchObject({
      statusCode: 403,
      message: 'Not authorized to acknowledge this critical alert',
    });

    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(3);
    expect(acknowledgeTaskMock).not.toHaveBeenCalled();
    expect(emitCriticalLabAlertAcknowledgedMock).not.toHaveBeenCalled();
    expect(emitLabEventMock).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range alert id generically before querying', async () => {
    await expect(acknowledgeAlert(2_147_483_648, {
      tenantId,
      acknowledged_by: '33333333-3333-4333-8333-333333333333',
      actorRoles: ['DOCTOR'],
    })).rejects.toMatchObject({
      statusCode: 403,
      message: 'Not authorized to acknowledge this critical alert',
    });

    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
    expect(acknowledgeTaskMock).not.toHaveBeenCalled();
  });
});
