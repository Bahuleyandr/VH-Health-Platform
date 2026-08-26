import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const executeRawUnsafeMock = jest.fn();
const referenceRangeFindManyMock = jest.fn();
const labResultCreateMock = jest.fn();
const auditCreateMock = jest.fn();
const recordCanonicalClinicalEventMock = jest.fn();
const sendStaffNotificationsMock = jest.fn();
const materializeLabCriticalAlertGenerationMock = jest.fn();
const evaluateCriticalThresholdMock = jest.fn();
const claimLabResultIngestCommandMock = jest.fn();
const completeLabResultIngestCommandMock = jest.fn();
const finaliseHttpIdempotencyInTxMock = jest.fn();

const tx = {
  $queryRawUnsafe: queryRawUnsafeMock,
  $executeRawUnsafe: executeRawUnsafeMock,
  lab_reference_ranges: { findMany: referenceRangeFindManyMock },
  lab_results: { create: labResultCreateMock },
  audit_logs: { create: auditCreateMock },
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    lab_reference_ranges: { findMany: referenceRangeFindManyMock },
  },
  setTenantTx: async (_tenantId, fn) => fn(tx),
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: recordCanonicalClinicalEventMock,
}));

jest.unstable_mockModule('../../services/emr/inpatientPathwayDomainService.js', () => ({
  linkPendingResultOwnerActionsForGenerationTx: jest.fn(),
  publishInpatientDiagnosticResourceLinkedTx: jest.fn(),
}));

jest.unstable_mockModule('../../services/notification/staffNotificationService.js', () => ({
  sendStaffNotifications: sendStaffNotificationsMock,
}));

jest.unstable_mockModule('../../services/lab/labCriticalAlertService.js', () => ({
  materializeLabCriticalAlertGeneration: materializeLabCriticalAlertGenerationMock,
}));

jest.unstable_mockModule('../../services/lab/labCriticalThresholdService.js', () => ({
  evaluateCriticalThreshold: evaluateCriticalThresholdMock,
}));

jest.unstable_mockModule('../../services/lab/labResultIngestCommandService.js', () => ({
  claimLabResultIngestCommand: claimLabResultIngestCommandMock,
  completeLabResultIngestCommand: completeLabResultIngestCommandMock,
  finaliseHttpIdempotencyInTx: finaliseHttpIdempotencyInTxMock,
}));

const { recordLabPanel } = await import('../../services/lab/labPanelService.js');

const TENANT = '11111111-1111-4111-8111-111111111111';
const PATIENT = '22222222-2222-4222-8222-222222222222';
const ACTOR = '33333333-3333-4333-8333-333333333333';
const ORDERING_CLINICIAN = '44444444-4444-4444-8444-444444444444';

function panelInput(overrides = {}) {
  return {
    tenantId: TENANT,
    panelCode: 'CBC',
    patientUid: PATIENT,
    bookingId: 71,
    performedByUid: ACTOR,
    performedByRole: 'LAB_TECHNICIAN',
    idempotencyKey: 'panel-command-1',
    requestBodySha256: 'a'.repeat(64),
    httpIdempotencyClaimId: 501,
    requestId: 'request-1',
    analytes: [{
      test_code: 'HGB',
      test_name: 'Haemoglobin',
      value_numeric: 13.2,
      value_text: '13.2',
      unit: 'g/dL',
    }],
    ...overrides,
  };
}

