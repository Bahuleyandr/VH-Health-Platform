import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// Regression coverage for audit follow-up P14: the ABDM patient-facing
// surface (verify-abha, patient-by-abha, consent-requests, consents*) now
// sits behind phiAccessLoggerForPaths in app.js, matching the platform-wide
// PHI-access-logging convention. /status stays excluded — it is an
// admin/staff connectivity + aggregate-count dashboard with no
// patient-identifying data, i.e. the "pure config/health" carve-out.
// /register-abha is also excluded — PR #809 (audit follow-up P13) already
// logs that write explicitly at the controller level, so a route-level
// mount here would double-log every successful link.

const TENANT = '00000000-0000-4000-8000-000000000001';
const ACTOR = '11111111-1111-4111-8111-111111111111';
const PATIENT_UID = '22222222-2222-4222-8222-222222222222';

const logPhiAccessMock = jest.fn();
const getPatientByABHAMock = jest.fn();
const grantConsentMock = jest.fn();
const getAdminStatusMock = jest.fn();

jest.unstable_mockModule('../../utils/hipaaAudit.js', () => ({
  logPhiAccess: logPhiAccessMock,
}));

jest.unstable_mockModule('../../services/abdm/abdmService.js', () => ({
  default: {
    registerABHA: jest.fn(),
    getPatientByABHA: getPatientByABHAMock,
    getAdminStatus: getAdminStatusMock,
    listConsentRequests: jest.fn(),
    getPatientConsents: jest.fn(),
    grantConsent: grantConsentMock,
    denyConsent: jest.fn(),
    revokeConsent: jest.fn(),
  },
}));

const { phiAccessLoggerForPaths } = await import('../../middleware/conditionalPhiAccessMiddleware.js');
const { patientRouter } = await import('../../routes/abdm/abdmRoutes.js');

// Mirrors the ABDM_PHI_PATHS list mounted ahead of abdmPatientRoutes in
// app.js (suffixes only — this app mounts the router at /abdm, not
// /api/v1/abdm, matching abdmRoutesAppErrorPropagation.test.js).
// register-abha is deliberately absent — PR #809 logs that write explicitly
// at the controller level; a route-level mount would double-log it.
const ABDM_PHI_PATHS = [
  '/abdm/verify-abha',
  '/abdm/patient-by-abha',
  '/abdm/consent-requests',
  '/abdm/consents',
];

function buildApp(user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.id = 'test-request-id';
    req.tenantId = TENANT;
    req.user = user;
    next();
  });
  app.use('/abdm', phiAccessLoggerForPaths('ABDM', ABDM_PHI_PATHS), patientRouter);
  return app;
}

beforeEach(() => {
  logPhiAccessMock.mockReset();
  getPatientByABHAMock.mockReset();
  grantConsentMock.mockReset();
  getAdminStatusMock.mockReset();
});

describe('ABDM PHI access logging (audit follow-up P14)', () => {
  test('GET /patient-by-abha/:abhaNumber logs a VIEW attributed to the resolved patient', async () => {
    getPatientByABHAMock.mockResolvedValue({
      uid: PATIENT_UID,
      name: 'Test Patient',
      abha_number: '91234567890123',
    });

    const response = await request(buildApp({ uid: ACTOR, role: 'ADMIN' }))
      .get('/abdm/patient-by-abha/91234567890123');

    expect(response.statusCode).toBe(200);
    expect(logPhiAccessMock).toHaveBeenCalledTimes(1);
    expect(logPhiAccessMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: ACTOR,
      userRole: 'ADMIN',
      patientId: PATIENT_UID,
      recordType: 'ABDM',
      action: 'VIEW',
      requestId: 'test-request-id',
      tenantId: TENANT,
    }));
  });

  test('POST /consents/:id/grant logs a mutation attributed to the acting patient', async () => {
    grantConsentMock.mockResolvedValue({ id: 1, consent_id: 'c-1', status: 'GRANTED' });

    const response = await request(buildApp({ uid: ACTOR, role: 'PATIENT' }))
      .post('/abdm/consents/c-1/grant')
      .send({});

    expect(response.statusCode).toBe(200);
    expect(grantConsentMock).toHaveBeenCalledWith('c-1', ACTOR);
    expect(logPhiAccessMock).toHaveBeenCalledTimes(1);
    expect(logPhiAccessMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: ACTOR,
      subjectUid: ACTOR,
      recordType: 'ABDM',
      action: 'CREATE', // POST maps to CREATE regardless of REST verb semantics — see deriveAction()
      tenantId: TENANT,
    }));
  });

  test('GET /status is excluded — admin/staff dashboard aggregate, no patient PHI', async () => {
    getAdminStatusMock.mockResolvedValue({
      connected: true,
      abha_registrations: 12,
      consent_requests_total: 3,
    });

    const response = await request(buildApp({ uid: ACTOR, role: 'ADMIN' }))
      .get('/abdm/status');

    expect(response.statusCode).toBe(200);
    expect(getAdminStatusMock).toHaveBeenCalledTimes(1);
    expect(logPhiAccessMock).not.toHaveBeenCalled();
  });
});
