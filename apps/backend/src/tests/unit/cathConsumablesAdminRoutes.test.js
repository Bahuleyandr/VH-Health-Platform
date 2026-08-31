import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const upsertCatalogMock = jest.fn(async (input) => ({ id: 1, tenant_id: input.tenantId }));
const upsertSettingsMock = jest.fn(async (input) => ({ tenant_id: input.tenantId }));
const resolveRecoveryMock = jest.fn(async (input) => ({ id: input.recoveryId, status: 'RESOLVED' }));
const listUnbilledMock = jest.fn(async () => ({
  items: [], count: 0, total: 0, page: 1, limit: 50, total_pages: 0,
}));

jest.unstable_mockModule('../../services/clinical/cathLabService.js', () => ({
  getCathConsumablesBillingSettings: jest.fn(),
  listConsumableCatalog: jest.fn(),
  listUnbilledConsumableUsage: listUnbilledMock,
  resolveCathConsumableAuthorityRecovery: resolveRecoveryMock,
  upsertCathConsumablesBillingSettings: upsertSettingsMock,
  upsertConsumableCatalogItem: upsertCatalogMock,
}));

jest.unstable_mockModule('../../middleware/idempotencyMiddleware.js', () => ({
  requireIdempotencyKey: () => (req, res, next) => {
    const requestKey = req.get('idempotency-key');
    if (!requestKey) {
      return res.status(400).json({ success: false, code: 'IDEMPOTENCY_KEY_REQUIRED' });
    }
    req.idempotencyClaim = {
      id: 17,
      requestKey,
      requestBodyHash: 'a'.repeat(64),
    };
    return next();
  },
}));

jest.unstable_mockModule('../../middleware/phiAccessMiddleware.js', () => ({
  phiAccessLogger: () => (_req, _res, next) => next(),
}));

const { default: cathConsumablesRoutes } = await import(
  '../../routes/admin/cathConsumablesRoutes.js'
);

const TENANT = '00000000-0000-4000-8000-000000000001';
const OTHER_TENANT = '00000000-0000-4000-8000-000000000099';

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.tenantId = TENANT;
  req.user = {
    uid: '11111111-1111-4111-8111-111111111111',
    role: 'ADMIN',
  };
  next();
});
app.use('/api/v1/admin/cath-consumables', cathConsumablesRoutes);

beforeEach(() => {
  upsertCatalogMock.mockClear();
  upsertSettingsMock.mockClear();
  listUnbilledMock.mockClear();
  resolveRecoveryMock.mockClear();
});

describe('cath consumables admin tenant boundary', () => {
  test('pins catalog writes to the authenticated tenant', async () => {
    const response = await request(app)
      .put('/api/v1/admin/cath-consumables/catalog')
      .set('Idempotency-Key', 'catalog-command-1')
      .send({ tenantId: OTHER_TENANT, item_name: 'Stent', category: 'stent' });

    expect(response.statusCode).toBe(200);
    expect(upsertCatalogMock).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, item_name: 'Stent' }),
      expect.objectContaining({ actorRole: 'ADMIN' }),
    );
  });

  test('requires durable command evidence and pins governed recovery to the tenant', async () => {
    const missingKey = await request(app)
      .post('/api/v1/admin/cath-consumables/authority-recovery/42/resolve')
      .send({ resolution: { action: 'PRESERVE', facility_id: 4 }, resolution_note: 'Reviewed' });
    expect(missingKey.statusCode).toBe(400);
    expect(resolveRecoveryMock).not.toHaveBeenCalled();

    const response = await request(app)
      .post('/api/v1/admin/cath-consumables/authority-recovery/42/resolve')
      .set('Idempotency-Key', 'cath-recovery-command-42')
      .send({
        tenantId: OTHER_TENANT,
        resolution: { action: 'PRESERVE', facility_id: 4 },
        resolution_note: 'Reviewed against source custody',
      });

    expect(response.statusCode).toBe(200);
    expect(resolveRecoveryMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      recoveryId: '42',
      commandKey: 'cath-recovery-command-42',
      requestFingerprint: 'a'.repeat(64),
      note: 'Reviewed against source custody',
      resolution: { action: 'PRESERVE', facility_id: 4 },
    }));
  });

  test('pins billing settings writes to the authenticated tenant', async () => {
    const response = await request(app)
      .put('/api/v1/admin/cath-consumables/billing-settings')
      .send({ tenantId: OTHER_TENANT, charge_enabled: false });

    expect(response.statusCode).toBe(200);
    expect(upsertSettingsMock).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, charge_enabled: false }),
      expect.objectContaining({ actorRole: 'ADMIN' }),
    );
  });

  test('passes pagination through and returns the accurate unbilled total', async () => {
    listUnbilledMock.mockResolvedValueOnce({
      items: [{ usage_id: 9 }], count: 1, total: 101, page: 3, limit: 50, total_pages: 3,
    });
    const response = await request(app)
      .get('/api/v1/admin/cath-consumables/unbilled-usage?page=3&limit=50');

    expect(response.statusCode).toBe(200);
    expect(listUnbilledMock).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, page: '3', limit: '50' }),
    );
    expect(response.body.data).toMatchObject({ total: 101, page: 3, total_pages: 3 });
  });
});
