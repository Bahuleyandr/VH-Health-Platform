import express from 'express';
import request from 'supertest';
import { jest } from '@jest/globals';

const listPaymentNoticeReviewsMock = jest.fn();

jest.unstable_mockModule('../../services/nhcx/nhcxOutboundDispatcherService.js', () => ({
  dispatchPendingNHCXMessages: jest.fn(),
  enqueueClaimStatusCheck: jest.fn(),
  enqueueClaimSubmit: jest.fn(),
  enqueueCommunicationResponse: jest.fn(),
  enqueueCoverageEligibilityCheck: jest.fn(),
  enqueuePreauthSubmit: jest.fn(),
  getNHCXMessage: jest.fn(),
  listNHCXMessages: jest.fn(),
  redriveNHCXMessage: jest.fn(),
}));

jest.unstable_mockModule('../../services/nhcx/nhcxCommunicationService.js', () => ({
  getCommunicationWorkbench: jest.fn(),
}));

jest.unstable_mockModule('../../services/nhcx/nhcxPaymentNoticeService.js', () => ({
  approvePaymentNoticeReview: jest.fn(),
  getPaymentNoticeReview: jest.fn(),
  listPaymentNoticeReviews: listPaymentNoticeReviewsMock,
  rejectPaymentNoticeReview: jest.fn(),
}));

const { default: nhcxRoutes } = await import('../../routes/admin/nhcxRoutes.js');

const TENANT = '00000000-0000-4000-8000-000000000001';

function makeApp(role) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantId = TENANT;
    req.user = { uid: '22222222-2222-4222-8222-222222222222', role };
    next();
  });
  app.use('/admin/nhcx', nhcxRoutes);
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  });
  return app;
}

beforeEach(() => {
  listPaymentNoticeReviewsMock.mockReset();
});

describe('admin NHCX payment notice routes', () => {
  it('rejects non-finance roles from the review queue', async () => {
    const res = await request(makeApp('DOCTOR')).get('/admin/nhcx/payment-notices');

    expect(res.status).toBe(403);
    expect(listPaymentNoticeReviewsMock).not.toHaveBeenCalled();
  });

  it('allows finance-class roles through the roleHelpers gate', async () => {
    listPaymentNoticeReviewsMock.mockResolvedValueOnce({ items: [], summary: { count: 0 } });

    const res = await request(makeApp('FINANCE_INCHARGE')).get('/admin/nhcx/payment-notices');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(listPaymentNoticeReviewsMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      status: 'manual_review',
    }));
  });
});
