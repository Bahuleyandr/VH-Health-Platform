import { jest } from '@jest/globals';

import {
  getClinicalAccountabilityRoleCodes,
  getRolePolicy,
} from '../../config/rolePolicyGraph.js';
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  isTenantTransactionClient: (value) => value?.__tenantTransaction === true,
}));

const {
  isClinicalHumanOwnerRole,
  isPathwayHumanOwnerRole,
  isPathwayNamedClinicalOwnerRole,
  isTaskHumanOwnerRole,
  repairCriticalResultTaskOwnerTx,
  resolveClinicalTaskOwnerTx,
  resolveCurrentHumanActorTx,
  resolvePathwayTaskOwnerTx,
} = await import('../../services/workflow/workflowHumanOwnerService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const CLINICIAN = '22222222-2222-4222-8222-222222222222';
const CLINICAL_ACCOUNTABILITY_ROLES = getClinicalAccountabilityRoleCodes();
const NON_CLINICAL_ROLE_CODES = getRolePolicy().roles
  .filter((role) => (
    role.group !== 'clinical'
    && !isPathwayNamedClinicalOwnerRole(role.role_code)
  ))
  .map((role) => role.role_code);

function txWith(...results) {
  return {
    __tenantTransaction: true,
    $queryRawUnsafe: jest.fn()
      .mockImplementationOnce(async () => results.shift())
      .mockImplementation(async () => results.shift() || []),
  };
}

describe('workflow human owner policy', () => {
  it('resolves only the exact database-current authenticated primary role', async () => {
    const tx = txWith([{ uid: CLINICIAN, role: 'DOCTOR' }]);
    await expect(resolveCurrentHumanActorTx({
      tx,
      tenantId: TENANT,
      actorUid: CLINICIAN,
      authenticatedRoles: ['NURSING_STAFF', 'DOCTOR'],
      authenticatedPrimaryRole: 'DOCTOR',
      authenticatedRawRole: 'DOCTOR',
      rolePredicate: isTaskHumanOwnerRole,
    })).resolves.toEqual({
      uid: CLINICIAN,
      role: 'DOCTOR',
      queueRole: 'DOCTOR',
      rawRole: 'DOCTOR',
    });
    expect(tx.$queryRawUnsafe.mock.calls[0][0]).toMatch(/FOR SHARE/);
  });

  it('rejects an allowed-role membership when the authenticated primary role is stale', async () => {
    const tx = txWith([{ uid: CLINICIAN, role: 'DOCTOR' }]);
    await expect(resolveCurrentHumanActorTx({
      tx,
      tenantId: TENANT,
      actorUid: CLINICIAN,
      authenticatedRoles: ['NURSING_STAFF', 'DOCTOR'],
      authenticatedPrimaryRole: 'NURSING_STAFF',
      authenticatedRawRole: 'DOCTOR',
      rolePredicate: isTaskHumanOwnerRole,
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'CURRENT_HUMAN_ACTOR_FORBIDDEN',
    });
  });

  it.each([
    ['SUPER_ADMIN', 'ADMIN', 'SUPER_ADMIN'],
    ['NURSE', 'NURSING_STAFF', 'NURSING_STAFF'],
  ])('keeps exact raw %s parity while returning canonical capability and queue roles', async (
    rawRole,
    canonicalRole,
    queueRole,
  ) => {
    const tx = txWith([{ uid: CLINICIAN, role: rawRole }]);
    await expect(resolveCurrentHumanActorTx({
      tx,
      tenantId: TENANT,
      actorUid: CLINICIAN,
      authenticatedRoles: [canonicalRole],
      authenticatedPrimaryRole: canonicalRole,
      authenticatedRawRole: rawRole,
      rolePredicate: isTaskHumanOwnerRole,
    })).resolves.toEqual({
      uid: CLINICIAN,
      role: canonicalRole,
      queueRole,
      rawRole,
    });
  });

  it('rejects a token whose raw role no longer exactly matches the database', async () => {
    const tx = txWith([{ uid: CLINICIAN, role: 'DOCTOR' }]);
    await expect(resolveCurrentHumanActorTx({
      tx,
      tenantId: TENANT,
      actorUid: CLINICIAN,
      authenticatedRoles: ['DOCTOR'],
      authenticatedPrimaryRole: 'DOCTOR',
      authenticatedRawRole: 'DUTY_DOCTOR',
      rolePredicate: isTaskHumanOwnerRole,
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'CURRENT_HUMAN_ACTOR_FORBIDDEN',
    });
  });

  it('rejects an inactive or missing current user with the same generic denial', async () => {
    const tx = txWith([]);
    await expect(resolveCurrentHumanActorTx({
      tx,
      tenantId: TENANT,
      actorUid: CLINICIAN,
      authenticatedRoles: ['DOCTOR'],
      authenticatedPrimaryRole: 'DOCTOR',
      authenticatedRawRole: 'DOCTOR',
      rolePredicate: isTaskHumanOwnerRole,
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'CURRENT_HUMAN_ACTOR_FORBIDDEN',
      message: 'Current actor is not authorized for this work item',
    });
  });

  it('requires the branded tenant transaction capability', async () => {
    await expect(resolveCurrentHumanActorTx({
      tx: { $queryRawUnsafe: jest.fn() },
      tenantId: TENANT,
      actorUid: CLINICIAN,
      authenticatedRoles: ['DOCTOR'],
      authenticatedPrimaryRole: 'DOCTOR',
      authenticatedRawRole: 'DOCTOR',
    })).rejects.toMatchObject({
      statusCode: 500,
      code: 'CURRENT_HUMAN_ACTOR_TX_REQUIRED',
    });
  });

  it('separates pathway-clinical roles from the wider task route union', () => {
    expect(isClinicalHumanOwnerRole('DOCTOR')).toBe(true);
    expect(isPathwayHumanOwnerRole('NURSING_STAFF')).toBe(true);
    expect(isPathwayHumanOwnerRole('DIETITIAN')).toBe(true);
    expect(isPathwayHumanOwnerRole('PHYSIOTHERAPIST')).toBe(true);
    expect(isPathwayHumanOwnerRole('COUNSELLOR')).toBe(true);
    expect(isPathwayNamedClinicalOwnerRole('CATH_LAB_INCHARGE')).toBe(true);
    expect(isPathwayNamedClinicalOwnerRole('RADIOLOGIST')).toBe(true);
    expect(isPathwayNamedClinicalOwnerRole('PATHOLOGIST')).toBe(true);
    expect(isPathwayNamedClinicalOwnerRole('PHYSIOTHERAPIST')).toBe(true);
    expect(isPathwayNamedClinicalOwnerRole('COUNSELLOR')).toBe(true);
    expect(isPathwayNamedClinicalOwnerRole('ADMIN')).toBe(false);
    expect(isTaskHumanOwnerRole('LAB_STAFF')).toBe(true);
    expect(isTaskHumanOwnerRole('PHYSIOTHERAPIST')).toBe(true);
    expect(isTaskHumanOwnerRole('DIETITIAN')).toBe(true);
    expect(isTaskHumanOwnerRole('COUNSELLOR')).toBe(true);
    expect(isTaskHumanOwnerRole('QUALITY_OFFICER')).toBe(true);
    expect(isTaskHumanOwnerRole('BILLING_INCHARGE')).toBe(true);
    expect(isTaskHumanOwnerRole('FINANCE_INCHARGE')).toBe(true);
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

  it.each(CLINICAL_ACCOUNTABILITY_ROLES)(
    'resolves a valid named %s pathway owner exclusively',
    async (role) => {
      const tx = txWith([{ uid: CLINICIAN, role }]);
      await expect(resolvePathwayTaskOwnerTx({
        tx,
        tenantId: TENANT,
        requestedUid: CLINICIAN,
        fallbackRole: 'DUTY_DOCTOR',
      })).resolves.toEqual({
        assignedToUid: CLINICIAN,
        assignedToRole: null,
        resolution: 'requested_active_clinician',
        fallbackReason: null,
      });
      const [query] = tx.$queryRawUnsafe.mock.calls[0];
      expect(query).toMatch(/tenant_id = \$1::uuid/);
      expect(query).toMatch(/is_active = TRUE/);
      expect(query).toMatch(/LOWER\(COALESCE\(status, ''\)\) = 'active'/);
      expect(query).toMatch(/is_deleted IS FALSE/);
      expect(query).toMatch(/deleted_at IS NULL/);
      expect(query).toMatch(/FOR SHARE/);
    },
  );

  it.each([
    ['malformed', 'not-a-uuid', []],
    ['missing or cross-tenant', CLINICIAN, []],
    ['inactive', CLINICIAN, []],
  ])('rejects a %s named pathway owner instead of falling back', async (_label, requestedUid, rows) => {
    const tx = txWith(rows);
    const promise = resolvePathwayTaskOwnerTx({
      tx,
      tenantId: TENANT,
      requestedUid,
      fallbackRole: 'DUTY_DOCTOR',
    });
    await expect(promise).rejects.toMatchObject({
      statusCode: 409,
      code: 'PATHWAY_NAMED_OWNER_UNAVAILABLE',
    });
  });

  it.each(NON_CLINICAL_ROLE_CODES)(
    'rejects nonclinical %s as a named pathway owner without role fallback',
    async (role) => {
      const tx = txWith([{ uid: CLINICIAN, role }]);
      await expect(resolvePathwayTaskOwnerTx({
        tx,
        tenantId: TENANT,
        requestedUid: CLINICIAN,
        fallbackRole: 'DUTY_DOCTOR',
      })).rejects.toMatchObject({
        statusCode: 409,
        code: 'PATHWAY_NAMED_OWNER_UNAVAILABLE',
      });
    },
  );

  it('treats a supplied blank UID as invalid rather than as an unnamed role queue', async () => {
    const tx = txWith();
    await expect(resolvePathwayTaskOwnerTx({
      tx,
      tenantId: TENANT,
      requestedUid: ' ',
      fallbackRole: 'DUTY_DOCTOR',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PATHWAY_NAMED_OWNER_UNAVAILABLE',
    });
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('resolves a role-only pathway queue only when no named UID was supplied', async () => {
    const tx = txWith();
    await expect(resolvePathwayTaskOwnerTx({
      tx,
      tenantId: TENANT,
      requestedUid: null,
      fallbackRole: ' nursing_incharge ',
    })).resolves.toEqual({
      assignedToUid: null,
      assignedToRole: 'NURSING_INCHARGE',
      resolution: 'route_role_queue',
      fallbackReason: null,
    });
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('keeps role-only queues on the broader pathway routing policy', async () => {
    const tx = txWith();
    await expect(resolvePathwayTaskOwnerTx({
      tx,
      tenantId: TENANT,
      requestedUid: null,
      fallbackRole: 'MEDICAL_RECORDS',
    })).resolves.toMatchObject({
      assignedToUid: null,
      assignedToRole: 'MEDICAL_RECORDS',
      resolution: 'route_role_queue',
    });
  });

  it.each([null, '', 'PATIENT', 'LAB_STAFF', 'UNKNOWN_ROLE'])(
    'rejects invalid pathway role-only ownership %p',
    async (fallbackRole) => {
      const tx = txWith();
      await expect(resolvePathwayTaskOwnerTx({
        tx,
        tenantId: TENANT,
        requestedUid: null,
        fallbackRole,
      })).rejects.toMatchObject({
        statusCode: 409,
        code: 'PATHWAY_ROLE_OWNER_INVALID',
      });
      expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
    },
  );

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
