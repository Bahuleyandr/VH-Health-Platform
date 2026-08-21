import { jest } from '@jest/globals';

jest.unstable_mockModule('@prisma/client', () => ({
  Prisma: {
    raw: (value) => value,
    sql: (strings, ...values) => ({ strings, values }),
  },
}));

const prismaQueryRawUnsafeMock = jest.fn();
const txQueryRawUnsafeMock = jest.fn();
const txExecuteRawUnsafeMock = jest.fn();
const txExecuteRawMock = jest.fn();
const tx = {
  $queryRawUnsafe: txQueryRawUnsafeMock,
  $executeRawUnsafe: txExecuteRawUnsafeMock,
  $executeRaw: txExecuteRawMock,
  audit_logs: { create: jest.fn() },
  staff: { updateMany: jest.fn() },
  doctors: { updateMany: jest.fn() },
};
const setTenantTxMock = jest.fn(async (_tenantId, fn) => fn(tx));
const prismaMock = {
  $queryRawUnsafe: prismaQueryRawUnsafeMock,
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  setTenantTx: setTenantTxMock,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../../utils/firebaseAdmin.js', () => ({
  default: { auth: jest.fn() },
}));
jest.unstable_mockModule('../../services/security/phiColumnEncryption.js', () => ({
  encryptColumn: jest.fn(),
  searchableHash: jest.fn(),
}));
jest.unstable_mockModule('../../utils/infrastructure/rbacUtils.js', () => ({
  ROLE_HIERARCHY: { ADMIN: {} },
  canUserManageRole: () => true,
  checkRoleCapacity: async () => ({ hasCapacity: true, max: null }),
  getManageableRoles: () => [],
  hasPermission: () => true,
  validateRoleTransition: () => ({ valid: true, errors: [] }),
}));

const persistRevokeAllUserTokensMock = jest.fn();
const publishRevokeAllUserTokensMock = jest.fn();
const persistRevokeDelegatedTupleMock = jest.fn();
const publishRevokeDelegatedTupleMock = jest.fn();
jest.unstable_mockModule('../../utils/tokenBlacklist.js', () => ({
  isSubjectDelegationRevoked: jest.fn().mockResolvedValue(false),
  persistRevokeAllUserTokens: persistRevokeAllUserTokensMock,
  publishRevokeAllUserTokens: publishRevokeAllUserTokensMock,
  persistRevokeDelegatedTuple: persistRevokeDelegatedTupleMock,
  publishRevokeDelegatedTuple: publishRevokeDelegatedTupleMock,
}));

const { USER_CONFIG } = await import('../../config/userConfig.js');
const { DependentsService } = await import('../../services/user/dependentsService.js');
const { UserService } = await import('../../services/user/userService.js');
const { RBACService } = await import('../../services/infrastructure/rbacService.js');

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const GUARDIAN_UID = '20000000-0000-4000-8000-000000000001';
const DEPENDENT_UID = '30000000-0000-4000-8000-000000000001';

beforeEach(() => {
  jest.clearAllMocks();
  setTenantTxMock.mockImplementation(async (_tenantId, fn) => fn(tx));
  txExecuteRawMock.mockResolvedValue(1);
  txExecuteRawUnsafeMock.mockResolvedValue(1);
  tx.audit_logs.create.mockResolvedValue({});
  tx.staff.updateMany.mockResolvedValue({ count: 0 });
  tx.doctors.updateMany.mockResolvedValue({ count: 0 });
  persistRevokeAllUserTokensMock.mockResolvedValue(2000);
  publishRevokeAllUserTokensMock.mockResolvedValue({});
  persistRevokeDelegatedTupleMock.mockResolvedValue(2000);
  publishRevokeDelegatedTupleMock.mockResolvedValue({});
});

