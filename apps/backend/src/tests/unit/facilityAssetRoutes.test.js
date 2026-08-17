import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const createFacilityAssetMock = jest.fn(async () => ({
  id: 7,
  assetTag: 'GEN-02',
  name: 'Generator',
  version: 1,
}));
const updateFacilityAssetMock = jest.fn();
const transitionFacilityAssetStatusMock = jest.fn(async () => ({
  id: 7,
  assetTag: 'GEN-02',
  status: 'under_repair',
  version: 2,
}));
const listFacilityAssetCustodiansMock = jest.fn(async () => ({
  custodians: [],
  limit: 50,
}));
const listFacilityAssetEventsMock = jest.fn(async () => ({
  events: [],
  total: 0,
  limit: 50,
  offset: 0,
}));
const logAuditMock = jest.fn();

jest.unstable_mockModule('../../services/facility/facilityAssetService.js', () => ({
  createFacilityAsset: createFacilityAssetMock,
  getFacilityAsset: jest.fn(),
  listFacilityAssetCustodians: listFacilityAssetCustodiansMock,
  listFacilityAssetEvents: listFacilityAssetEventsMock,
  listFacilityAssets: jest.fn(),
  recordFacilityAssetMaintenance: jest.fn(),
  transitionFacilityAssetStatus: transitionFacilityAssetStatusMock,
  updateFacilityAsset: updateFacilityAssetMock,
  FACILITY_ASSET_CATEGORIES: ['generator'],
  FACILITY_ASSET_CONDITIONS: ['good', 'fair', 'poor'],
  FACILITY_ASSET_STATUSES: ['active', 'under_repair', 'condemned', 'disposed'],
}));

jest.unstable_mockModule('../../utils/logAudit.js', () => ({
  logAudit: logAuditMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

const { default: router } = await import('../../routes/facility/facilityAssetRoutes.js');

function app({ acting = null } = {}) {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => {
    req.tenantId = '11111111-1111-4111-8111-111111111111';
    req.user = {
      uid: '22222222-2222-4222-8222-222222222222',
      role: 'ADMIN',
      rawRole: 'SUPER_ADMIN',
    };
    req.acting = acting;
    next();
  });
  instance.use('/api/v1/facility/assets', router);
  return instance;
}

describe('facility asset route actor provenance', () => {
  beforeEach(() => jest.clearAllMocks());

  it('preserves the authenticated SUPER_ADMIN raw role in durable events', async () => {
    const response = await request(app())
      .post('/api/v1/facility/assets')
      .send({ assetTag: 'GEN-02', name: 'Generator', category: 'generator' });

    expect(response.status).toBe(201);
    expect(createFacilityAssetMock).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      expect.objectContaining({ assetTag: 'GEN-02' }),
      {
        actorUid: '22222222-2222-4222-8222-222222222222',
        actorRole: 'SUPER_ADMIN',
      },
    );
    const auditRequest = logAuditMock.mock.calls[0][0];
    expect(auditRequest.user).toMatchObject({
      uid: '22222222-2222-4222-8222-222222222222',
      role: 'SUPER_ADMIN',
    });
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.any(Object),
      'facility-asset-create',
      { asset_tag: 'GEN-02' },
      { resource: 'facility_asset', resourceId: 7 },
    );
  });

  it('uses the original acting-as identity and raw role in both audit trails', async () => {
    const actorUid = '33333333-3333-4333-8333-333333333333';
    const response = await request(app({
      acting: {
        actorUid,
        actorRole: 'ADMIN',
        actorRawRole: 'SUPER_ADMIN',
      },
    }))
      .post('/api/v1/facility/assets')
      .send({ assetTag: 'GEN-02', name: 'Generator', category: 'generator' });

    expect(response.status).toBe(201);
    expect(createFacilityAssetMock).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      expect.objectContaining({ assetTag: 'GEN-02' }),
      { actorUid, actorRole: 'SUPER_ADMIN' },
    );
    const auditRequest = logAuditMock.mock.calls[0][0];
    expect(auditRequest.acting).toMatchObject({
      actorUid,
      actorRole: 'SUPER_ADMIN',
    });
    expect(auditRequest.user.uid).toBe('22222222-2222-4222-8222-222222222222');
  });

  it('lists tenant-scoped custodian choices before the /:id route', async () => {
    const response = await request(app())
      .get('/api/v1/facility/assets/custodians?q=maya&limit=50');

    expect(response.status).toBe(200);
    expect(listFacilityAssetCustodiansMock).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      { q: 'maya', limit: '50' },
    );
  });

  it('requires the optimistic-concurrency version on master edits', async () => {
    const response = await request(app())
      .patch('/api/v1/facility/assets/7')
      .send({ name: 'Unversioned edit' });

    expect(response.status).toBe(400);
    expect(response.body.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'expectedVersion' }),
    ]));
    expect(updateFacilityAssetMock).not.toHaveBeenCalled();
  });

  it('requires and forwards the optimistic-concurrency version on lifecycle transitions', async () => {
    const response = await request(app())
      .post('/api/v1/facility/assets/7/status')
      .send({ expectedVersion: 1, toStatus: 'under_repair', notes: 'Repair needed' });

    expect(response.status).toBe(200);
    expect(transitionFacilityAssetStatusMock).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      '7',
      {
        expectedVersion: 1,
        toStatus: 'under_repair',
        reason: undefined,
        notes: 'Repair needed',
      },
      {
        actorUid: '22222222-2222-4222-8222-222222222222',
        actorRole: 'SUPER_ADMIN',
      },
    );
  });

  it('rejects an unversioned lifecycle transition before calling the service', async () => {
    const response = await request(app())
      .post('/api/v1/facility/assets/7/status')
      .send({ toStatus: 'disposed', reason: 'Retired' });

    expect(response.status).toBe(400);
    expect(response.body.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'expectedVersion' }),
    ]));
    expect(transitionFacilityAssetStatusMock).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range lifecycle version before calling the service', async () => {
    const response = await request(app())
      .post('/api/v1/facility/assets/7/status')
      .send({ expectedVersion: 2147483648, toStatus: 'under_repair' });

    expect(response.status).toBe(400);
    expect(response.body.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'expectedVersion' }),
    ]));
    expect(transitionFacilityAssetStatusMock).not.toHaveBeenCalled();
  });

  it('validates and bounds event pagination before calling the service', async () => {
    const excessiveLimit = await request(app())
      .get('/api/v1/facility/assets/7/events?limit=201');
    const excessiveOffset = await request(app())
      .get('/api/v1/facility/assets/7/events?offset=2147483648');

    expect(excessiveLimit.status).toBe(400);
    expect(excessiveOffset.status).toBe(400);
    expect(listFacilityAssetEventsMock).not.toHaveBeenCalled();

    const valid = await request(app())
      .get('/api/v1/facility/assets/7/events?limit=200&offset=2147483647');
    expect(valid.status).toBe(200);
    expect(listFacilityAssetEventsMock).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      '7',
      { limit: '200', offset: '2147483647' },
    );
  });
});
