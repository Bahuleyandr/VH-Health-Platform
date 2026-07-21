import { jest } from '@jest/globals';

import {
  isClinicalHumanOwnerRole,
  isPathwayHumanOwnerRole,
  isTaskHumanOwnerRole,
  repairCriticalResultTaskOwnerTx,
  resolveClinicalTaskOwnerTx,
} from '../../services/workflow/workflowHumanOwnerService.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const CLINICIAN = '22222222-2222-4222-8222-222222222222';

function txWith(...results) {
  return {
    $queryRawUnsafe: jest.fn()
      .mockImplementationOnce(async () => results.shift())
      .mockImplementation(async () => results.shift() || []),
  };
}

describe('workflow human owner policy', () => {
  it('separates pathway-clinical roles from the wider task route union', () => {
    expect(isClinicalHumanOwnerRole('DOCTOR')).toBe(true);
    expect(isPathwayHumanOwnerRole('NURSING_STAFF')).toBe(true);
    expect(isTaskHumanOwnerRole('LAB_STAFF')).toBe(true);
    expect(isClinicalHumanOwnerRole('PATIENT')).toBe(false);
    expect(isTaskHumanOwnerRole('WEBHOOK_CLIENT')).toBe(false);
    expect(isTaskHumanOwnerRole('UNKNOWN_ROLE')).toBe(false);
  });

  it('accepts only an active same-tenant route-capable named clinician', async () => {
    const tx = txWith([{ uid: CLINICIAN, role: 'DOCTOR' }]);
    await expect(resolveClinicalTaskOwnerTx({
      tx,
      tenantId: TENANT,
      requestedUid: CLINICIAN,
      fallbackRole: 'DUTY_DOCTOR',
    })).resolves.toMatchObject({
      assignedToUid: CLINICIAN,
      assignedToRole: null,
      resolution: 'requested_active_clinician',
    });
    expect(tx.$queryRawUnsafe.mock.calls[0][0]).toMatch(/tenant_id = \$1::uuid/);
    expect(tx.$queryRawUnsafe.mock.calls[0][0]).toMatch(/is_active = TRUE/);
  });

  it.each(['PATIENT', 'WEBHOOK_CLIENT', 'UNKNOWN_ROLE'])(
    'falls back to DUTY_DOCTOR when the named user has unreachable role %s',
    async (role) => {
      const tx = txWith([{ uid: CLINICIAN, role }]);
      await expect(resolveClinicalTaskOwnerTx({
        tx,
        tenantId: TENANT,
        requestedUid: CLINICIAN,
        fallbackRole: role,
      })).resolves.toMatchObject({
        assignedToUid: null,
        assignedToRole: 'DUTY_DOCTOR',
        resolution: 'duty_role_fallback',
      });
    },
  );

  it('uses a valid role queue without requiring a currently active holder', async () => {
    const tx = txWith();
    await expect(resolveClinicalTaskOwnerTx({
      tx,
      tenantId: TENANT,
      fallbackRole: 'NURSING_INCHARGE',
    })).resolves.toMatchObject({
      assignedToUid: null,
      assignedToRole: 'NURSING_INCHARGE',
      resolution: 'route_role_fallback',
    });
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('repairs an actionable task whose named owner is no longer serviceable', async () => {
    const repaired = {
      id: 91,
      status: 'open',
      assigned_to_uid: null,
      assigned_to_role: 'NURSING_INCHARGE',
      metadata: { critical_result_owner_repaired: true },
    };
    const tx = txWith([], [repaired]);
    await expect(repairCriticalResultTaskOwnerTx({
      tx,
      tenantId: TENANT,
      task: { id: 91, status: 'open', assigned_to_uid: CLINICIAN, assigned_to_role: null },
      requestedUid: null,
      fallbackRole: 'NURSING_INCHARGE',
    })).resolves.toEqual(repaired);
    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(2);
    expect(tx.$queryRawUnsafe.mock.calls[1][0]).toMatch(/UPDATE tasks/);
    expect(tx.$queryRawUnsafe.mock.calls[1][4]).toBe('NURSING_INCHARGE');
  });

  it('does not rewrite an acknowledged task', async () => {
    const tx = txWith();
    const task = { id: 91, status: 'in_progress', assigned_to_uid: CLINICIAN };
    await expect(repairCriticalResultTaskOwnerTx({
      tx,
      tenantId: TENANT,
      task,
      fallbackRole: 'DUTY_DOCTOR',
    })).resolves.toBe(task);
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});
