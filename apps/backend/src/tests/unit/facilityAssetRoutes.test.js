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

jest.unstable_mockModule('../../services/facility/facilityAssetService.js', () => ({
  createFacilityAsset: createFacilityAssetMock,
  getFacilityAsset: jest.fn(),
  listFacilityAssetEvents: jest.fn(),
  listFacilityAssets: jest.fn(),
  recordFacilityAssetMaintenance: jest.fn(),
  transitionFacilityAssetStatus: jest.fn(),
  updateFacilityAsset: updateFacilityAssetMock,
  FACILITY_ASSET_CATEGORIES: ['generator'],
  FACILITY_ASSET_CONDITIONS: ['good', 'fair', 'poor'],
  FACILITY_ASSET_STATUSES: ['active', 'under_repair', 'condemned', 'disposed'],
}));

jest.unstable_mockModule('../../utils/logAudit.js', () => ({
  logAudit: jest.fn(),
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

const { default: router } = await import('../../routes/facility/facilityAssetRoutes.js');

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => {
    req.tenantId = '11111111-1111-4111-8111-111111111111';
    req.user = {
      uid: '22222222-2222-4222-8222-222222222222',
      role: 'ADMIN',
      rawRole: 'SUPER_ADMIN',
    };
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
});
