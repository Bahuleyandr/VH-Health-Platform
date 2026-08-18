import { jest } from '@jest/globals';

const tx = {
  leave_applications: {
    create: jest.fn(),
  },
  replacement_requests: {
    create: jest.fn(),
  },
  users: {
    findFirst: jest.fn(),
  },
};

const prismaMock = {
  $transaction: jest.fn(async fn => fn(tx)),
  users: {
    findUnique: jest.fn(),
  },
  staff: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
  },
  leave_types: {
    findMany: jest.fn(),
  },
  leave_applications: {
    findMany: jest.fn(),
  },
  notifications: {
    create: jest.fn(),
  },
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  setTenantTx: async (_tenantId, fn) => fn(tx),
  setTenant: async (_tenantId, fn) => fn(tx),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(tx),
  pickTenantClient: () => prismaMock,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const { applyForLeave } = await import('../../services/staff/hr/leaveService.js');

describe('leaveService roster integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.users.findUnique.mockResolvedValue({
      id: 100,
      uid: '11111111-2222-4333-8444-000000020100',
      name: 'Nurse One',
      tenant_id: '10000000-0000-4000-8000-000000000001',
      staff: [
        {
          employee_id: 'EMP-100',
          department: 'Nursing',
          hire_date: null,
          supervisor_id: null,
        },
      ],
    });
    prismaMock.leave_types.findMany.mockResolvedValue([
      { leave_type: 'casual', annual_entitlement: 12 },
    ]);
    prismaMock.leave_applications.findMany.mockResolvedValue([]);
    tx.leave_applications.create.mockResolvedValue({
      id: 55,
      staff_id: 100,
      leave_type: 'casual',
      start_date: new Date('2026-06-01T00:00:00.000Z'),
      end_date: new Date('2026-06-02T00:00:00.000Z'),
      days_taken: 2,
      reason: 'Family function',
      emergency_contact: null,
      status: 'pending',
      applied_by: '11111111-2222-4333-8444-000000020100',
      applied_date: new Date('2026-05-28T00:00:00.000Z'),
      created_at: new Date('2026-05-28T00:00:00.000Z'),
    });
    tx.users.findFirst.mockResolvedValue({ id: 101 });
    tx.replacement_requests.create.mockResolvedValue({
      id: 77,
      leave_request_id: 55,
      requester_id: 100,
      replacement_staff_id: 101,
      dates: '{"start_date":"2026-06-01","end_date":"2026-06-02","days":2}',
      status: 'pending',
      requested_at: new Date('2026-05-28T00:00:00.000Z'),
    });
  });

  it('creates a linked replacement request when leave is applied with alternate cover', async () => {
    const result = await applyForLeave({
      staff_id: '11111111-2222-4333-8444-000000020100',
      leave_type: 'casual',
      start_date: '2026-06-01',
      end_date: '2026-06-02',
      reason: 'Family function',
      replacement_staff_id: '101',
      appliedBy: '11111111-2222-4333-8444-000000020100',
    });

    expect(prismaMock.leave_applications.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ['approved', 'APPROVED'] },
        }),
      })
    );
    expect(tx.leave_applications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'pending',
        }),
      })
    );
    expect(tx.replacement_requests.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          leave_request_id: 55,
          requester_id: 100,
          replacement_staff_id: 101,
          status: 'pending',
        }),
      })
    );
    expect(result.application.status).toBe('pending');
    expect(result.replacementRequest).toMatchObject({
      id: 77,
      leave_request_id: 55,
      replacement_staff_id: 101,
    });
  });
});
