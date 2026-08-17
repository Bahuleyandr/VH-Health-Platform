import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const recordCanonicalClinicalEventMock = jest.fn();
const completeWorkflowSlaMock = jest.fn();

const prismaMock = { $queryRawUnsafe: queryRawUnsafeMock };
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  cancelWorkflowSla: jest.fn(),
  completeWorkflowSla: completeWorkflowSlaMock,
  isSchemaMissing: jest.fn(() => false),
  recordCanonicalClinicalEvent: recordCanonicalClinicalEventMock,
  startWorkflowSla: jest.fn(),
}));

const { emitCriticalLabAlertAcknowledged } = await import(
  '../../services/clinical/canonicalOperationalBridgeService.js'
);

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = '5e89c1aa-df0c-4d19-9e7e-40af85486f24';
const ACTOR_UID = '33333333-3333-4333-8333-333333333333';
const ACKNOWLEDGED_AT = '2026-07-19T06:00:00.123Z';

describe('critical-lab canonical acknowledgement bridge', () => {
  beforeEach(() => {
    queryRawUnsafeMock.mockReset();
    recordCanonicalClinicalEventMock.mockReset();
    completeWorkflowSlaMock.mockReset();
  });

  it('writes tenant-scoped canonical evidence without mutating any task or SLA', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{
      investigation_id: 91,
      patient_uid: PATIENT_UID,
      test_name: 'Troponin I',
      tenant_id: TENANT_ID,
    }]);
    const canonicalResult = { timeline: { id: 'timeline-1' }, audit: { id: 'audit-1' } };
    recordCanonicalClinicalEventMock.mockResolvedValueOnce(canonicalResult);

    const result = await emitCriticalLabAlertAcknowledged({
      db: prismaMock,
      alert: {
        id: 7,
        tenant_id: TENANT_ID,
        result_id: 37,
        patient_uid: PATIENT_UID,
        test_name: 'Troponin I',
        read_back_method: 'phone',
        acknowledged_at: ACKNOWLEDGED_AT,
      },
      actorUid: ACTOR_UID,
      actorRole: 'DOCTOR',
      payload: {
        acknowledgement_authorization: 'assignee',
        ack_contract_version: 2,
      },
    });

    expect(result).toEqual(canonicalResult);
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
    const linkedResultLookup = queryRawUnsafeMock.mock.calls[0];
    expect(linkedResultLookup[0]).toMatch(/WHERE lr\.id = \$1::int[\s\S]*lr\.tenant_id = \$2::uuid/i);
    expect(linkedResultLookup.slice(1)).toEqual([37, TENANT_ID]);
    expect(recordCanonicalClinicalEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        patientUid: PATIENT_UID,
        eventType: 'critical_result.acknowledged',
        sourceTable: 'lab_critical_alerts',
        sourceId: '7',
        actorUid: ACTOR_UID,
        actorRole: 'DOCTOR',
        occurredAt: ACKNOWLEDGED_AT,
        metadata: { ack_contract_version: 2 },
        afterState: {
          ack_contract_version: 2,
          acknowledged_at: ACKNOWLEDGED_AT,
          acknowledged_by: ACTOR_UID,
          read_back_method: 'phone',
        },
        payload: expect.objectContaining({
          result_id: 37,
          investigation_id: 91,
          acknowledgement_authorization: 'assignee',
          ack_contract_version: 2,
        }),
      }),
      { db: prismaMock, strict: true },
    );
    expect(completeWorkflowSlaMock).not.toHaveBeenCalled();
  });

  it('propagates canonical failure when called inside the acknowledgement transaction', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{
      investigation_id: 91,
      patient_uid: PATIENT_UID,
      test_name: 'Troponin I',
      tenant_id: TENANT_ID,
    }]);
    recordCanonicalClinicalEventMock.mockRejectedValueOnce(new Error('canonical write failed'));

    await expect(emitCriticalLabAlertAcknowledged({
      db: prismaMock,
      alert: {
        id: 7,
        tenant_id: TENANT_ID,
        result_id: 37,
        patient_uid: PATIENT_UID,
      },
      actorUid: ACTOR_UID,
      actorRole: 'DOCTOR',
    })).rejects.toThrow('canonical write failed');

    expect(completeWorkflowSlaMock).not.toHaveBeenCalled();
  });
});
