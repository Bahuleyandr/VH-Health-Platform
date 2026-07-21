import { jest } from '@jest/globals';

const updateMock = jest.fn();
const findUniqueMock = jest.fn();
const findFirstMock = jest.fn();
const findManyMock = jest.fn();
const countMock = jest.fn();
const queryRawMock = jest.fn();
const enqueueCriticalResultTaskMock = jest.fn();
const ensureCriticalResultTaskOpenMock = jest.fn();
const notificationQueueMock = jest.fn();
let transactionCommitted = false;
const setTenantTxMock = jest.fn(async (_tenantId, fn) => {
  const result = await fn(__prismaDefaultMock);
  transactionCommitted = true;
  return result;
});

const __prismaDefaultMock = {
  users: {
    findUnique: findUniqueMock,
  },
  investigations: {
    findMany: findManyMock,
    count: countMock,
    findUnique: findUniqueMock,
    findFirst: findFirstMock,
    update: updateMock,
  },
  $queryRawUnsafe: queryRawMock,
};
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: setTenantTxMock,
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
  isTenantTransactionClient: () => true,
}));

const recordCanonicalClinicalEventMock = jest.fn();
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: recordCanonicalClinicalEventMock,
  recordClinicalAuditEvent: jest.fn().mockResolvedValue(null),
  currentCanonicalTransactionRevision: jest.fn().mockResolvedValue(1),
}));

jest.unstable_mockModule('../../services/workflow/workflowHumanOwnerService.js', () => ({
  resolveCurrentHumanActorTx: jest.fn(async ({
    actorUid,
    authenticatedPrimaryRole,
    authenticatedRawRole,
  }) => ({
    uid: actorUid,
    role: authenticatedPrimaryRole,
    queueRole: authenticatedPrimaryRole,
    rawRole: authenticatedRawRole || authenticatedPrimaryRole,
  })),
}));

jest.unstable_mockModule('../../services/results/resultsInboxService.js', () => ({
  enqueueCriticalResultTask: enqueueCriticalResultTaskMock,
  ensureCriticalResultTaskOpen: ensureCriticalResultTaskOpenMock,
}));

jest.unstable_mockModule('../../utils/notifications/notificationOutbox.js', () => ({
  default: { queue: notificationQueueMock },
}));

const {
  getDoctorInvestigations,
  getInvestigations,
  getPatientInvestigations,
  getPendingInvestigations,
  addResults,
  updateStatus,
} = await import('../../services/investigation/investigationService.js');

