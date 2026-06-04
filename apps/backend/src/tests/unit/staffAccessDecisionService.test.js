import { jest } from '@jest/globals';

const prismaMock = {
  $queryRawUnsafe: jest.fn(),
  $executeRawUnsafe: jest.fn(),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

const {
  authorizeStaffAccessRequest,
  STAFF_ACCESS_POLICY_CODES,
} = await import('../../services/security/staffAccessDecisionService.js');

const ACTOR_UID = '22222222-2222-4222-8222-222222222222';
const TARGET_UID = '33333333-3333-4333-8333-333333333333';
const TENANT_ID = '00000000-0000-4000-8000-000000000001';

afterEach(() => {
  prismaMock.$queryRawUnsafe.mockReset();
  prismaMock.$executeRawUnsafe.mockReset();
});

function reqFor(role, extras = {}) {
  return {
    id: 'req-staff-1',
    method: extras.method || 'GET',
    originalUrl: extras.originalUrl || '/api/v1/staff/hr/onboarding/42',
    params: extras.params || { staff_id: '42' },
    query: extras.query || {},
    body: extras.body || {},
    user: {
      id: 9,
      uid: ACTOR_UID,
      role,
      tenant_id: TENANT_ID,
      ...extras.user,
    },
  };
}

function targetRow(role = 'IP_STAFF_NURSE', overrides = {}) {
  return [{
    user_id: 42,
    user_uid: TARGET_UID,
    role,
    name: 'Target Staff',
    tenant_id: TENANT_ID,
    staff_row_id: 7,
    employee_id: 'EMP-42',
    department: 'IP Nursing',
    designation: 'Staff Nurse',
    supervisor_id: null,
    ...overrides,
  }];
}

describe('staffAccessDecisionService', () => {
  it('allows HR staff to process non-admin staff files and audits the allow decision', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce(targetRow('IP_STAFF_NURSE'));
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizeStaffAccessRequest(reqFor('HR_STAFF'), {
      policyCode: STAFF_ACCESS_POLICY_CODES.STAFF_PROFILE_VIEW,
      targetParam: 'staff_id',
      requireTarget: true,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.accessSource).toBe('hr_process');
    expect(prismaMock.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    expect(prismaMock.$executeRawUnsafe.mock.calls[0][8]).toBe('allow');
    expect(prismaMock.$executeRawUnsafe.mock.calls[0][9]).toBe('hr_process');
    expect(prismaMock.$executeRawUnsafe.mock.calls[0][10]).toBe(STAFF_ACCESS_POLICY_CODES.STAFF_PROFILE_VIEW);
  });

  it('does not let HR staff access admin-tier staff records', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce(targetRow('ADMIN'));
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizeStaffAccessRequest(reqFor('HR_STAFF'), {
      policyCode: STAFF_ACCESS_POLICY_CODES.STAFF_PROFILE_VIEW,
      targetParam: 'staff_id',
      requireTarget: true,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/super admin/i);
    expect(prismaMock.$executeRawUnsafe.mock.calls[0][8]).toBe('deny');
  });

  it('allows OP incharge to view OP staff through reporting scope', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce(targetRow('OP_STAFF_NURSE'));
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizeStaffAccessRequest(reqFor('OP_INCHARGE'), {
      policyCode: STAFF_ACCESS_POLICY_CODES.STAFF_PROFILE_VIEW,
      targetParam: 'staff_id',
      requireTarget: true,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.accessSource).toBe('reporting_scope');
  });

  it('denies OP incharge from viewing IP staff records', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce(targetRow('IP_STAFF_NURSE'));
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizeStaffAccessRequest(reqFor('OP_INCHARGE'), {
      policyCode: STAFF_ACCESS_POLICY_CODES.STAFF_PROFILE_VIEW,
      targetParam: 'staff_id',
      requireTarget: true,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/Staff record access denied/i);
  });

  it('allows self-service payroll declaration policy without opening salary-config writes', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce(targetRow('GENERAL_STAFF', {
      user_id: 9,
      user_uid: ACTOR_UID,
    }));
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizeStaffAccessRequest(reqFor('GENERAL_STAFF'), {
      policyCode: STAFF_ACCESS_POLICY_CODES.STAFF_PAYROLL_SELF_WRITE,
      selfIfNoTarget: true,
      requireTarget: true,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.accessSource).toBe('self');
  });

  it('denies patient roles from staff governance collection access', async () => {
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizeStaffAccessRequest(reqFor('PATIENT', {
      params: {},
      originalUrl: '/api/v1/staff/admin/dashboard',
    }), {
      policyCode: STAFF_ACCESS_POLICY_CODES.STAFF_REPORT_VIEW,
      allowNoTarget: true,
    });

    expect(decision.allowed).toBe(false);
    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(prismaMock.$executeRawUnsafe.mock.calls[0][8]).toBe('deny');
  });
});
