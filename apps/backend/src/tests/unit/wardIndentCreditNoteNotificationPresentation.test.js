import { jest } from '@jest/globals';

const notificationQueueMock = jest.fn();
const startWorkflowSlaMock = jest.fn();
const createTaskMock = jest.fn();
const postTaskCommentMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  setTenantTx: jest.fn(),
}));
jest.unstable_mockModule('../../utils/notifications/notificationOutbox.js', () => ({
  notificationOutbox: { queue: notificationQueueMock },
}));
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  startWorkflowSla: startWorkflowSlaMock,
}));
jest.unstable_mockModule('../../services/workflow/taskService.js', () => ({
  completeTaskFromDomainEvidence: jest.fn(),
  createWardMedicationObligationTaskTx: createTaskMock,
  postTaskComment: postTaskCommentMock,
}));

const {
  advanceBillingCreditNoteRefundObligationTx,
  materializeBillingCreditNoteObligationTx,
} = await import('../../services/ipd/wardIndentObligationService.js');

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const ACTOR_UID = '10000000-0000-4000-8000-000000000002';
const ACTION_LABEL_KEY = 'med03.credit_note.notification_action';

function creditNote(overrides = {}) {
  return {
    id: 81n,
    tenant_id: TENANT_ID,
    status: 'pending',
    patient_uid: '10000000-0000-4000-8000-000000000003',
    encounter_id: '10000000-0000-4000-8000-000000000004',
    ward_indent_id: 61,
    ward_indent_item_id: 62,
    invoice_id: 71,
    source_financial_event_id: 72n,
    credit_note_number: 'CN-MED-00081',
    ward_indent_status: 'reconciled',
    ward_indent_state_version: 7,
    ...overrides,
  };
}

