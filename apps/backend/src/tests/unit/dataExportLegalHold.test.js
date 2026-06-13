import express from 'express';
import request from 'supertest';
import { jest } from '@jest/globals';

const prismaMock = {
  $queryRawUnsafe: jest.fn(),
};
const checkLegalHoldMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  setTenantTx: async (_tenantId, fn) => fn(prismaMock),
  setTenant: async (_tenantId, fn) => fn(prismaMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(prismaMock),
  pickTenantClient: () => prismaMock,
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

jest.unstable_mockModule('../../services/gdpr/dataErasureService.js', () => ({
  checkLegalHold: checkLegalHoldMock,
}));

const { default: dataExportRoutes } = await import('../../routes/dataExportRoutes.js');

const TENANT = '00000000-0000-4000-8000-000000000777';
const PATIENT_UID = '11111111-1111-4111-8111-111111111111';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { uid: PATIENT_UID, tenant_id: TENANT };
    next();
  });
  app.use('/data-export', dataExportRoutes);
  return app;
}

afterEach(() => {
  prismaMock.$queryRawUnsafe.mockReset();
  checkLegalHoldMock.mockReset();
});

describe('self-service data export erasure legal hold', () => {
  it('returns 403 and performs no soft-delete when legal hold is active', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([{
      id: 12,
      uid: PATIENT_UID,
      phone: '+15550000000',
      tenant_id: TENANT,
    }]);
    checkLegalHoldMock.mockResolvedValueOnce({ hasHold: true, holds: [{ id: 9 }] });

    const response = await request(buildApp())
      .delete('/data-export/my-data')
      .expect(403);

    expect(response.body).toEqual({
      error: 'Cannot erase: user has an active legal hold',
      code: 'LEGAL_HOLD_ACTIVE',
    });
    expect(checkLegalHoldMock).toHaveBeenCalledWith(PATIENT_UID, { tenantId: TENANT });
    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(String(prismaMock.$queryRawUnsafe.mock.calls[0][0])).toMatch(/tenant_id = \$2::uuid/i);
  });
});
