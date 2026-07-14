import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const createPregnancyMock = jest.fn(async () => ({ id: 41 }));
const recordAncVisitMock = jest.fn(async () => ({ id: 49 }));
const recordSupplementMock = jest.fn(async () => ({ id: 53 }));
const admitToLaborMock = jest.fn(async () => ({ id: 57 }));
const recordPartographEntryMock = jest.fn(async () => ({ id: 61 }));
const recordFetalKickMock = jest.fn(async () => ({ id: 67 }));
const recordDeliveryMock = jest.fn(async () => ({ id: 73 }));
const recordNewbornMock = jest.fn(async () => ({ id: 77, minted_identity: null }));
const getPregnancyMock = jest.fn(async () => ({
  id: 9,
  patient_uid: '33333333-3333-4333-8333-333333333333',
}));
const seedScheduleForNewbornMock = jest.fn(async () => ({ scheduled: 1 }));
const recordDoseMock = jest.fn(async () => ({ id: 91 }));
const markScheduleUpToDateMock = jest.fn(async () => ({ id: 92 }));

jest.unstable_mockModule('../../services/maternity/maternityService.js', () => ({
  createPregnancy: createPregnancyMock,
  recordAncVisit: recordAncVisitMock,
  recordSupplement: recordSupplementMock,
  admitToLabor: admitToLaborMock,
  recordPartographEntry: recordPartographEntryMock,
  recordFetalKick: recordFetalKickMock,
  recordDelivery: recordDeliveryMock,
  recordNewborn: recordNewbornMock,
  getPregnancy: getPregnancyMock,
}));

jest.unstable_mockModule('../../services/maternity/immunisationService.js', () => ({
  seedScheduleForNewborn: seedScheduleForNewbornMock,
  recordDose: recordDoseMock,
  markScheduleUpToDate: markScheduleUpToDateMock,
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));

const { default: maternityRoutes } = await import('../../routes/maternity/maternityRoutes.js');

const ACTOR_UID = '11111111-1111-4111-8111-111111111111';
const PERFORMER_UID = '22222222-2222-4222-8222-222222222222';
const SPOOFED_UID = '99999999-9999-4999-8999-999999999999';
let requestUser = { uid: ACTOR_UID, role: 'NURSING_STAFF' };

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = requestUser;
  next();
});
app.use('/api/v1/maternity', maternityRoutes);

