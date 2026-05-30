import { jest } from '@jest/globals';

const queryRawUnsafe = jest.fn();
const usersCreate = jest.fn();
const onboardingCreate = jest.fn();
const bcryptHash = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryRawUnsafe,
    users: {
      create: usersCreate,
    },
    staff_onboarding_tasks: {
      create: onboardingCreate,
    },
  },
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
});