function sourceRow(overrides = {}) {
  return {
    booking_id: 71,
    booking_status: 'COLLECTED',
    investigation_id: 81,
    investigation_status: 'COLLECTED',
    ordering_clinician_uid: ORDERING_CLINICIAN,
    patient_uid: PATIENT,
    patient_name: 'Panel Patient',
    gender: 'female',
    birthday: new Date('1990-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function criticalRange(overrides = {}) {
  return {
    test_code: 'HGB',
    unit: 'g/dL',
    range_low: 12,
    range_high: 16,
    critical_low: 6,
    critical_high: 20,
    sex: null,
    age_band_min_y: null,
    age_band_max_y: null,
    ...overrides,
  };
}

function createdResult(overrides = {}) {
  return {
    id: 91,
    tenant_id: TENANT,
    booking_id: 71,
    investigation_id: 81,
    patient_uid: PATIENT,
    patient_name: 'Panel Patient',
    test_code: 'HGB',
    test_name: 'Haemoglobin',
    value_text: '13.2',
    value_numeric: 13.2,
    unit: 'g/dL',
    abnormal_flag: 'N',
    status: 'preliminary',
    is_critical: false,
    ingest_command_id: 601n,
    performed_at: new Date('2026-07-19T10:00:00.000Z'),
    ...overrides,
  };
}

function criticalInput(overrides = {}) {
  return panelInput({
    analytes: [{
      test_code: 'HGB',
      test_name: 'Haemoglobin',
      value_numeric: 24,
      value_text: '24',
      unit: 'g/dL',
    }],
    ...overrides,
  });
}

describe('recordLabPanel safety rails', () => {
  beforeEach(() => {
    queryRawUnsafeMock.mockReset();
    executeRawUnsafeMock.mockReset();
    referenceRangeFindManyMock.mockReset();
    labResultCreateMock.mockReset();
    auditCreateMock.mockReset();
    recordCanonicalClinicalEventMock.mockReset();
    sendStaffNotificationsMock.mockReset();
    materializeLabCriticalAlertGenerationMock.mockReset();
    evaluateCriticalThresholdMock.mockReset();
    claimLabResultIngestCommandMock.mockReset();
    completeLabResultIngestCommandMock.mockReset();
    finaliseHttpIdempotencyInTxMock.mockReset();
    recordCanonicalClinicalEventMock.mockResolvedValue({ timeline: { id: 1 }, audit: { id: 2 } });
    sendStaffNotificationsMock.mockResolvedValue({ sent: 1 });
    materializeLabCriticalAlertGenerationMock.mockImplementation(async ({ criticality }) => {
      const inserted = await labResultCreateMock.mock.results.at(-1)?.value;
      return {
        created: false,
        skippedReason: 'not_critical_without_alert_history',
        alert: null,
        task: null,
        state: criticality?.matched
          ? 'within_active_critical_thresholds'
          : 'threshold_unavailable',
        result: {
          ...inserted,
          is_critical: criticality?.breached === true,
        },
      };
    });
    evaluateCriticalThresholdMock.mockResolvedValue({
      matched: true,
      breached: false,
      breachedSide: null,
      breachedValue: null,
      evaluatedValue: 13.2,
      criticalLow: 6,
      criticalHigh: 20,
      thresholdUnit: 'g/dL',
    });
    auditCreateMock.mockResolvedValue({ id: 1 });
    claimLabResultIngestCommandMock.mockResolvedValue({
      replayed: false,
      command: { id: 601n },
    });
    completeLabResultIngestCommandMock.mockResolvedValue({ id: 601n, status: 'completed' });
    finaliseHttpIdempotencyInTxMock.mockResolvedValue({ id: 501 });
    executeRawUnsafeMock.mockResolvedValue(1);
  });

  it('rejects a missing, cross-tenant, incoherent, or conflicting source before any write', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    await expect(recordLabPanel(panelInput({ investigationId: 82 }))).rejects.toMatchObject({
      statusCode: 400,
      code: 'LAB_PANEL_SOURCE_MISMATCH',
    });

    expect(queryRawUnsafeMock.mock.calls[0][0]).toMatch(/investigation_bookings AS booking/);
    expect(queryRawUnsafeMock.mock.calls[0][0]).toMatch(
      /investigation\.patient_id IS NULL OR investigation\.patient_id = patient\.id/,
    );
    expect(queryRawUnsafeMock.mock.calls[0][0]).toMatch(/patient\.role = 'PATIENT'/);
    expect(queryRawUnsafeMock.mock.calls[0][0]).toMatch(/patient\.is_active = TRUE/);
    expect(queryRawUnsafeMock.mock.calls[0][0]).toMatch(/patient\.status = 'active'/);
    expect(queryRawUnsafeMock.mock.calls[0][0]).toMatch(/patient\.is_deleted = FALSE/);
    expect(queryRawUnsafeMock.mock.calls[0].slice(1)).toEqual([71, TENANT, 82]);
    expect(labResultCreateMock).not.toHaveBeenCalled();
    expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
    expect(materializeLabCriticalAlertGenerationMock).not.toHaveBeenCalled();
  });

  it('requires a real investigation or booking source before entering the transaction', async () => {
    await expect(recordLabPanel(panelInput({ bookingId: null }))).rejects.toMatchObject({
      statusCode: 400,
      code: 'LAB_PANEL_SOURCE_REQUIRED',
    });

    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
    expect(labResultCreateMock).not.toHaveBeenCalled();
  });

  it('rejects contradictory numeric and display values before any clinical write', async () => {
    await expect(recordLabPanel(panelInput({
      analytes: [{
        test_code: 'K',
        test_name: 'Potassium',
        value_numeric: 7.2,
        value_text: '4.2',
        unit: 'mmol/L',
      }],
    }))).rejects.toMatchObject({
      statusCode: 400,
      code: 'LAB_PANEL_VALUE_MISMATCH',
    });

    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
    expect(labResultCreateMock).not.toHaveBeenCalled();
    expect(materializeLabCriticalAlertGenerationMock).not.toHaveBeenCalled();
    expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
  });

  it('rejects duplicate case-normalized test or LOINC identities before any write', async () => {
    await expect(recordLabPanel(panelInput({
      analytes: [
        {
          test_code: ' hgb ',
          test_name: 'Haemoglobin',
          loinc_code: '718-7',
          value_numeric: 13.2,
        },
        {
          test_code: 'HGB',
          test_name: 'Haemoglobin duplicate',
          loinc_code: 'different',
          value_numeric: 13.3,
        },
      ],
    }))).rejects.toMatchObject({
      statusCode: 400,
      code: 'LAB_PANEL_DUPLICATE_ANALYTE',
    });

    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
    expect(labResultCreateMock).not.toHaveBeenCalled();
  });

  it('persists and owns a text-only analyte when no governed numeric policy can match', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([sourceRow()]);
    const result = createdResult({
      test_code: 'TROP',
      test_name: 'Troponin I',
      value_numeric: null,
      value_text: 'positive',
      unit: 'ng/L',
    });
    labResultCreateMock.mockResolvedValueOnce(result);
    const assessment = {
      matched: false,
      breached: false,
      criticalityStatus: 'threshold_unavailable',
      unmatchedReason: 'non_numeric_value',
    };
    evaluateCriticalThresholdMock.mockResolvedValueOnce(assessment);

    await expect(recordLabPanel(panelInput({
      analytes: [{
        test_code: 'TROP',
        test_name: 'Troponin I',
        value_text: 'positive',
        unit: 'ng/L',
      }],
    }))).resolves.toMatchObject({
      criticals_fired: 0,
      results: [expect.objectContaining({ test_code: 'TROP', value_text: 'positive' })],
    });

    expect(referenceRangeFindManyMock).not.toHaveBeenCalled();
    expect(materializeLabCriticalAlertGenerationMock).toHaveBeenCalledWith(expect.objectContaining({
      tx,
      tenantId: TENANT,
      resultId: result.id,
      criticality: assessment,
      source: 'lab_panel',
    }));
  });

  it('rejects when the asserted patient does not match the booking patient', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([
      sourceRow({ patient_uid: '55555555-5555-4555-8555-555555555555' }),
    ]);

    await expect(recordLabPanel(panelInput())).rejects.toMatchObject({
      statusCode: 400,
      code: 'LAB_PANEL_SOURCE_MISMATCH',
    });

    expect(labResultCreateMock).not.toHaveBeenCalled();
    expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
  });

  it('accepts an investigation-only order and derives the patient and ordering clinician from it', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([sourceRow({ booking_id: null })]);
    referenceRangeFindManyMock.mockResolvedValueOnce([criticalRange()]);
    labResultCreateMock.mockResolvedValueOnce(createdResult({ booking_id: null }));

    const recorded = await recordLabPanel(panelInput({ bookingId: null, investigationId: 81 }));

    expect(queryRawUnsafeMock.mock.calls[0][0]).toMatch(/FROM investigations AS investigation/);
    expect(queryRawUnsafeMock.mock.calls[0].slice(1)).toEqual([81, TENANT]);
    expect(labResultCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenant_id: TENANT,
        booking_id: null,
        investigation_id: 81,
        patient_uid: PATIENT,
      }),
    });
    expect(recorded.results[0]).toMatchObject({ booking_id: null, investigation_id: 81 });
  });

  it('derives result identity from the locked booking graph and records canonical evidence in-tx', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([sourceRow()]);
    referenceRangeFindManyMock.mockResolvedValueOnce([criticalRange()]);
    labResultCreateMock.mockResolvedValueOnce(createdResult());

    const recorded = await recordLabPanel(panelInput());

    expect(recorded.results).toHaveLength(1);
    expect(recorded.criticals_fired).toBe(0);
    expect(labResultCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenant_id: TENANT,
        booking_id: 71,
        investigation_id: 81,
        patient_uid: PATIENT,
        patient_name: 'Panel Patient',
        status: 'preliminary',
        performed_by_lab: 'manual_panel_entry',
        ingest_command_id: 601n,
      }),
    });
    expect(recorded.results[0]).not.toHaveProperty('ingest_command_id');
    expect(claimLabResultIngestCommandMock).toHaveBeenCalledWith({
      tx,
      tenantId: TENANT,
      actorUid: ACTOR,
      scope: 'panel_result',
      commandKey: 'panel-command-1',
      requestBodySha256: 'a'.repeat(64),
    });
    expect(recordCanonicalClinicalEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        patientUid: PATIENT,
        sourceTable: 'lab_results',
        sourceId: '91',
        resourceType: 'lab_result',
        eventType: 'lab.result_recorded',
        actorUid: ACTOR,
        actorRole: 'LAB_TECHNICIAN',
      }),
      { db: tx, strict: true },
    );
    expect(materializeLabCriticalAlertGenerationMock).toHaveBeenCalledWith(expect.objectContaining({
      tx,
      tenantId: TENANT,
      resultId: 91,
      expectedPatientUid: PATIENT,
      criticality: expect.objectContaining({ matched: true, breached: false }),
      source: 'lab_panel',
    }));
    expect(completeLabResultIngestCommandMock).toHaveBeenCalledWith({
      tx,
      tenantId: TENANT,
      commandId: 601n,
      resultIds: [91],
      panelId: recorded.panel_id,
      responseData: recorded,
    });
    expect(finaliseHttpIdempotencyInTxMock).toHaveBeenCalledWith({
      tx,
      claimId: 501,
      responseData: recorded,
      requestId: 'request-1',
    });
    expect(sendStaffNotificationsMock).not.toHaveBeenCalled();
  });

  it('replays the completed command response without touching the clinical source or rails', async () => {
    const responseData = {
      panel_id: '55555555-5555-4555-8555-555555555555',
      panel_code: 'CBC',
      results: [{ id: 91, status: 'preliminary' }],
      criticals_fired: 0,
    };
    claimLabResultIngestCommandMock.mockResolvedValueOnce({
      replayed: true,
      command: { id: 601n, response_data: responseData },
    });

    await expect(recordLabPanel(panelInput())).resolves.toEqual(responseData);

    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
    expect(labResultCreateMock).not.toHaveBeenCalled();
    expect(materializeLabCriticalAlertGenerationMock).not.toHaveBeenCalled();
    expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
    expect(auditCreateMock).not.toHaveBeenCalled();
    expect(completeLabResultIngestCommandMock).not.toHaveBeenCalled();
    expect(finaliseHttpIdempotencyInTxMock).toHaveBeenCalledWith({
      tx,
      claimId: 501,
      responseData,
      requestId: 'request-1',
    });
  });

  it.each(['final', 'corrected', 'cancelled'])('cannot bypass sign-off with panel status %s', async (status) => {
    queryRawUnsafeMock.mockResolvedValueOnce([sourceRow()]);
    referenceRangeFindManyMock.mockResolvedValueOnce([criticalRange()]);
    labResultCreateMock.mockResolvedValueOnce(createdResult());

    await recordLabPanel(panelInput({
      analytes: [{
        test_code: 'HGB',
        test_name: 'Haemoglobin',
        value_numeric: 13.2,
        value_text: '13.2',
        unit: 'g/dL',
        status,
      }],
    }));

    expect(labResultCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: 'preliminary' }),
    });
  });

  it('atomically delegates a critical result to the shared alert/task/SLA materializer', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([sourceRow()]);
    referenceRangeFindManyMock.mockResolvedValueOnce([criticalRange()]);
    labResultCreateMock.mockResolvedValueOnce(createdResult({
      value_text: '24',
      value_numeric: 24,
      abnormal_flag: 'HH',
    }));
    materializeLabCriticalAlertGenerationMock.mockResolvedValueOnce({
      created: true,
      alert: { id: 301 },
      task: {
        taskId: 401,
        slaInstanceId: '55555555-5555-4555-8555-555555555555',
        assignedToUid: ORDERING_CLINICIAN,
        assignedToRole: null,
      },
      state: 'critical',
      result: createdResult({
        value_text: '24',
        value_numeric: 24,
        abnormal_flag: 'HH',
        is_critical: true,
      }),
    });
    evaluateCriticalThresholdMock.mockResolvedValueOnce({
      matched: true,
      breached: true,
      breachedSide: 'high',
      breachedValue: 20,
      evaluatedValue: 24,
      criticalLow: 6,
      criticalHigh: 20,
      thresholdUnit: 'g/dL',
    });

    const recorded = await recordLabPanel(criticalInput());

    expect(labResultCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        patient_uid: PATIENT,
        booking_id: 71,
        investigation_id: 81,
        abnormal_flag: null,
        is_critical: false,
      }),
    });
    expect(materializeLabCriticalAlertGenerationMock).toHaveBeenCalledWith({
      tx,
      tenantId: TENANT,
      resultId: 91,
      expectedPatientUid: PATIENT,
      criticality: expect.objectContaining({
        matched: true,
        breached: true,
        breachedSide: 'high',
        breachedValue: 20,
      }),
      orderingClinicianUid: ORDERING_CLINICIAN,
      source: 'lab_panel',
    });
    expect(evaluateCriticalThresholdMock).toHaveBeenCalledWith({
      client: tx,
      tenantId: TENANT,
      result: expect.objectContaining({ id: 91, test_code: 'HGB' }),
    });
    expect(materializeLabCriticalAlertGenerationMock.mock.invocationCallOrder[0])
      .toBeLessThan(recordCanonicalClinicalEventMock.mock.invocationCallOrder[0]);
    expect(recordCanonicalClinicalEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        patientUid: PATIENT,
        afterState: { status: 'preliminary', is_critical: true },
      }),
      { db: tx, strict: true },
    );
    expect(sendStaffNotificationsMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      recipientUids: [ORDERING_CLINICIAN],
      recipientRoles: [],
      relatedId: 301,
      data: expect.objectContaining({ result_id: 91, alert_id: 301, patient_uid: PATIENT }),
    }));
    expect(recorded.criticals_fired).toBe(1);
    expect(recorded.results[0]).toMatchObject({ id: 91, is_critical: true });
  });

  it.each([
    { value: 6, flag: 'L', side: 'low' },
    { value: 20, flag: 'H', side: 'high' },
  ])('records the exact $side critical boundary as canonical noncritical evidence', async ({
    value,
    flag,
  }) => {
    queryRawUnsafeMock.mockResolvedValueOnce([sourceRow()]);
    referenceRangeFindManyMock.mockResolvedValueOnce([criticalRange()]);
    labResultCreateMock.mockResolvedValueOnce(createdResult({
      value_text: String(value),
      value_numeric: value,
      abnormal_flag: flag,
    }));
    evaluateCriticalThresholdMock.mockResolvedValueOnce({
      matched: true,
      breached: false,
      breachedSide: null,
      breachedValue: null,
      evaluatedValue: value,
      criticalLow: 6,
      criticalHigh: 20,
      thresholdUnit: 'g/dL',
    });
    materializeLabCriticalAlertGenerationMock.mockImplementationOnce(async (args) => {
      expect(args.criticality).toMatchObject({
        matched: true,
        breached: false,
        evaluatedValue: value,
      });
      return {
        created: false,
        skippedReason: 'not_critical_without_alert_history',
        alert: null,
        task: null,
        state: 'within_active_critical_thresholds',
        result: createdResult({
          value_text: String(value),
          value_numeric: value,
          abnormal_flag: flag,
          is_critical: false,
        }),
      };
    });

    const recorded = await recordLabPanel(panelInput({
      analytes: [{
        test_code: 'HGB',
        test_name: 'Haemoglobin',
        value_numeric: value,
        value_text: String(value),
        unit: 'g/dL',
      }],
    }));

    expect(recorded.criticals_fired).toBe(0);
    expect(recorded.results[0]).toMatchObject({ abnormal_flag: flag, is_critical: false });
    expect(recordCanonicalClinicalEventMock).toHaveBeenCalled();
    expect(auditCreateMock).toHaveBeenCalled();
    expect(sendStaffNotificationsMock).not.toHaveBeenCalled();
  });

  it('uses the materialized DUTY_DOCTOR fallback and does not roll back on notification failure', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([sourceRow({ ordering_clinician_uid: null })]);
    referenceRangeFindManyMock.mockResolvedValueOnce([criticalRange()]);
    labResultCreateMock.mockResolvedValueOnce(createdResult({
      value_text: '24',
      value_numeric: 24,
      abnormal_flag: 'HH',
    }));
    evaluateCriticalThresholdMock.mockResolvedValueOnce({
      matched: true,
      breached: true,
      breachedSide: 'high',
      breachedValue: 20,
      evaluatedValue: 24,
      criticalLow: 6,
      criticalHigh: 20,
      thresholdUnit: 'g/dL',
    });
    materializeLabCriticalAlertGenerationMock.mockResolvedValueOnce({
      created: true,
      alert: { id: 302 },
      task: {
        taskId: 402,
        slaInstanceId: '66666666-6666-4666-8666-666666666666',
        assignedToUid: null,
        assignedToRole: 'DUTY_DOCTOR',
      },
      state: 'critical',
      result: createdResult({
        value_text: '24',
        value_numeric: 24,
        abnormal_flag: 'HH',
        is_critical: true,
      }),
    });
    sendStaffNotificationsMock.mockRejectedValueOnce(new Error('notification transport down'));

    const recorded = await recordLabPanel(criticalInput());

    expect(materializeLabCriticalAlertGenerationMock).toHaveBeenCalledWith(expect.objectContaining({
      orderingClinicianUid: null,
    }));
    expect(sendStaffNotificationsMock).toHaveBeenCalledWith(expect.objectContaining({
      recipientUids: [],
      recipientRoles: ['DUTY_DOCTOR'],
    }));
    expect(recorded.criticals_fired).toBe(1);
  });

  it('bubbles materialization failure inside the tenant transaction and never notifies', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([sourceRow()]);
    referenceRangeFindManyMock.mockResolvedValueOnce([criticalRange()]);
    labResultCreateMock.mockResolvedValueOnce(createdResult({
      value_text: '24',
      value_numeric: 24,
      abnormal_flag: 'HH',
    }));
    evaluateCriticalThresholdMock.mockResolvedValueOnce({
      matched: true,
      breached: true,
      breachedSide: 'high',
      breachedValue: 20,
      evaluatedValue: 24,
      criticalLow: 6,
      criticalHigh: 20,
      thresholdUnit: 'g/dL',
    });
    materializeLabCriticalAlertGenerationMock.mockRejectedValueOnce(
      new Error('critical task/SLA materialization failed'),
    );

    await expect(recordLabPanel(criticalInput()))
      .rejects.toThrow('critical task/SLA materialization failed');

    expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
    expect(auditCreateMock).not.toHaveBeenCalled();
    expect(sendStaffNotificationsMock).not.toHaveBeenCalled();
  });
});
