import { jest } from '@jest/globals';

const notificationQueue = jest.fn();
const startWorkflowSla = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: jest.fn() },
  setTenantTx: jest.fn(),
}));
jest.unstable_mockModule('../../utils/notifications/notificationOutbox.js', () => ({
  notificationOutbox: { queue: notificationQueue },
}));
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: jest.fn(),
  startWorkflowSla,
}));

const { openMarMedicationExceptionTx } = await import(
  '../../services/clinical/marMedicationExceptionService.js'
);

const IDS = Object.freeze({
  actor: '10000000-0000-4000-8000-000000000001',
  patient: '10000000-0000-4000-8000-000000000002',
  tenant: '10000000-0000-4000-8000-000000000003',
  prescriber: '10000000-0000-4000-8000-000000000004',
  encounter: '10000000-0000-4000-8000-000000000005',
  sla: '10000000-0000-4000-8000-000000000006',
});

function createTx({ prescriber = null, clinicalOrderId = 91 } = {}) {
  const query = jest.fn(async (sql) => {
    if (sql.includes('FROM medication_administrations administration')) {
      return [{
        id: 42,
        patient_uid: IDS.patient,
        clinical_order_id: clinicalOrderId,
        status: 'missed',
        medication_name: 'Test medicine',
        scheduled_time: new Date('2026-08-28T00:00:00.000Z'),
        encounter_id: IDS.encounter,
        ordered_by: IDS.prescriber,
        clinical_order_status: 'verified',
        actor_role: 'NURSING_STAFF',
      }];
    }
    if (sql.includes('FROM mar_medication_exception_cases')) return [];
    if (sql.includes('nextval(')) return [{ id: 73n }];
    if (sql.includes('FROM users staff_member')) return prescriber ? [prescriber] : [];
    if (sql.includes('INSERT INTO mar_medication_exception_cases')) {
      return [{
        id: 73n,
        tenant_id: IDS.tenant,
        medication_administration_id: 42,
        patient_uid: IDS.patient,
        task_id: 41,
        workflow_sla_instance_id: IDS.sla,
        status: 'open',
      }];
    }
    if (sql.includes('INSERT INTO mar_medication_exception_events')) {
      return [{ id: 74n, occurred_at: new Date('2026-08-28T00:01:00.000Z') }];
    }
    throw new Error(`Unexpected SQL: ${sql.slice(0, 120)}`);
  });
  return {
    $queryRawUnsafe: query,
    $executeRawUnsafe: jest.fn().mockResolvedValue(1),
  };
}

function input(createTaskTx) {
  return {
    tenantId: IDS.tenant,
    medicationAdministrationId: 42,
    exceptionKind: 'missed',
    reason: 'Patient declined after counselling',
    raisedBy: IDS.actor,
    commandKey: 'mar-miss:42:test',
    requestFingerprint: 'a'.repeat(64),
    raisedAt: new Date('2026-08-28T00:01:00.000Z'),
    createTaskTx,
  };
}

beforeEach(() => {
  notificationQueue.mockReset();
  startWorkflowSla.mockReset().mockResolvedValue({ id: IDS.sla });
});

describe('opening a MAR medication exception', () => {
  test('materializes an explicit coverage gap without inventing a recipient', async () => {
    const tx = createTx();
    const createTaskTx = jest.fn().mockResolvedValue({ id: 41 });

    const result = await openMarMedicationExceptionTx(tx, input(createTaskTx));

    expect(result.notification_coverage_status).toBe('coverage_gap');
    expect(notificationQueue).not.toHaveBeenCalled();
    expect(createTaskTx).toHaveBeenCalledWith(expect.objectContaining({
      assignedToUid: null,
      assignedToRole: 'DOCTOR',
      createdBy: IDS.actor,
      workflowSlaInstanceId: IDS.sla,
      metadata: expect.objectContaining({
        exception_kind: 'missed',
        medication_administration_id: 42,
        evidence_kind: 'mar_medication_exception_resolution',
        deep_link: '/mar/due?exception_id=73',
      }),
      tx,
    }));
    expect(tx.$executeRawUnsafe.mock.calls.some(([sql]) => (
      sql.includes("notification_coverage_status = 'coverage_gap'")
    ))).toBe(true);
    expect(tx.$executeRawUnsafe.mock.calls.some(([sql]) => (
      sql.includes("'notification_coverage_gap'")
    ))).toBe(true);
  });

  test('persists a targeted notification intent when the original prescriber is active', async () => {
    const recipient = {
      id: 17,
      uid: IDS.prescriber,
      phone: '+919999999999',
      role: 'DOCTOR',
    };
    const tx = createTx({ prescriber: recipient });
    const createTaskTx = jest.fn().mockResolvedValue({ id: 41 });
    notificationQueue.mockResolvedValue({ id: 81 });

    const result = await openMarMedicationExceptionTx(tx, input(createTaskTx));

    expect(result.notification_coverage_status).toBe('notified');
    expect(notificationQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: IDS.tenant,
        recipientId: recipient.id,
        type: 'mar_medication_exception',
        data: expect.objectContaining({
          exception_case_id: '73',
          medication_administration_id: 42,
          deep_link: '/mar/due?exception_id=73',
        }),
      }),
      { tx, strict: true },
    );
    expect(createTaskTx).toHaveBeenCalledWith(expect.objectContaining({
      assignedToUid: IDS.prescriber,
      assignedToRole: null,
    }));
  });

  test('fails closed before any task when the MAR row has no clinical-order identity', async () => {
    const tx = createTx({ clinicalOrderId: null });
    const createTaskTx = jest.fn();

    await expect(openMarMedicationExceptionTx(tx, input(createTaskTx)))
      .rejects.toMatchObject({ code: 'MAR_EXCEPTION_ORDER_CONTEXT_REQUIRED' });
    expect(createTaskTx).not.toHaveBeenCalled();
    expect(startWorkflowSla).not.toHaveBeenCalled();
  });
});
