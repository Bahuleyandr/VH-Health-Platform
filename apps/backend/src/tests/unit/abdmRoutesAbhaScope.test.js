import express from 'express';
import request from 'supertest';
import { jest } from '@jest/globals';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const TENANT = '00000000-0000-4000-8000-000000000001';

const registerABHAMock = jest.fn(async () => ({
  linked: true,
  abhaNumber: '12-3456-7890-12',
  abhaAddress: null,
}));

jest.unstable_mockModule('../../services/abdm/abdmService.js', () => ({
  default: {
    registerABHA: registerABHAMock,
    getPatientByABHA: jest.fn(),
    getAdminStatus: jest.fn(),
    listConsentRequests: jest.fn(),
  },
}));

const logPhiAccessMock = jest.fn();
jest.unstable_mockModule('../../utils/hipaaAudit.js', () => ({
  logPhiAccess: logPhiAccessMock,
}));

jest.unstable_mockModule('../../config/abdmConfig.js', () => ({
  ABDM_CONFIG: {
    enabled: false,
    hipId: 'HIP-1',
    hipName: 'VH Health',
  },
}));

jest.unstable_mockModule('../../utils/signedRequest.js', () => ({
  verifySignedRequest: jest.fn(() => ({ ok: true })),
  assertSharedReplayOnce: jest.fn().mockResolvedValue(true),
}));

const { patientRouter } = await import('../../routes/abdm/abdmRoutes.js');

function buildApp(role) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantId = TENANT;
    req.user = { uid: ACTOR, role };
    next();
  });
  app.use('/abdm', patientRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('ABDM ABHA route scope', () => {
  it('blocks broad staff from linking ABHA for another patient UID', async () => {
    const res = await request(buildApp('DOCTOR'))
      .post('/abdm/register-abha')
      .send({ patient_uid: OTHER, abha_number: '12-3456-7890-12' });

    expect(res.status).toBe(403);
    expect(registerABHAMock).not.toHaveBeenCalled();
  });

  it('passes tenant-scoped target UID for admin ABHA linking', async () => {
    const res = await request(buildApp('ADMIN'))
      .post('/abdm/register-abha')
      .send({ patient_uid: OTHER, abha_number: '12-3456-7890-12', abha_address: 'patient@abdm' });

    expect(res.status).toBe(200);
    expect(registerABHAMock).toHaveBeenCalledWith(OTHER, '12-3456-7890-12', 'patient@abdm', {
      tenantId: TENANT,
    });
  });
});

// P13: the patient app POSTed an ABDM *enrolment* payload at this *linkage*
// endpoint, so every call 400'd with nothing describing why. These pin the body
// the endpoint actually accepts.
describe('ABDM register-abha request contract', () => {
  it('links for self from the JWT when no patient_uid is supplied', async () => {
    const res = await request(buildApp('PATIENT'))
      .post('/abdm/register-abha')
      .send({ abha_number: '12-3456-7890-12' });

    expect(res.status).toBe(200);
    expect(registerABHAMock).toHaveBeenCalledWith(ACTOR, '12-3456-7890-12', undefined, {
      tenantId: TENANT,
    });
  });

  it('returns the linkage shape rather than the patient row', async () => {
    const res = await request(buildApp('PATIENT'))
      .post('/abdm/register-abha')
      .send({ abha_number: '12-3456-7890-12' });

    expect(res.body.data).toEqual({
      linked: true,
      abhaNumber: '12-3456-7890-12',
      abhaAddress: null,
    });
    // The user row carries name/phone/tenant_id the caller never asked for.
    expect(res.body.data).not.toHaveProperty('phone');
    expect(res.body.data).not.toHaveProperty('name');
    expect(res.body.data).not.toHaveProperty('tenant_id');
  });

  it('rejects the old enrolment payload instead of half-accepting it', async () => {
    const res = await request(buildApp('PATIENT'))
      .post('/abdm/register-abha')
      .send({
        mobile: '+919000000001',
        name: 'Test Patient',
        yearOfBirth: '1990',
        gender: 'M',
        email: 'test@example.com',
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/ABHA number is required/i);
    expect(registerABHAMock).not.toHaveBeenCalled();
  });

  it('treats a whitespace-only ABHA number as absent', async () => {
    const res = await request(buildApp('PATIENT'))
      .post('/abdm/register-abha')
      .send({ abha_number: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/ABHA number is required/i);
    expect(registerABHAMock).not.toHaveBeenCalled();
  });

  it('records the linkage write to the PHI access log', async () => {
    await request(buildApp('PATIENT'))
      .post('/abdm/register-abha')
      .send({ abha_number: '12-3456-7890-12' });

    expect(logPhiAccessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: ACTOR,
        patientId: ACTOR,
        recordType: 'abha_linkage',
        action: 'UPDATE',
        tenantId: TENANT,
      }),
    );
  });

  it('does not log PHI access when the request never reached the service', async () => {
    await request(buildApp('PATIENT')).post('/abdm/register-abha').send({});

    expect(logPhiAccessMock).not.toHaveBeenCalled();
  });
});
