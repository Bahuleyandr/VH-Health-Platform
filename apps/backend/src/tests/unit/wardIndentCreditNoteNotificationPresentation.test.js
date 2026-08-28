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
        if (sql.includes('FROM tasks')) return [];
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
  });

  test('preserves the same action key in a durable no-recipient recovery intent', async () => {
    createTaskMock
      .mockResolvedValueOnce({ id: 91 })
      .mockResolvedValueOnce({ id: 92 });
    const tx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        if (sql.includes('FROM tasks')) return [];
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

  test('uses the localized action key for the refund-approval stage alert', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        if (sql.includes('FROM tasks')) {
          return [{ id: 91, status: 'open', metadata: {} }];
        }
        if (sql.includes('UPDATE tasks')) {
          return [{ id: 91, status: 'open', metadata: {} }];
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
  });
});
