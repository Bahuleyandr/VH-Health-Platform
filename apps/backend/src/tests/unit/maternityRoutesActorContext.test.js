import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const createPregnancyMock = jest.fn(async () => ({ id: 41 }));
const recordDeliveryMock = jest.fn(async () => ({ id: 73 }));

jest.unstable_mockModule('../../services/maternity/maternityService.js', () => ({
  createPregnancy: createPregnancyMock,
  recordDelivery: recordDeliveryMock,
}));

jest.unstable_mockModule('../../services/maternity/immunisationService.js', () => ({}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));

const { default: maternityRoutes } = await import('../../routes/maternity/maternityRoutes.js');

const ACTOR_UID = '11111111-1111-4111-8111-111111111111';
const PERFORMER_UID = '22222222-2222-4222-8222-222222222222';
const SPOOFED_UID = '99999999-9999-4999-8999-999999999999';

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = { uid: ACTOR_UID, role: 'NURSING_STAFF' };
  next();
});
app.use('/api/v1/maternity', maternityRoutes);

beforeEach(() => {
  createPregnancyMock.mockClear();
  recordDeliveryMock.mockClear();
});

describe('maternity mutation actor context', () => {
  test('pregnancy creation pins creator and canonical actor to the authenticated user', async () => {
    const response = await request(app)
      .post('/api/v1/maternity/pregnancies')
      .send({
        patient_uid: '33333333-3333-4333-8333-333333333333',
        created_by: SPOOFED_UID,
        actor_uid: SPOOFED_UID,
        actor_role: 'SUPER_ADMIN',
      });

    expect(response.statusCode).toBe(200);
    expect(createPregnancyMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: '00000000-0000-4000-8000-000000000001',
      created_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    }));
  });

  test('delivery preserves the named performer while auditing the authenticated submitter', async () => {
    const response = await request(app)
      .post('/api/v1/maternity/deliveries')
      .send({
        pregnancy_id: 9,
        delivery_datetime: '2026-06-18T04:15:00.000Z',
        delivery_mode: 'nvd',
        delivered_by: PERFORMER_UID,
        actor_uid: SPOOFED_UID,
        actor_role: 'SUPER_ADMIN',
      });

    expect(response.statusCode).toBe(200);
    expect(recordDeliveryMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: '00000000-0000-4000-8000-000000000001',
      delivered_by: PERFORMER_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    }));
  });
});
