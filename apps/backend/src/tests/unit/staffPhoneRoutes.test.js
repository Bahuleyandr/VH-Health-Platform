import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const queryRawUnsafe = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryRawUnsafe,
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
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.unstable_mockModule('../../config/rolePolicyGraph.js', () => ({
  getRolePolicyHash: () => 'test-policy-hash',
  getRolePolicyVersion: () => 'test-policy-version',
}));

const router = (await import('../../routes/staff/phoneRoutes.js')).default;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      id: 22,
      uid: '93fc7713-e23c-40b8-8d2e-174a13faa2ce',
      role: 'NURSING_STAFF',
      tenant_id: '00000000-0000-4000-8000-000000000001',
    };
    next();
  });
  app.use('/staff', router);
  return app;
}

beforeEach(() => {
  queryRawUnsafe.mockReset();
});

describe('staff phone routes', () => {
  it('returns local display time for the phone home attendance summary', async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([
        {
          id: 2,
          attendance_status: null,
          check_in_time: new Date('2026-06-12T19:41:01.771Z'),
          check_out_time: null,
          local_check_in_time: '2026-06-13T01:11:01.771',
          local_check_out_time: null,
          location: '{"withinCampus":true}',
        },
      ])
      .mockResolvedValueOnce([{ count: 20 }])
      .mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValueOnce([{ count: 0 }]);

    const res = await request(makeApp()).get('/staff/phone/home');

    const attendanceSql = queryRawUnsafe.mock.calls[0][0];
    expect(attendanceSql).toContain("AT TIME ZONE 'UTC'");
    expect(res.statusCode).toBe(200);
    expect(res.body.data.attendance).toMatchObject({
      id: 2,
      status: 'checked_in',
      is_checked_in: true,
      check_in_time: '2026-06-13T01:11:01.771',
      check_out_time: null,
    });
    expect(res.body.data.shift.status).toBe('on_duty');
  });

  it('returns an error instead of zero counts when a home query fails', async () => {
    queryRawUnsafe.mockRejectedValue(new Error('staff home database unavailable'));

    const res = await request(makeApp()).get('/staff/phone/home');

    expect(res.statusCode).toBe(500);
    expect(res.body.success).toBe(false);
  });
});
