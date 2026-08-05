import { jest } from '@jest/globals';

const setTenantTxMock = jest.fn();
const acknowledgeTaskMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  setTenantTx: setTenantTxMock,
}));

jest.unstable_mockModule('../../services/workflow/taskService.js', () => ({
  acknowledgeTask: acknowledgeTaskMock,
}));

const {
  acknowledgeExternalRecoveryCriticalReviewForInboxTask,
  appendExternalRecoveryCriticalReviewObligationTx,
} = await import('../../services/integrations/externalRecoveryCriticalReviewService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const ACTOR = '11111111-1111-4111-8111-111111111111';
const INBOX = '22222222-2222-4222-8222-222222222222';
const OBLIGATION = '33333333-3333-4333-8333-333333333333';
const ACKNOWLEDGEMENT = '44444444-4444-4444-8444-444444444444';

describe('externalRecoveryCriticalReviewService', () => {
  let tx;

  beforeEach(() => {
    tx = { $queryRawUnsafe: jest.fn() };
    setTenantTxMock.mockReset();
    setTenantTxMock.mockImplementation(async (_tenantId, callback) => callback(tx));
    acknowledgeTaskMock.mockReset();
  });

  it('appends one sorted, exact late-critical obligation inside the recovery transaction', async () => {
    tx.$queryRawUnsafe.mockResolvedValueOnce([
      { obligation: { id: OBLIGATION, task_id: 81 } },
    ]);

    const receipt = await appendExternalRecoveryCriticalReviewObligationTx({
      tx,
      tenantId: TENANT,
      recoveryInboxId: INBOX,
      interfaceFamily: 'I01',
      task: { id: 81, priority: 'critical', assigned_to_role: 'DUTY_DOCTOR' },
      patientUid: '55555555-5555-4555-8555-555555555555',
      criticalResultIds: [17, 9, 17],
      sourceOccurredAt: '2026-08-04T08:30:00.000Z',
    });

    expect(receipt).toEqual({ id: OBLIGATION, task_id: 81 });
    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    const [sql, rawCommand] = tx.$queryRawUnsafe.mock.calls[0];
    expect(sql).toContain('external_recovery_critical_review_obligation_append');
    expect(JSON.parse(rawCommand)).toMatchObject({
      contract: 'late_pending_only',
      contract_version: 1,
      tenant_id: TENANT,
      recovery_inbox_id: INBOX,
      interface_family: 'I01',
      task_id: 81,
      critical_result_ids: [9, 17],
      recipient_class: 'DUTY_DOCTOR',
      source_occurred_at: '2026-08-04T08:30:00.000Z',
    });
  });

  it('refuses an obligation that is not bound to the exact no-SLA critical duty-doctor task', async () => {
    await expect(appendExternalRecoveryCriticalReviewObligationTx({
      tx,
      tenantId: TENANT,
      recoveryInboxId: INBOX,
      interfaceFamily: 'I02',
      task: { id: 82, priority: 'high', assigned_to_role: 'DUTY_DOCTOR' },
      patientUid: '55555555-5555-4555-8555-555555555555',
      criticalResultIds: [9],
      sourceOccurredAt: '2026-08-04T08:30:00.000Z',
    })).rejects.toMatchObject({ code: 'EXTERNAL_RECOVERY_CRITICAL_REVIEW_TASK_INVALID' });
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('acknowledges the task and immutable awareness obligation in one tenant transaction', async () => {
    tx.$queryRawUnsafe
      .mockResolvedValueOnce([{
        obligation_id: OBLIGATION,
        task_id: 81,
        interface_family: 'I01',
        recovery_inbox_id: INBOX,
        acknowledgement_id: null,
        awareness_acknowledged_at: null,
      }])
      .mockResolvedValueOnce([{
        acknowledgement: {
          id: ACKNOWLEDGEMENT,
          obligation_id: OBLIGATION,
          recorded_at: '2026-08-05T09:00:00.000Z',
        },
      }]);
    acknowledgeTaskMock.mockResolvedValueOnce({
      id: 81,
      status: 'in_progress',
      metadata: {
        acknowledged_at: '2026-08-05T09:00:00.000Z',
        acknowledged_by: ACTOR,
        acknowledged_via: 'role',
      },
    });

    const result = await acknowledgeExternalRecoveryCriticalReviewForInboxTask(81, {
      tenantId: TENANT,
      actorUid: ACTOR,
      actorRoles: ['DUTY_DOCTOR'],
      actorPrimaryRole: 'DUTY_DOCTOR',
      actorRawRole: 'DUTY_DOCTOR',
      requestId: 'request-81',
    });

    expect(setTenantTxMock).toHaveBeenCalledWith(
      TENANT,
      expect.any(Function),
      { isolationLevel: 'Serializable' },
    );
    expect(acknowledgeTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      id: 81,
      actorUid: ACTOR,
      actorRoles: ['DUTY_DOCTOR'],
      actorPrimaryRole: 'DUTY_DOCTOR',
      actorRawRole: 'DUTY_DOCTOR',
      tx,
    }));
    const [ackSql, rawCommand] = tx.$queryRawUnsafe.mock.calls[1];
    expect(ackSql).toContain('external_recovery_critical_review_acknowledge');
    const command = JSON.parse(rawCommand);
    expect(command).toMatchObject({
      tenant_id: TENANT,
      obligation_id: OBLIGATION,
      task_id: 81,
      actor_uid: ACTOR,
      authorization_mode: 'role',
      task_acknowledged_at: '2026-08-05T09:00:00.000Z',
      request_id: 'request-81',
    });
    expect(command).not.toHaveProperty('actor_role');
    expect(result).toMatchObject({
      handled: true,
      task: {
        id: 81,
        external_recovery_critical_review_obligation_id: OBLIGATION,
        external_recovery_critical_review_acknowledgement_id: ACKNOWLEDGEMENT,
        external_recovery_awareness_acknowledgement_required: false,
      },
    });
  });

  it('leaves ordinary clinical-inbox tasks on the existing acknowledgement path', async () => {
    tx.$queryRawUnsafe.mockResolvedValueOnce([]);

    await expect(acknowledgeExternalRecoveryCriticalReviewForInboxTask(99, {
      tenantId: TENANT,
      actorUid: ACTOR,
      actorRoles: ['DOCTOR'],
      actorPrimaryRole: 'DOCTOR',
    })).resolves.toEqual({ handled: false });
    expect(acknowledgeTaskMock).not.toHaveBeenCalled();
  });
});