describe('MED-03 credit-note notification presentation contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    startWorkflowSlaMock.mockResolvedValue({
      id: '10000000-0000-4000-8000-000000000010',
    });
    createTaskMock.mockResolvedValue({ id: 91 });
    notificationQueueMock.mockResolvedValue({ id: 101n });
    postTaskCommentMock.mockResolvedValue({ id: 111n });
  });

  test('queues the localized action key with the exact credit-note deep link', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        if (sql.includes('FROM billing_credit_notes')) return [{ task_id: null }];
        if (sql.includes('FROM tasks task')) return [];
        if (sql.includes('UPDATE billing_credit_notes')) return [{ task_id: 91 }];
        if (sql.includes('FROM users')) {
          return [{ id: 201, uid: ACTOR_UID, phone: '+919999999999' }];
        }
        throw new Error(`Unexpected SQL: ${sql.slice(0, 120)}`);
      }),
    };

    await materializeBillingCreditNoteObligationTx(tx, {
      creditNote: creditNote(),
      actorUid: ACTOR_UID,
      sourceEvent: { id: 301n },
    });

    expect(notificationQueueMock).toHaveBeenCalledTimes(1);
    const [payload, options] = notificationQueueMock.mock.calls[0];
    expect(payload.data).toMatchObject({
      action_label_key: ACTION_LABEL_KEY,
      credit_note_id: '81',
      deep_link: '/billing/credit-notes/81',
    });
    expect(payload.data).not.toHaveProperty('action_label');
    expect(options).toEqual({ tx, strict: true });
    expect(createTaskMock.mock.calls[0][0].metadata.owner_role_codes).toEqual([
      'BILLING_INCHARGE',
      'FINANCE_INCHARGE',
    ]);
    expect(tx.$queryRawUnsafe.mock.calls.some(([sql]) => (
      sql.includes('AND (task_id IS NULL OR task_id = $3::int)')
    ))).toBe(true);
  });

  test('preserves the same action key in a durable no-recipient recovery intent', async () => {
    createTaskMock
      .mockResolvedValueOnce({ id: 91 })
      .mockResolvedValueOnce({ id: 92 });
    const tx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        if (sql.includes('FROM billing_credit_notes')) return [{ task_id: null }];
        if (sql.includes('FROM tasks task')) return [];
        if (sql.includes('UPDATE billing_credit_notes')) return [{ task_id: 91 }];
        if (sql.includes('FROM users')) return [];
        throw new Error(`Unexpected SQL: ${sql.slice(0, 120)}`);
      }),
    };

    await materializeBillingCreditNoteObligationTx(tx, {
      creditNote: creditNote(),
      actorUid: ACTOR_UID,
      sourceEvent: { id: 302n },
    });

    expect(notificationQueueMock).not.toHaveBeenCalled();
    expect(createTaskMock).toHaveBeenCalledTimes(2);
    expect(createTaskMock.mock.calls[1][0].metadata.notification_intent.data).toMatchObject({
      action_label_key: ACTION_LABEL_KEY,
      credit_note_id: '81',
      deep_link: '/billing/credit-notes/81',
    });
  });

  test('fails closed when an existing credit note points at another task', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        if (sql.includes('FROM billing_credit_notes')) return [{ task_id: 90 }];
        if (sql.includes('FROM tasks task')) return [];
        throw new Error(`Unexpected SQL: ${sql.slice(0, 120)}`);
      }),
    };

    await expect(materializeBillingCreditNoteObligationTx(tx, {
      creditNote: creditNote(),
      actorUid: ACTOR_UID,
      sourceEvent: { id: 304n },
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'WARD_MEDICATION_CREDIT_NOTE_TASK_LINK_CONFLICT',
    });
    expect(createTaskMock).not.toHaveBeenCalled();
    expect(notificationQueueMock).not.toHaveBeenCalled();
  });

  test('uses the localized action key for the refund-approval stage alert', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        if (sql.includes('FROM billing_credit_notes')) {
          return [{ task_id: 91 }];
        }
        if (sql.includes('FROM tasks task')) {
          return [{
            id: 91,
            status: 'in_progress',
            assigned_to_uid: ACTOR_UID,
            assigned_to_role: null,
            workflow_sla_instance_id: '10000000-0000-4000-8000-000000000010',
            metadata: {
              credit_note_stage: 'approved',
              ownership_stage_version: 1,
              acknowledged_by: ACTOR_UID,
              acknowledged_at: '2026-08-28T08:00:00.000Z',
              acknowledged_via: 'role',
              role_claimed_by: ACTOR_UID,
              role_claimed_from_role: 'BILLING_INCHARGE',
              role_claimed_at: '2026-08-28T07:59:00.000Z',
              role_claim_receipt: 'task-claim-v1:old',
              role_claim_command_fingerprint: 'old-fingerprint',
            },
          }];
        }
        if (sql.includes('UPDATE tasks')) {
          return [{
            id: 91,
            status: 'open',
            metadata: {},
            workflow_sla_instance_id: '10000000-0000-4000-8000-000000000010',
          }];
        }
        if (sql.includes('UPDATE workflow_sla_instances')) {
          return [{ id: '10000000-0000-4000-8000-000000000010' }];
        }
        if (sql.includes('FROM users')) {
          return [{ id: 202, uid: ACTOR_UID, phone: null }];
        }
        throw new Error(`Unexpected SQL: ${sql.slice(0, 120)}`);
      }),
    };

    await advanceBillingCreditNoteRefundObligationTx(tx, {
      creditNote: creditNote({ refund_id: 82 }),
      applicationEvent: { id: 303n, actor_uid: ACTOR_UID },
      actorUid: ACTOR_UID,
    });

    expect(notificationQueueMock).toHaveBeenCalledTimes(1);
    expect(notificationQueueMock.mock.calls[0][0].data).toMatchObject({
      action_label_key: ACTION_LABEL_KEY,
      credit_note_id: '81',
      refund_id: 82,
      deep_link: '/billing/credit-notes/81',
    });
    const taskUpdate = tx.$queryRawUnsafe.mock.calls.find(([sql]) => (
      sql.includes('UPDATE tasks')
    ));
    expect(taskUpdate[0]).toContain("status = 'open'");
    expect(taskUpdate[0]).toContain("- $6::text[]");
    expect(taskUpdate[0]).toContain("metadata->>'credit_note_stage' = 'approved'");
    expect(JSON.parse(taskUpdate[4]).owner_role_codes).toEqual(['ADMIN', 'SUPER_ADMIN']);
    expect(taskUpdate[6]).toEqual(expect.arrayContaining([
      'acknowledged_by',
      'acknowledged_at',
      'role_claimed_by',
      'role_claim_receipt',
    ]));
    const slaUpdate = tx.$queryRawUnsafe.mock.calls.find(([sql]) => (
      sql.includes('UPDATE workflow_sla_instances')
    ));
    expect(slaUpdate[3]).toEqual(['ADMIN', 'SUPER_ADMIN']);
    expect(postTaskCommentMock).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        ownership_rearmed: true,
        ownership_stage_version: 2,
        prior_status: 'in_progress',
        prior_acknowledgement: expect.objectContaining({ acknowledged_by: ACTOR_UID }),
        prior_role_claim: expect.objectContaining({ role_claimed_by: ACTOR_UID }),
      }),
    }));
  });
});
