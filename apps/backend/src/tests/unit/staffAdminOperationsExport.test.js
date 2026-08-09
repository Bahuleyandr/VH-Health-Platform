import { jest } from '@jest/globals';

const prismaMock = { $queryRawUnsafe: jest.fn() };
jest.unstable_mockModule('../../lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const { exportStaffData } = await import('../../controllers/staff/staffAdminOperationsController.js');

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    sent: null,
    req: { id: 'req-1' },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    setHeader(k, v) { this.headers[k] = v; },
    send(payload) { this.sent = payload; return this; },
  };
}

function mockReq(type, query = {}) {
  return { params: { type }, query: { format: 'csv', ...query }, user: { uid: 'admin-1' } };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('exportStaffData', () => {
  it('still exports real attendance CSV (regression guard)', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([
      { employee_id: 'E1', name: 'Jane', department: 'ICU', check_in_time: '2026-08-01', check_in: '09:00', check_out: '17:00', hours_worked: 8 },
    ]);
    const res = mockRes();

    await exportStaffData(mockReq('attendance'), res);

    expect(res.headers['Content-Type']).toBe('text/csv');
    expect(res.sent).toContain('Jane');
    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  });

  it.each(['performance', 'leave', 'payroll'])(
    'honestly reports Not Implemented for %s export instead of a fake placeholder string',
    async (type) => {
      const res = mockRes();

      await exportStaffData(mockReq(type), res);

      expect(res.statusCode).toBe(501);
      expect(res.body.success).toBe(false);
      expect(res.sent).toBeNull();
      expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
    }
  );

  it('still rejects an unknown export type with 400 (regression guard)', async () => {
    const res = mockRes();

    await exportStaffData(mockReq('bogus'), res);

    expect(res.statusCode).toBe(400);
  });
});