describe('delegated authority writers revoke at the mutation boundary', () => {
  it('persists an unlink tuple watermark in the transaction, then closes only that tuple', async () => {
    prismaQueryRawUnsafeMock.mockResolvedValueOnce([{
      id: 42,
      uid: DEPENDENT_UID,
      guardian_user_id: 7,
    }]);
    txQueryRawUnsafeMock.mockResolvedValueOnce([{
      id: 42,
      uid: DEPENDENT_UID,
      guardian_uid: GUARDIAN_UID,
    }]);

    await DependentsService.unlinkDependent({
      guardianUserId: 7,
      guardianUid: GUARDIAN_UID,
      dependentId: 42,
      tenantId: TENANT_ID,
    });

    expect(persistRevokeDelegatedTupleMock).toHaveBeenCalledWith(
      GUARDIAN_UID,
      DEPENDENT_UID,
      { client: tx, reason: 'dependent_unlinked' },
    );
    expect(persistRevokeDelegatedTupleMock.mock.invocationCallOrder[0])
      .toBeLessThan(publishRevokeDelegatedTupleMock.mock.invocationCallOrder[0]);
    expect(publishRevokeDelegatedTupleMock).toHaveBeenCalledWith(
      GUARDIAN_UID,
      DEPENDENT_UID,
      2000,
      { reason: 'dependent_unlinked' },
    );
  });

  it('does not publish an unlink when durable tuple revocation fails', async () => {
    prismaQueryRawUnsafeMock.mockResolvedValueOnce([{
      id: 42,
      uid: DEPENDENT_UID,
      guardian_user_id: 7,
    }]);
    txQueryRawUnsafeMock.mockResolvedValueOnce([{
      id: 42,
      uid: DEPENDENT_UID,
      guardian_uid: GUARDIAN_UID,
    }]);
    persistRevokeDelegatedTupleMock.mockRejectedValueOnce(new Error('revocation unavailable'));

    await expect(DependentsService.unlinkDependent({
      guardianUserId: 7,
      guardianUid: GUARDIAN_UID,
      dependentId: 42,
      tenantId: TENANT_ID,
    })).rejects.toThrow('revocation unavailable');
    expect(publishRevokeDelegatedTupleMock).not.toHaveBeenCalled();
  });

  it('deactivation atomically bumps the identity epoch and publishes after commit', async () => {
    UserService.getUserById = jest.fn().mockResolvedValue({
      id: 42,
      uid: DEPENDENT_UID,
      role: 'PATIENT',
      tenant_id: TENANT_ID,
      is_active: true,
    });

    await UserService.changeUserStatus(
      DEPENDENT_UID,
      USER_CONFIG.USER_STATUS.DEACTIVATED,
      'guardian request',
      GUARDIAN_UID,
    );

    expect(persistRevokeAllUserTokensMock).toHaveBeenCalledWith(DEPENDENT_UID, {
      client: tx,
      requireEvidence: true,
      reason: 'user_deactivated',
      notificationTenantId: TENANT_ID,
    });
    expect(persistRevokeAllUserTokensMock.mock.invocationCallOrder[0])
      .toBeLessThan(publishRevokeAllUserTokensMock.mock.invocationCallOrder[0]);
    expect(publishRevokeAllUserTokensMock).toHaveBeenCalledWith(
      DEPENDENT_UID,
      2000,
      { reason: 'user_deactivated' },
    );
  });

  it('role changes revoke the old role-bearing session after the transaction commits', async () => {
    txQueryRawUnsafeMock.mockResolvedValueOnce([{
      uid: GUARDIAN_UID,
      role: 'PATIENT',
      name: 'Guardian',
    }]);

    await RBACService.assignRole(
      { phone: '+919999999999', role: 'GENERAL_STAFF', reason: 'role transfer' },
      { uid: '40000000-0000-4000-8000-000000000001', role: 'ADMIN', tenant_id: TENANT_ID },
    );

    expect(persistRevokeAllUserTokensMock).toHaveBeenCalledWith(GUARDIAN_UID, {
      client: tx,
      requireEvidence: true,
      reason: 'role_changed',
      notificationTenantId: TENANT_ID,
    });
    expect(publishRevokeAllUserTokensMock).toHaveBeenCalledWith(
      GUARDIAN_UID,
      2000,
      { reason: 'role_changed' },
    );
  });

  it('RBAC lock durably revokes the identity, while unlock does not add a revocation', async () => {
    txQueryRawUnsafeMock
      .mockResolvedValueOnce([{ uid: GUARDIAN_UID, name: 'Guardian', role: 'PATIENT', is_active: false }])
      .mockResolvedValueOnce([{ uid: GUARDIAN_UID, name: 'Guardian', role: 'PATIENT', is_active: true }]);
    const admin = {
      uid: '40000000-0000-4000-8000-000000000001',
      role: 'ADMIN',
      tenant_id: TENANT_ID,
    };

    await RBACService.toggleUserStatus(
      { phone: '+919999999999', action: 'lock', reason: 'security hold' },
      admin,
    );
    await RBACService.toggleUserStatus(
      { phone: '+919999999999', action: 'unlock', reason: 'hold cleared' },
      admin,
    );

    expect(persistRevokeAllUserTokensMock).toHaveBeenCalledTimes(1);
    expect(persistRevokeAllUserTokensMock).toHaveBeenCalledWith(GUARDIAN_UID, {
      client: tx,
      requireEvidence: true,
      reason: 'user_locked',
      notificationTenantId: TENANT_ID,
    });
    expect(publishRevokeAllUserTokensMock).toHaveBeenCalledTimes(1);
  });
});