const LAB_TECH_UID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-05-15T10:00:00.000Z');
const TENANT_ID = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(NOW);
  transactionCommitted = false;
  setTenantTxMock.mockClear();
  findUniqueMock.mockReset();
  findFirstMock.mockReset();
  findManyMock.mockReset();
  countMock.mockReset();
  queryRawMock.mockReset().mockResolvedValue([]);
  updateMock.mockReset();
  enqueueCriticalResultTaskMock.mockReset().mockResolvedValue({ created: true, taskId: 1 });
  ensureCriticalResultTaskOpenMock.mockReset().mockResolvedValue({ created: true, taskId: 2 });
  notificationQueueMock.mockReset().mockResolvedValue({ id: 9, status: 'PENDING' });
  recordCanonicalClinicalEventMock.mockReset().mockResolvedValue({
    timeline: { id: 'timeline-1' },
    audit: { id: 'audit-1' },
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('investigationService.updateStatus', () => {
  it('stamps collection audit fields when marking an investigation COLLECTED', async () => {
    findFirstMock.mockResolvedValue({ id: 20, patient_uid: '33333333-3333-4333-8333-333333333333', sample_barcode: null });
    updateMock.mockImplementation(async ({ data }) => ({
      id: 20,
      tenant_id: TENANT_ID,
      patient_uid: '33333333-3333-4333-8333-333333333333',
      test_name: 'CBC',
      test_type: 'LAB',
      ...data,
    }));

    const result = await updateStatus(
      20,
      'COLLECTED',
      'Collected urgent IPD sample',
      LAB_TECH_UID,
      TENANT_ID,
    );

    expect(updateMock).toHaveBeenCalledWith({
      where: { id: 20 },
      data: {
        status: 'COLLECTED',
        notes: 'Collected urgent IPD sample',
        collected_at: NOW,
        collected_by: LAB_TECH_UID,
        collected_notes: 'Collected urgent IPD sample',
        sample_barcode: expect.stringMatching(/^INV-K-/),
        sample_rejected_at: null,
        sample_rejected_by: null,
        sample_rejection_reason: null,
      },
      select: expect.objectContaining({
        id: true,
        status: true,
        collected_at: true,
        collected_by: true,
        collected_notes: true,
        sample_barcode: true,
      }),
    });
    expect(result.collected_at).toEqual(NOW);
    expect(result.collected_by).toBe(LAB_TECH_UID);
    expect(result.sample_barcode).toMatch(/^INV-K-/);
  });
});

describe('investigationService critical-result task routing', () => {
  const PATIENT_UID = '44444444-4444-4444-8444-444444444444';
  const ORDERING_UID = '55555555-5555-4555-8555-555555555555';
  const criticalResults = {
    analytes: [{ name: 'Potassium', value: '7.4', flag: 'PANIC' }],
  };
  const normalResults = {
    analytes: [{ name: 'Potassium', value: '4.2', flag: 'N' }],
  };

  function updatedInvestigation(version, {
    results = criticalResults,
    resultSummary = 'Potassium: 7.4 [PANIC]',
    patient = null,
  } = {}) {
    return {
      id: 51,
      patient_id: 7,
      patient_uid: PATIENT_UID,
      requested_by: ORDERING_UID,
      test_name: 'Serum Potassium',
      test_type: 'LAB',
      status: 'COMPLETED',
      results,
      interpretation: null,
      result_summary: resultSummary,
      completed_at: NOW,
      verified_at: NOW,
      verified_by: LAB_TECH_UID,
      updated_at: NOW,
      previous_results: null,
      result_version: version,
      users_investigations_patient_idTousers: patient,
    };
  }

  it('does not notify the patient when a generic investigation source has no release policy', async () => {
    findUniqueMock.mockResolvedValueOnce({
      id: 51,
      results: null,
      interpretation: null,
      status: 'COLLECTED',
      completed_at: null,
      previous_results: null,
      result_version: 1,
    });
    updateMock.mockResolvedValueOnce(updatedInvestigation(1, {
      results: normalResults,
      resultSummary: 'Potassium: 4.2',
      patient: { id: 7, name: 'Patient One', phone: '9876543210' },
    }));
    const result = await addResults(
      51,
      { results: normalResults },
      LAB_TECH_UID,
      TENANT_ID,
      'LAB_TECH',
    );

    expect(result).toMatchObject({ id: 51, status: 'COMPLETED' });
    expect(result).not.toHaveProperty('users_investigations_patient_idTousers');
    expect(notificationQueueMock).not.toHaveBeenCalled();
  });

  it('keeps a successful critical result and its task rails when post-commit notification enqueue fails', async () => {
    findUniqueMock.mockResolvedValueOnce({
      id: 51,
      results: null,
      interpretation: null,
      status: 'COLLECTED',
      completed_at: null,
      previous_results: null,
      result_version: 1,
    });
    updateMock.mockResolvedValueOnce(updatedInvestigation(1, {
      patient: { id: 7, name: 'Patient One', phone: '9876543210' },
    }));
    enqueueCriticalResultTaskMock.mockImplementationOnce(async () => {
      expect(transactionCommitted).toBe(false);
      return { created: true, taskId: 1 };
    });
    await expect(addResults(
      51,
      { results: criticalResults },
      LAB_TECH_UID,
      TENANT_ID,
      'LAB_TECH',
    )).resolves.toMatchObject({ id: 51, status: 'COMPLETED' });

    expect(transactionCommitted).toBe(true);
    expect(recordCanonicalClinicalEventMock).toHaveBeenCalledTimes(1);
    expect(enqueueCriticalResultTaskMock).toHaveBeenCalledTimes(1);
    expect(notificationQueueMock).not.toHaveBeenCalled();
  });

  it('uses plain enqueue only for the initial critical result', async () => {
    findUniqueMock.mockResolvedValueOnce({
      id: 51,
      results: null,
      interpretation: null,
      status: 'COLLECTED',
      completed_at: null,
      previous_results: null,
      result_version: 1,
    });
    updateMock.mockResolvedValueOnce(updatedInvestigation(1));

    enqueueCriticalResultTaskMock.mockImplementationOnce(async () => {
      expect(transactionCommitted).toBe(false);
      return { created: true, taskId: 1 };
    });

    await addResults(51, { results: criticalResults }, LAB_TECH_UID, TENANT_ID, 'LAB_TECH');

    expect(enqueueCriticalResultTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      resourceType: 'investigations',
      resourceId: 51,
      tx: __prismaDefaultMock,
      strict: true,
    }));
    expect(ensureCriticalResultTaskOpenMock).not.toHaveBeenCalled();
  });

  it('routes an explicit critical re-run through the reopen helper with a fixed audit reason', async () => {
    findUniqueMock.mockResolvedValueOnce({
      id: 51,
      results: criticalResults,
      interpretation: null,
      status: 'COMPLETED',
      completed_at: NOW,
      previous_results: null,
      result_version: 1,
    });
    updateMock.mockResolvedValueOnce(updatedInvestigation(2));

    ensureCriticalResultTaskOpenMock.mockImplementationOnce(async () => {
      expect(transactionCommitted).toBe(false);
      return { created: true, taskId: 2 };
    });

    await addResults(51, {
      results: criticalResults,
      re_run: true,
      re_run_reason: 'Analyzer rerun confirmed panic value',
    }, LAB_TECH_UID, TENANT_ID, 'LAB_TECH');

    expect(ensureCriticalResultTaskOpenMock).toHaveBeenCalledWith(expect.objectContaining({
      resourceType: 'investigations',
      resourceId: 51,
      reason: 'investigation_result_rerun',
      supersededByActorUid: LAB_TECH_UID,
      severity: 'critical',
      title: 'Critical result: Serum Potassium',
      tx: __prismaDefaultMock,
      strict: true,
    }));
    expect(enqueueCriticalResultTaskMock).not.toHaveBeenCalled();
  });

  it('does not create, reopen, or close critical rails when a correction is currently normal', async () => {
    findUniqueMock.mockResolvedValueOnce({
      id: 51,
      results: criticalResults,
      interpretation: null,
      status: 'COMPLETED',
      completed_at: NOW,
      previous_results: null,
      result_version: 1,
    });
    updateMock.mockResolvedValueOnce(updatedInvestigation(2, {
      results: normalResults,
      resultSummary: 'Potassium: 4.2',
    }));

    await addResults(51, {
      results: normalResults,
      re_run: true,
      re_run_reason: 'Corrected analyzer calibration result',
    }, LAB_TECH_UID, TENANT_ID, 'LAB_TECH');

    expect(recordCanonicalClinicalEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'investigation.result_recorded',
        payload: expect.objectContaining({ critical: false }),
      }),
      { db: __prismaDefaultMock },
    );
    expect(ensureCriticalResultTaskOpenMock).not.toHaveBeenCalled();
    expect(enqueueCriticalResultTaskMock).not.toHaveBeenCalled();
  });

  it('does not materialize critical-result rails when the investigation transaction rolls back', async () => {
    findUniqueMock.mockResolvedValueOnce({
      id: 51,
      results: null,
      interpretation: null,
      status: 'COLLECTED',
      completed_at: null,
      previous_results: null,
      result_version: 1,
    });
    updateMock.mockResolvedValueOnce(updatedInvestigation(1));
    recordCanonicalClinicalEventMock.mockRejectedValueOnce(new Error('forced outer transaction failure'));

    await expect(addResults(
      51,
      { results: criticalResults },
      LAB_TECH_UID,
      TENANT_ID,
      'LAB_TECH',
    )).rejects.toThrow('forced outer transaction failure');

    expect(transactionCommitted).toBe(false);
    expect(enqueueCriticalResultTaskMock).not.toHaveBeenCalled();
    expect(ensureCriticalResultTaskOpenMock).not.toHaveBeenCalled();
    expect(notificationQueueMock).not.toHaveBeenCalled();
  });

  it('rolls back the result and canonical event when strict task materialization fails', async () => {
    findUniqueMock.mockResolvedValueOnce({
      id: 51,
      results: null,
      interpretation: null,
      status: 'COLLECTED',
      completed_at: null,
      previous_results: null,
      result_version: 1,
    });
    updateMock.mockResolvedValueOnce(updatedInvestigation(1));
    enqueueCriticalResultTaskMock.mockRejectedValueOnce(new Error('forced strict producer failure'));

    await expect(addResults(
      51,
      { results: criticalResults },
      LAB_TECH_UID,
      TENANT_ID,
      'LAB_TECH',
    )).rejects.toThrow('forced strict producer failure');

    expect(transactionCommitted).toBe(false);
    expect(recordCanonicalClinicalEventMock).toHaveBeenCalledTimes(1);
    expect(enqueueCriticalResultTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      tx: __prismaDefaultMock,
      strict: true,
    }));
    expect(notificationQueueMock).not.toHaveBeenCalled();
  });
});

