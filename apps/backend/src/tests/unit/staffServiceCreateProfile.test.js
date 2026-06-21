import { jest } from '@jest/globals';

const queryRawUnsafe = jest.fn();
const usersCreate = jest.fn();
const onboardingCreate = jest.fn();
const bcryptHash = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryRawUnsafe,
  users: {
    create: usersCreate,
  },
  staff_onboarding_tasks: {
    create: onboardingCreate,
  },
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    error: jest.fn(),
    info: jest.fn(),
  },
}));

jest.unstable_mockModule('bcrypt', () => ({
  default: {
    hash: bcryptHash,
  },
}));

const { createStaffProfile } = await import('../../services/staff/staffService.js');

describe('createStaffProfile onboarding account creation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    bcryptHash.mockResolvedValue('$2b$10$hashed');
    onboardingCreate.mockResolvedValue({});
  });

  it('creates the user account, staff row, onboarding tasks, and audit log together', async () => {
    const staffUid = '9c36ad66-fec9-4e89-85b1-712f294d75c9';
    queryRawUnsafe
      .mockResolvedValueOnce([{ employee_id: 'EMP-1047' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 106,
          user_id: staffUid,
          employee_id: 'EMP-1048',
          name: 'New Staff Nurse',
          department: 'Nursing',
          position: 'Staff Nurse',
          shift: 'MORNING',
          is_active: true,
          created_at: new Date('2026-05-30T00:00:00Z'),
          updated_at: new Date('2026-05-30T00:00:00Z'),
        },
      ])
      .mockResolvedValueOnce([]);

    usersCreate.mockResolvedValue({
      id: 815,
      uid: staffUid,
      role: 'NURSING_STAFF',
      name: 'New Staff Nurse',
      phone: '9876543210',
      email: 'nurse@example.com',
    });

    const result = await createStaffProfile(
      {
        name: 'New Staff Nurse',
        phone: '98765 43210',
        email: 'nurse@example.com',
        role: 'NURSING_STAFF',
        department: 'Nursing',
        position: 'Staff Nurse',
        shift: 'MORNING',
        temporary_password: 'test1234',
      },
      '11111111-1111-4111-8111-111111111111',
      'Test HR',
      '127.0.0.1',
    );

    expect(bcryptHash).toHaveBeenCalledWith('test1234', 10);
    expect(usersCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          phone: '9876543210',
          name: 'New Staff Nurse',
          email: 'nurse@example.com',
          role: 'NURSING_STAFF',
          encrypted_password: '$2b$10$hashed',
        }),
      }),
    );
    expect(onboardingCreate).toHaveBeenCalledTimes(6);
    expect(queryRawUnsafe.mock.calls[4][0]).toContain('INSERT INTO staff');
    expect(queryRawUnsafe.mock.calls[4]).toEqual(
      expect.arrayContaining([staffUid, 'EMP-1048', 'New Staff Nurse']),
    );
    expect(queryRawUnsafe.mock.calls[5][0]).toContain('INSERT INTO admin_activity_logs');
    expect(result.staff.employee_id).toBe('EMP-1048');
    expect(result.onboarding.tasks_created).toBe(6);
  });

  // Security audit (LOW): minimum password length raised 6 -> 8 across all
  // password-acceptance paths. createStaffProfile -> resolveOrCreateStaffUser
  // enforces SECURITY_CONFIG.password.minLength (8). A 7-char password (which
  // previously satisfied the old min:6 floor) must now be rejected, and an
  // 8-char password must clear the gate and reach bcrypt hashing.
  it('rejects a 7-character password as WEAK_PASSWORD (below the 8-char floor)', async () => {
    // Only the employee_id uniqueness check runs before the length gate.
    queryRawUnsafe.mockResolvedValueOnce([]);

    await expect(createStaffProfile(
      {
        name: 'Short Pass Nurse',
        phone: '9876543210',
        role: 'NURSING_STAFF',
        department: 'Nursing',
        position: 'Staff Nurse',
        employee_id: 'EMP-2001',
        temporary_password: 'test123', // 7 chars
      },
      '11111111-1111-4111-8111-111111111111',
      'Test HR',
      '127.0.0.1',
    )).rejects.toThrow('WEAK_PASSWORD');

    expect(bcryptHash).not.toHaveBeenCalled();
    expect(usersCreate).not.toHaveBeenCalled();
  });

  it('accepts an 8-character password (clears the length floor and hashes it)', async () => {
    // The length gate sits before bcrypt.hash; reaching the hash proves the
    // 8-char password cleared it. We let the user INSERT reject so we only have
    // to model the two pre-hash lookups (employee_id uniqueness, phone lookup)
    // instead of the whole downstream create/audit flow.
    queryRawUnsafe
      .mockResolvedValueOnce([]) // employee_id uniqueness check
      .mockResolvedValueOnce([]); // phone existence check in resolveOrCreateStaffUser
    usersCreate.mockRejectedValue(new Error('STOP_AFTER_HASH'));

    await expect(createStaffProfile(
      {
        name: 'Boundary Nurse',
        phone: '9876543210',
        role: 'NURSING_STAFF',
        department: 'Nursing',
        position: 'Staff Nurse',
        employee_id: 'EMP-2002',
        shift: 'MORNING',
        temporary_password: 'eightch8', // exactly 8 chars
      },
      '11111111-1111-4111-8111-111111111111',
      'Test HR',
      '127.0.0.1',
    )).rejects.toThrow('STOP_AFTER_HASH');

    // Reaching bcrypt.hash proves the 8-char password passed the length gate
    // (a sub-8 password would have thrown WEAK_PASSWORD before this point).
    expect(bcryptHash).toHaveBeenCalledWith('eightch8', 10);
  });

  it('rejects platform admin roles in staff onboarding', async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([{ employee_id: 'EMP-1048' }])
      .mockResolvedValueOnce([]);

    await expect(createStaffProfile(
      {
        name: 'Privileged User',
        phone: '9876543210',
        role: 'ADMIN',
        department: 'Administration',
        position: 'Administrator',
        temporary_password: 'test1234',
      },
      '11111111-1111-4111-8111-111111111111',
      'Test HR',
      '127.0.0.1',
    )).rejects.toThrow('INVALID_ROLE');

    expect(usersCreate).not.toHaveBeenCalled();
    expect(onboardingCreate).not.toHaveBeenCalled();
  });
});
