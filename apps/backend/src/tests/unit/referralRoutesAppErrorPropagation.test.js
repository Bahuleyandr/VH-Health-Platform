import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for referralRoutes.js (relayAppError port).
//
// Every catch in referralRoutes.js guards on `err.isOperational` and relayed
// AppErrors via `error(res, err.message, err.statusCode)` with no 4th arg,
// dropping `err.code` and `err.details` on the wire. The port swaps only the
// operational branch for the shared relay (responseHelper.relayAppError) and
// keeps the non-operational tail (logger + next(err)) byte-identical — these
// are gateway surfaces where global-handler/Sentry visibility is deliberate.

const acceptReferralMock = jest.fn();
const acceptClosedLoopReferralMock = jest.fn();
const createReferralMock = jest.fn();
const createClosedLoopReferralMock = jest.fn();
const getIncomingReferralsMock = jest.fn();
const getPatientReferralsMock = jest.fn();
const isInternalReferralMock = jest.fn();
let referralPathwayMode = 'off';

jest.unstable_mockModule('../../services/pathways/pathwayMode.js', () => ({
  CARE_PATHWAY_KEYS: { REFERRAL: 'referral_request_to_closure' },
  PATHWAY_MODES: { OFF: 'off', SHADOW: 'shadow', ACTIVE: 'active' },
  resolvePathwayMode: jest.fn(async () => referralPathwayMode),
}));

jest.unstable_mockModule('../../services/referral/referralService.js', () => ({
  default: {
    createReferral: createReferralMock,
    getIncomingReferrals: getIncomingReferralsMock,
    getOutgoingReferrals: jest.fn(),
    searchConsultants: jest.fn(),
    getReferralAudit: jest.fn(),
    isInternalReferral: isInternalReferralMock,
    markReferralSeen: jest.fn(),
    acceptReferral: acceptReferralMock,
    completeReferral: jest.fn(),
    declineReferral: jest.fn(),
    getPatientReferrals: getPatientReferralsMock,
  },
}));

jest.unstable_mockModule('../../services/referral/referralClosedLoopService.js', () => ({
  acceptClosedLoopReferral: acceptClosedLoopReferralMock,
  closeReferralByOriginator: jest.fn(),
  createClosedLoopReferral: createClosedLoopReferralMock,
  declineClosedLoopReferral: jest.fn(),
  getClosedLoopReferral: jest.fn(),
  linkReferralAppointment: jest.fn(),
  markReferralSeenClosedLoop: jest.fn(),
  recordSignedReferralResponse: jest.fn(),
  rerouteClosedLoopReferral: jest.fn(),
  setReferralDestinationFacility: jest.fn(),
}));

jest.unstable_mockModule('../../middleware/phiAccessMiddleware.js', () => ({
  patientAccessGuard: () => (_req, _res, next) => next(),
}));

jest.unstable_mockModule('../../middleware/rejectMobileClinicalWriteMiddleware.js', () => ({
  rejectMobileClinicalWrite: (_req, _res, next) => next(),
}));

const { default: referralRoutes } = await import('../../routes/referral/referralRoutes.js');

const tailSpy = jest.fn();

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.tenantId = '00000000-0000-4000-8000-000000000001';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'ADMIN' };
  next();
});
app.use('/api/v1/referrals', referralRoutes);
// Stand-in for the global error handler — pins the preserved next(err) tail.
app.use((err, _req, res, _next) => {
  tailSpy(err);
  res.status(500).json({ success: false, message: 'Handled by global error middleware' });
});

beforeEach(() => {
  referralPathwayMode = 'off';
  acceptReferralMock.mockReset();
  acceptClosedLoopReferralMock.mockReset();
  createReferralMock.mockReset();
  createClosedLoopReferralMock.mockReset();
  getIncomingReferralsMock.mockReset();
  getPatientReferralsMock.mockReset();
  isInternalReferralMock.mockReset().mockResolvedValue(true);
  tailSpy.mockReset();
});

describe('referral route catches relay AppError code + details', () => {
  test('operational AppError carries code and details over HTTP', async () => {
    referralPathwayMode = 'shadow';
    acceptClosedLoopReferralMock.mockRejectedValueOnce(
      AppError.conflict('msg', 'SOME_CODE', { reason: 'x' }),
    );

    const response = await request(app).put('/api/v1/referrals/12/accept').send({});

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('msg');
    expect(response.body.code).toBe('SOME_CODE');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
    expect(tailSpy).not.toHaveBeenCalled();
  });

  test('off mode preserves the legacy accept path without invoking closed-loop enforcement', async () => {
    acceptReferralMock.mockResolvedValueOnce({ id: 12, status: 'accepted' });

    const response = await request(app).put('/api/v1/referrals/12/accept').send({});

    expect(response.statusCode).toBe(200);
    expect(acceptReferralMock).toHaveBeenCalledTimes(1);
    expect(acceptClosedLoopReferralMock).not.toHaveBeenCalled();
  });

  test('enabled mode keeps external referrals on the legacy accept path', async () => {
    referralPathwayMode = 'active';
    isInternalReferralMock.mockResolvedValueOnce(false);
    acceptReferralMock.mockResolvedValueOnce({ id: 12, status: 'accepted' });

    const response = await request(app).put('/api/v1/referrals/12/accept').send({});

    expect(response.statusCode).toBe(200);
    expect(isInternalReferralMock).toHaveBeenCalledTimes(1);
    expect(acceptReferralMock).toHaveBeenCalledTimes(1);
    expect(acceptClosedLoopReferralMock).not.toHaveBeenCalled();
  });

  test('enabled mode keeps new external referrals on the legacy creation path', async () => {
    referralPathwayMode = 'active';
    createReferralMock.mockResolvedValueOnce({ id: 13, referral_type: 'external' });

    const response = await request(app).post('/api/v1/referrals').send({
      patient_uid: '22222222-2222-4222-8222-222222222222',
      referred_to_department: 'External cardiology',
      referral_type: 'external',
      reason: 'External specialist review',
    });

    expect(response.statusCode).toBe(201);
    expect(createReferralMock).toHaveBeenCalledTimes(1);
    expect(createClosedLoopReferralMock).not.toHaveBeenCalled();
  });

  test('operational AppError without details produces no details key', async () => {
    getIncomingReferralsMock.mockRejectedValueOnce(
      AppError.notFound('No referral inbox configured for this consultant', 'REFERRAL_INBOX_NOT_FOUND'),
    );

    const response = await request(app).get('/api/v1/referrals/incoming');

    expect(response.statusCode).toBe(404);
    expect(response.body.code).toBe('REFERRAL_INBOX_NOT_FOUND');
    expect(response.body).not.toHaveProperty('details');
  });

  test('non-operational error keeps the next(err) tail — global handler receives it, nothing leaks', async () => {
    const boom = new Error("Cannot read properties of undefined (reading 'referred_to_doctor')");
    getPatientReferralsMock.mockRejectedValueOnce(boom);

    const response = await request(app)
      .get('/api/v1/referrals/patient/22222222-2222-4222-8222-222222222222');

    expect(response.statusCode).toBe(500);
    expect(response.body.message).toBe('Handled by global error middleware');
    expect(response.body.message).not.toMatch(/referred_to_doctor/);
    expect(tailSpy).toHaveBeenCalledTimes(1);
    expect(tailSpy.mock.calls[0][0]).toBe(boom);
  });
});