beforeEach(() => {
  requestUser = { uid: ACTOR_UID, role: 'NURSING_STAFF' };
  createPregnancyMock.mockClear();
  recordAncVisitMock.mockClear();
  recordSupplementMock.mockClear();
  admitToLaborMock.mockClear();
  recordPartographEntryMock.mockClear();
  recordFetalKickMock.mockClear();
  recordDeliveryMock.mockClear();
  recordNewbornMock.mockClear();
  getPregnancyMock.mockClear();
  seedScheduleForNewbornMock.mockClear();
  recordDoseMock.mockClear();
  markScheduleUpToDateMock.mockClear();
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

  test('newborn record pins recorder and canonical actor to the authenticated user (D7 Shape-3)', async () => {
    const response = await request(app)
      .post('/api/v1/maternity/newborns')
      .send({
        delivery_id: 73,
        birth_datetime: '2026-07-12T03:20:00.000Z',
        recorded_by: SPOOFED_UID,
        actor_uid: SPOOFED_UID,
        actor_role: 'SUPER_ADMIN',
      });

    expect(response.statusCode).toBe(200);
    expect(recordNewbornMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: '00000000-0000-4000-8000-000000000001',
      recorded_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    }));
  });

  test('ANC visit pins recorder and canonical actor to the authenticated user', async () => {
    const response = await request(app)
      .post('/api/v1/maternity/anc-visits')
      .send({
        pregnancy_id: 9,
        visit_date: '2026-05-14',
        recorded_by: SPOOFED_UID,
        actor_uid: SPOOFED_UID,
        actor_role: 'SUPER_ADMIN',
      });

    expect(response.statusCode).toBe(200);
    expect(recordAncVisitMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: '00000000-0000-4000-8000-000000000001',
      recorded_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    }));
  });

  test('supplement recording pins prescriber and canonical actor to the authenticated user', async () => {
    const response = await request(app)
      .post('/api/v1/maternity/supplements')
      .send({
        pregnancy_id: 9,
        supplement: 'iron',
        prescribed_by: SPOOFED_UID,
        actor_uid: SPOOFED_UID,
        actor_role: 'SUPER_ADMIN',
      });

    expect(response.statusCode).toBe(200);
    expect(recordSupplementMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: '00000000-0000-4000-8000-000000000001',
      prescribed_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    }));
  });

  test('patient fetal-kick recording pins the patient actor despite spoofed body fields', async () => {
    requestUser = {
      uid: '33333333-3333-4333-8333-333333333333',
      role: 'PATIENT',
    };
    const response = await request(app)
      .post('/api/v1/maternity/fetal-kicks')
      .send({
        pregnancy_id: 9,
        kick_count: 8,
        recorded_by: SPOOFED_UID,
        actor_uid: SPOOFED_UID,
        actor_role: 'SUPER_ADMIN',
      });

    expect(response.statusCode).toBe(200);
    expect(getPregnancyMock).toHaveBeenCalledWith(expect.objectContaining({ id: 9 }));
    expect(recordFetalKickMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: '00000000-0000-4000-8000-000000000001',
      recorded_by: requestUser.uid,
      actor_uid: requestUser.uid,
      actor_role: 'PATIENT',
    }));
  });

  test('labour admission preserves the named obstetrician while auditing the authenticated submitter', async () => {
    const response = await request(app)
      .post('/api/v1/maternity/labor-admissions')
      .send({
        pregnancy_id: 8,
        attending_obstetrician: PERFORMER_UID,
        actor_uid: SPOOFED_UID,
        actor_role: 'SUPER_ADMIN',
      });

    expect(response.statusCode).toBe(200);
    expect(response.body.data).toEqual({ id: 57 });
    expect(admitToLaborMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: '00000000-0000-4000-8000-000000000001',
      attending_obstetrician: PERFORMER_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    }));
  });

  test('partograph recording pins recorder and canonical actor to the authenticated user', async () => {
    const response = await request(app)
      .post('/api/v1/maternity/partograph')
      .send({
        labor_admission_id: 12,
        recorded_by: SPOOFED_UID,
        actor_uid: SPOOFED_UID,
        actor_role: 'SUPER_ADMIN',
      });

    expect(response.statusCode).toBe(200);
    expect(response.body.data).toEqual({ id: 61 });
    expect(recordPartographEntryMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: '00000000-0000-4000-8000-000000000001',
      recorded_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    }));
  });

  test.each([
    ['/api/v1/maternity/labor-admissions', { pregnancy_id: 8 }, admitToLaborMock],
    ['/api/v1/maternity/partograph', { labor_admission_id: 12 }, recordPartographEntryMock],
  ])('preserves staff/admin authorization for %s', async (path, body, serviceMock) => {
    requestUser = { uid: ACTOR_UID, role: 'PATIENT' };

    const response = await request(app).post(path).send(body);

    expect(response.statusCode).toBe(403);
    expect(response.body.message).toBe('Staff or admin role required');
    expect(serviceMock).not.toHaveBeenCalled();
  });

  test('newborn seed and dose canonical actors are pinned to the authenticated user', async () => {
    const seedResponse = await request(app)
      .post('/api/v1/maternity/newborns/17/immunisations/seed')
      .send({ actor_uid: SPOOFED_UID, actor_role: 'SUPER_ADMIN' });
    const doseResponse = await request(app)
      .patch('/api/v1/maternity/immunisations/91/record')
      .send({
        status: 'given',
        given_by: SPOOFED_UID,
        given_by_name: 'Named nurse',
        actor_role: 'SUPER_ADMIN',
      });

    expect(seedResponse.statusCode).toBe(200);
    expect(doseResponse.statusCode).toBe(200);
    expect(seedScheduleForNewbornMock).toHaveBeenCalledWith(expect.objectContaining({
      newborn_id: '17',
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    }));
    expect(recordDoseMock).toHaveBeenCalledWith(expect.objectContaining({
      immunisation_id: '91',
      given_by: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    }));
  });

  test('up-to-date audit attribution uses the authenticated signer', async () => {
    const response = await request(app)
      .post('/api/v1/maternity/immunisations/up-to-date')
      .send({
        patient_uid: '33333333-3333-4333-8333-333333333333',
        signed_by: SPOOFED_UID,
        actor_role: 'SUPER_ADMIN',
      });

    expect(response.statusCode).toBe(200);
    expect(markScheduleUpToDateMock).toHaveBeenCalledWith(expect.objectContaining({
      signed_by: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    }));
  });
});
