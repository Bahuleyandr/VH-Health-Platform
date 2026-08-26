import { jest } from '@jest/globals';

import * as rbacController from '../../controllers/infrastructure/rbacController.js';
import { RBACService } from '../../services/infrastructure/rbacService.js';

const ACTOR = {
  uid: '40000000-0000-4000-8000-000000000001',
  role: 'ADMIN',
  rawRole: 'SUPER_ADMIN',
  mfa: false,
};

function responseFor(req) {
  return {
    req,
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

describe('RBAC role-mutation SUPER_ADMIN step-up', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects direct single and bulk service calls before tenant or database work', async () => {
    const resolveTenant = jest.spyOn(RBACService, '_resolveActorTenantId');

    await expect(RBACService.assignRole(
      { phone: '9999999999', role: 'GENERAL_STAFF' },
      ACTOR,
    )).rejects.toMatchObject({
      statusCode: 403,
      code: 'SUPER_ADMIN_MFA_REQUIRED',
    });

    await expect(RBACService.bulkAssignRoles({
      assignments: [{ phone: '9999999999', role: 'GENERAL_STAFF' }],
    }, ACTOR)).rejects.toMatchObject({
      statusCode: 403,
      code: 'SUPER_ADMIN_MFA_REQUIRED',
    });

    expect(resolveTenant).not.toHaveBeenCalled();
  });

  it('does not impose SUPER_ADMIN step-up on the legitimate lower-environment HR path', async () => {
    const sentinel = new Error('tenant-resolution-sentinel');
    const resolveTenant = jest
      .spyOn(RBACService, '_resolveActorTenantId')
      .mockRejectedValue(sentinel);

    await expect(RBACService.assignRole(
      { phone: '9999999999', role: 'GENERAL_STAFF' },
      { uid: ACTOR.uid, role: 'HR_STAFF' },
    )).rejects.toBe(sentinel);

    expect(resolveTenant).toHaveBeenCalledWith({ uid: ACTOR.uid, role: 'HR_STAFF' });
  });

  it.each([
    ['assignRole', rbacController.assignRole, { phone: '9999999999', role: 'GENERAL_STAFF' }],
    ['bulkAssignRoles', rbacController.bulkAssignRoles, { assignments: [{ phone: '9999999999', role: 'GENERAL_STAFF' }] }],
  ])('relays the service defense as a typed 403 from %s', async (_controllerName, controller, body) => {
    const req = { user: ACTOR, body };
    const res = responseFor(req);

    await controller(req, res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({
      success: false,
      code: 'SUPER_ADMIN_MFA_REQUIRED',
    });
  });

  it('relays the same typed refusal from the mass-role mutation caller', async () => {
    jest.spyOn(RBACService, 'getUsersByRole').mockResolvedValue({
      usersByRole: [{ role: 'GENERAL_STAFF', users: [] }],
    });
    const req = {
      user: ACTOR,
      body: {
        fromRole: 'GENERAL_STAFF',
        toRole: 'NURSING_STAFF',
        dryRun: false,
      },
    };
    const res = responseFor(req);

    await rbacController.massRoleUpdate(req, res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({
      success: false,
      code: 'SUPER_ADMIN_MFA_REQUIRED',
    });
  });

  it('forwards the canonical role and MFA proof from every controller caller', async () => {
    const steppedUpActor = { ...ACTOR, mfa: true };
    const assignRole = jest.spyOn(RBACService, 'assignRole').mockResolvedValue({ unchanged: true });
    const bulkAssignRoles = jest.spyOn(RBACService, 'bulkAssignRoles').mockResolvedValue({
      successful: [],
      failed: [],
    });
    jest.spyOn(RBACService, 'getUsersByRole').mockResolvedValue({
      usersByRole: [{ role: 'GENERAL_STAFF', users: [] }],
    });

    let req = { user: steppedUpActor, body: { phone: '9999999999', role: 'GENERAL_STAFF' } };
    await rbacController.assignRole(req, responseFor(req));
    expect(assignRole).toHaveBeenLastCalledWith(req.body, steppedUpActor);

    req = { user: steppedUpActor, body: { assignments: [] } };
    await rbacController.bulkAssignRoles(req, responseFor(req));
    expect(bulkAssignRoles).toHaveBeenLastCalledWith(req.body, steppedUpActor);

    req = {
      user: steppedUpActor,
      body: {
        fromRole: 'GENERAL_STAFF',
        toRole: 'NURSING_STAFF',
        dryRun: false,
      },
    };
    await rbacController.massRoleUpdate(req, responseFor(req));
    expect(bulkAssignRoles).toHaveBeenLastCalledWith({
      assignments: [],
      reason: 'Mass role update',
    }, steppedUpActor);
  });
});
