import express from 'express';
import request from 'supertest';
import { jest } from '@jest/globals';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const TENANT = '00000000-0000-4000-8000-000000000001';

const registerABHAMock = jest.fn(async () => ({ uid: OTHER }));

jest.unstable_mockModule('../../services/abdm/abdmService.js', () => ({
  default: {
    registerABHA: registerABHAMock,
    getPatientByABHA: jest.fn(),
    getAdminStatus: jest.fn(),
    listConsentRequests: jest.fn(),
  },
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