describe('investigationService pending worklists', () => {
  it('treats PENDING as a queue alias for REQUESTED and legacy PENDING rows', async () => {
    findManyMock.mockResolvedValueOnce([]);

    const result = await getPendingInvestigations({});

    expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        status: { in: ['REQUESTED', 'PENDING'] },
      },
    }));
    expect(result.count).toBe(0);
  });

  it('uses the same PENDING alias for doctor-scoped investigation queues', async () => {
    const doctorUid = '22222222-2222-4222-8222-222222222222';
    findUniqueMock.mockResolvedValueOnce({ uid: doctorUid });
    findManyMock.mockResolvedValueOnce([]);

    const result = await getDoctorInvestigations(99, { status: 'PENDING' });

    expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        requested_by: doctorUid,
        status: { in: ['REQUESTED', 'PENDING'] },
      },
    }));
    expect(result.count).toBe(0);
  });

  it('uses the same PENDING alias for patient-scoped investigation queues', async () => {
    findManyMock.mockResolvedValueOnce([]);
    findUniqueMock.mockResolvedValueOnce({ name: 'Patient', birthday: null, gender: null });

    const result = await getPatientInvestigations(
      77,
      { status: 'PENDING', limit: 50 },
      'DOCTOR',
      'doctor-uid'
    );

    expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        patient_id: 77,
        status: { in: ['REQUESTED', 'PENDING'] },
      },
    }));
    expect(result.count).toBe(0);
  });

  it('adds patient display fields to patient-scoped investigation rows', async () => {
    findManyMock.mockResolvedValueOnce([
      {
        id: 81,
        test_name: 'ECG',
        test_type: 'CARDIOLOGY',
        status: 'REQUESTED',
        requested_by: '22222222-2222-4222-8222-222222222222',
        users_investigations_requested_byTousers: {
          id: 99,
          uid: '22222222-2222-4222-8222-222222222222',
          name: 'Test Doctor',
          role: 'DOCTOR',
          doctors: [{ id: 11, specialty: 'Cardiology' }],
        },
      },
    ]);
    findUniqueMock.mockResolvedValueOnce({
      name: 'OP Doctor Flow Test',
      phone: '+911234567890',
      birthday: null,
      gender: null,
    });

    const result = await getPatientInvestigations(
      77,
      { status: 'PENDING', limit: 50 },
      'DOCTOR',
      'doctor-uid'
    );

    expect(result.investigations[0]).toEqual(expect.objectContaining({
      test_name: 'ECG',
      patient_name: 'OP Doctor Flow Test',
      patient_phone: '+911234567890',
      requested_by_name: 'Test Doctor',
      doctor_name: 'Test Doctor',
      specialization: 'Cardiology',
    }));
  });
});

describe('investigationService requester provenance', () => {
  it('does not flatten an admin requester as the ordering doctor', async () => {
    const requestedBy = '33333333-3333-4333-8333-333333333333';
    findManyMock.mockResolvedValueOnce([
      {
        id: 44,
        test_name: 'CBC',
        requested_by: requestedBy,
        users_investigations_patient_idTousers: {
          id: 7,
          name: 'Lab Patient',
          phone: '+919000000044',
        },
        users_investigations_requested_byTousers: {
          id: 9,
          uid: requestedBy,
          name: 'Admin Requester',
          role: 'ADMIN',
          phone: '+919000000009',
          doctors: [],
        },
      },
    ]);
    countMock.mockResolvedValueOnce(1);

    const result = await getInvestigations(1, 20, {}, 'ADMIN', 'admin-uid');

    expect(result.investigations[0]).toEqual(expect.objectContaining({
      requested_by_name: 'Admin Requester',
      requested_by_uid: requestedBy,
      requested_by_role: 'ADMIN',
      doctor_name: null,
      doctor_id: null,
      doctor_phone: null,
    }));
  });
});
