import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Controller-layer contract regression — the feedback member of the
// relayAppError sweep (paediatricImmunisationRoutesAppErrorPropagation twin).
//
// feedbackController.js repeated the pasted catch pattern inline in four
// handlers (getMyFeedback / getMyStats / submitFeedbackEnhanced /
// submitQuickRating): `error(res, err.message, err.statusCode)` with no 4th
// arg dropped `err.code` and `err.details`, so a service AppError arrived as
// an anonymous status a client cannot branch on. The four sites are ported to
// responseHelper.relayAppError, each keeping its own generic 500 message.
//
// These tests drive the controller through the real router that mounts it
// (src/routes/feedbackRoutes.js, wrapAutoRBAC stack included) and assert the
// HTTP response body itself.

const getFeedbackByPhoneMock = jest.fn();
const getFeedbackStatsMock = jest.fn();
const getUserByPhoneMock = jest.fn();
const submitFeedbackMock = jest.fn();
const submitQuickRatingMock = jest.fn();

jest.unstable_mockModule('../../services/feedback/feedbackService.js', () => ({
  default: {
    submitSimpleFeedback: jest.fn(async () => ({})),
    getFeedbackByPhone: getFeedbackByPhoneMock,
    getFeedbackStats: getFeedbackStatsMock,
    getDashboard: jest.fn(async () => ({})),
    getRecentFeedback: jest.fn(async () => ({})),
    getAnalytics: jest.fn(async () => ({})),
    getReport: jest.fn(async () => ({})),
    getUserByPhone: getUserByPhoneMock,
    submitFeedback: submitFeedbackMock,
    submitQuickRating: submitQuickRatingMock,
    deleteFeedback: jest.fn(async () => null),
  },
}));

jest.unstable_mockModule('../../services/feedback/npsService.js', () => ({
  submitNpsResponse: jest.fn(async () => ({ response: {} })),
}));
jest.unstable_mockModule('../../services/doctor/doctorRefService.js', () => ({
  resolveDoctorFilterId: jest.fn(async () => null),
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));
jest.unstable_mockModule('../../utils/resolveIdentity.js', () => ({
  resolvePhoneFromUID: jest.fn(async () => null),
}));
// The controller (and securityAuditLogger inside the wrapAutoRBAC stack)
// import the prisma singleton; stub it so the suite never touches a DB.
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: jest.fn(async () => []) },
  prismaReadOnly: { $queryRawUnsafe: jest.fn(async () => []) },
  setTenant: jest.fn(),
  setTenantTx: jest.fn(),
  circuitBreakerStatus: jest.fn(() => ({})),
}));
// Rate limiting pulls in redis + tenant settings; irrelevant to the catch
// blocks under test.
jest.unstable_mockModule('../../middleware/rateLimitMiddleware.js', () => ({
  dynamicRoleRateLimiter: (_req, _res, next) => next(),
  getRateLimiter: () => (_req, _res, next) => next(),
}));

const { default: feedbackRoutes } = await import('../../routes/feedbackRoutes.js');

const PATIENT_PHONE = '+919876543210';

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  // rbac(feedbackRoutes) allows PATIENT; validateUID needs a uid; the
  // controller resolves the feedback phone from the token phone claim.
  req.user = {
    uid: '11111111-1111-4111-8111-111111111111',
    role: 'PATIENT',
    phone: PATIENT_PHONE,
    name: 'Test Patient',
  };
  next();
});
app.use('/api/v1/feedback', feedbackRoutes);

beforeEach(() => {
  getFeedbackByPhoneMock.mockReset();
  getFeedbackStatsMock.mockReset();
  getUserByPhoneMock.mockReset();
  submitFeedbackMock.mockReset();
  submitQuickRatingMock.mockReset();
});

describe('feedback controller catch blocks surface AppError code + details', () => {
  test('getMyFeedback — an AppError carrying code + details forwards both', async () => {
    getFeedbackByPhoneMock.mockRejectedValueOnce(AppError.conflict(
      'Feedback ledger is locked for this patient',
      'FEEDBACK_LEDGER_LOCKED',
      { reason: 'x' },
    ));

    const response = await request(app).get('/api/v1/feedback/my-feedback');

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Feedback ledger is locked for this patient');
    // The bug: these assertions FAIL on the unmodified catch (both dropped).
    expect(response.body.code).toBe('FEEDBACK_LEDGER_LOCKED');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('submitQuickRating — an AppError carrying code + details forwards both', async () => {
    submitQuickRatingMock.mockRejectedValueOnce(AppError.conflict(
      'A rating for this appointment was already recorded',
      'FEEDBACK_QUICK_RATING_DUPLICATE',
      { appointment_id: 7 },
    ));

    const response = await request(app)
      .post('/api/v1/feedback/quick-rating')
      .send({ rating: 5, appointment_id: 7 });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('FEEDBACK_QUICK_RATING_DUPLICATE');
    expect(response.body.details).toEqual({ appointment_id: 7 });
  });
});

describe('feedback controller non-AppError paths keep their per-site generic 500', () => {
  test('getMyFeedback — 500 body is the site generic, thrown text absent', async () => {
    getFeedbackByPhoneMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'feedback_rows')"),
    );

    const response = await request(app).get('/api/v1/feedback/my-feedback');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Failed to retrieve feedback');
    expect(response.body.message).not.toMatch(/feedback_rows/);
    expect(response.body).not.toHaveProperty('details');
  });

  test('getMyStats — 500 body is the site generic, thrown text absent', async () => {
    getFeedbackStatsMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'avg_rating')"),
    );

    const response = await request(app).get('/api/v1/feedback/my-stats');

    expect(response.statusCode).toBe(500);
    expect(response.body.message).toBe('Failed to retrieve feedback statistics');
    expect(response.body.message).not.toMatch(/avg_rating/);
  });

  test('submitFeedbackEnhanced — 500 body is the site generic, thrown text absent', async () => {
    getUserByPhoneMock.mockResolvedValueOnce({ uid: '22222222-2222-4222-8222-222222222222' });
    submitFeedbackMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'insert_row')"),
    );

    const response = await request(app)
      .post('/api/v1/feedback')
      .send({ rating: 5, comment: 'Great OPD experience' });

    expect(response.statusCode).toBe(500);
    expect(response.body.message).toBe('Failed to submit feedback');
    expect(response.body.message).not.toMatch(/insert_row/);
  });

  test('submitQuickRating — 500 body is the site generic, thrown text absent', async () => {
    submitQuickRatingMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'rating_row')"),
    );

    const response = await request(app)
      .post('/api/v1/feedback/quick-rating')
      .send({ rating: 4 });

    expect(response.statusCode).toBe(500);
    expect(response.body.message).toBe('Failed to submit rating');
    expect(response.body.message).not.toMatch(/rating_row/);
  });
});
