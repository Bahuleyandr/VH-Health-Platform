import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const setSettingsMock = jest.fn(async (input) => input);
const createActivationMock = jest.fn(async (input) => input);
const recordPathwayEventMock = jest.fn(async (input) => input);

jest.unstable_mockModule('../../services/clinical/stemiPathwayService.js', () => ({
  acknowledgeActivation: jest.fn(),
  createActivation: createActivationMock,
  getActivation: jest.fn(),
  getStemiPathwaySettings: jest.fn(),
  listActivations: jest.fn(),
  recordActivationDoorTime: jest.fn(),
  recordPathwayEvent: recordPathwayEventMock,
  setStemiPathwaySettings: setSettingsMock,
  updateActivationStatus: jest.fn(),
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => 'trusted-tenant',
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

const { default: router } = await import('../../routes/clinical/stemiPathwayRoutes.js');
const { STEMI_ROUTE_ROLES } = await import('../../config/routeRolePolicy.js');

function app(role = 'DOCTOR') {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => {
    req.user = {
      uid: '11111111-1111-4111-8111-111111111111',
      role,
    };
    next();
  });
  instance.use('/api/v1/stemi-pathway', router);
  return instance;
}

describe('STEMI pathway trusted request context', () => {
  beforeEach(() => jest.clearAllMocks());

  it('keeps owner settings changes administrator-only', async () => {
    const response = await request(app())
      .patch('/api/v1/stemi-pathway/settings')
      .send({ tenantId: 'spoofed', actorUid: 'spoofed', enabled: false });

    expect(response.status).toBe(403);
    expect(setSettingsMock).not.toHaveBeenCalled();
  });

  it.each(STEMI_ROUTE_ROLES)(
    'admits the %s role accepted by the outer STEMI role policy',
    async (role) => {
      const response = await request(app(role))
        .get('/api/v1/stemi-pathway/settings');

      expect(response.status).toBe(200);
    },
  );

  it.each(['ADMIN', 'SUPER_ADMIN'])(
    'uses trusted identity for %s settings changes',
    async (role) => {
      const response = await request(app(role))
      .patch('/api/v1/stemi-pathway/settings')
      .send({ tenantId: 'spoofed', actorUid: 'spoofed', enabled: false });

      expect(response.status).toBe(200);
      expect(setSettingsMock).toHaveBeenCalledWith(expect.objectContaining({
        tenantId: 'trusted-tenant',
        actorUid: '11111111-1111-4111-8111-111111111111',
      }));
    },
  );

  it('does not let activation body fields override tenant or actor identity', async () => {
    const response = await request(app())
      .post('/api/v1/stemi-pathway/activations')
      .send({
        tenantId: 'spoofed',
        actorUid: 'spoofed',
        actorRole: 'SUPER_ADMIN',
        patient_uid: '22222222-2222-4222-8222-222222222222',
      });

    expect(response.status).toBe(200);
    expect(createActivationMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'trusted-tenant',
      actorUid: '11111111-1111-4111-8111-111111111111',
      actorRole: 'DOCTOR',
    }));
  });

  it('does not let event body fields override tenant, activation, or actor identity', async () => {
    const response = await request(app())
      .post('/api/v1/stemi-pathway/activations/41/events')
      .send({
        tenantId: 'spoofed',
        activationId: 999,
        actorUid: 'spoofed',
        actorRole: 'SUPER_ADMIN',
        event_type: 'ecg_acquired',
      });

    expect(response.status).toBe(200);
    expect(recordPathwayEventMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'trusted-tenant',
      activationId: '41',
      actorUid: '11111111-1111-4111-8111-111111111111',
      actorRole: 'DOCTOR',
    }));
  });
});
