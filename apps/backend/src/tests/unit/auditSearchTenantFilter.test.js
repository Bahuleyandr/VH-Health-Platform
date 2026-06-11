import express from 'express';
import request from 'supertest';
import { jest } from '@jest/globals';

const prismaMock = {
  $queryRawUnsafe: jest.fn(),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.unstable_mockModule('../../services/security/accessDecisionService.js', () => ({
  deriveTenantIdFromRequest: (req) => req.user?.tenant_id,
}));

const { default: auditSearchRoutes } = await import('../../routes/compliance/auditSearchRoutes.js');

const TENANT = '00000000-0000-4000-8000-000000000777';
const PATIENT_UID = '11111111-1111-4111-8111-111111111111';

function buildApp() {
  const app = express();
  app.use((req, _res, next) => {
    req.user = { tenant_id: TENANT };
    next();
  });
  app.use('/compliance', auditSearchRoutes);
  return app;
}

afterEach(() => {
  prismaMock.$queryRawUnsafe.mockReset();
});

describe('compliance audit search tenant filtering', () => {
  it('requires metadata tenant_id and exact metadata patient_uid filters', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ total: '1' }])
      .mockResolvedValueOnce([{
        id: 1,
        user_id: 'staff-1',
        metadata: { tenant_id: TENANT, patient_uid: PATIENT_UID },
      }]);

    const response = await request(buildApp())
      .get(`/compliance/audit/search?patient_uid=${PATIENT_UID}&staff_uid=staff-1&page=2&limit=25`)
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledTimes(2);

    const [countSql, ...countParams] = prismaMock.$queryRawUnsafe.mock.calls[0];
    expect(String(countSql)).toMatch(/metadata->>'tenant_id' = \$1/i);
    expect(String(countSql)).toMatch(/metadata->>'patient_uid'/i);
    expect(String(countSql)).toMatch(/metadata->>'patient_id'/i);
    expect(String(countSql)).not.toMatch(/request_summary\s+LIKE/i);
    expect(countParams[0]).toBe(TENANT);
    expect(countParams).toContain(PATIENT_UID);

    const [selectSql, ...selectParams] = prismaMock.$queryRawUnsafe.mock.calls[1];
    expect(String(selectSql)).toMatch(/metadata->>'tenant_id' = \$1/i);
    expect(selectParams[0]).toBe(TENANT);
    expect(selectParams).toContain(25);
    expect(selectParams).toContain(25);
  });
});
