import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for the relayAppError port of the shared
// HL7-feeds handleFailure (previously `err.details ?? { code: err.code }`).

const listSubscriptionsMock = jest.fn();
const createSubscriptionMock = jest.fn();
const deactivateSubscriptionMock = jest.fn();
const listFeedMessagesMock = jest.fn();
const deliverPendingFeedMessagesMock = jest.fn();
const logSecurityEventMock = jest.fn();

jest.unstable_mockModule('../../utils/securityAuditLogger.js', () => ({
  logSecurityEvent: logSecurityEventMock,
}));

jest.unstable_mockModule('../../services/hl7/hl7OutboundService.js', () => ({
  listSubscriptions: listSubscriptionsMock,
  createSubscription: createSubscriptionMock,
  deactivateSubscription: deactivateSubscriptionMock,
  listFeedMessages: listFeedMessagesMock,
  replayFeedMessage: jest.fn(),
  deliverPendingFeedMessages: deliverPendingFeedMessagesMock,
}));

const { default: hl7FeedRoutes } = await import('../../routes/hl7/hl7FeedRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = {
    uid: '11111111-1111-4111-8111-111111111111',
    role: req.get('x-test-role') || 'ADMIN',
  };
  req.tenantId = '00000000-0000-4000-8000-000000000001';
  next();
});
app.use('/api/v1/hl7-feeds', hl7FeedRoutes);

beforeEach(() => {
  listSubscriptionsMock.mockReset().mockResolvedValue([]);
  createSubscriptionMock.mockReset().mockImplementation(async (input) => {
    if (!input.name) {
      throw AppError.badRequest('name is required', 'HL7_FEED_NAME_REQUIRED');
    }
    return { id: 7, name: input.name, auth_header_configured: input.authHeader != null };
  });
  deactivateSubscriptionMock.mockReset().mockResolvedValue({ id: 7, name: 'Receiver', is_active: false });
  listFeedMessagesMock.mockReset().mockResolvedValue([]);
  deliverPendingFeedMessagesMock.mockReset().mockResolvedValue({ picked: 0 });
  logSecurityEventMock.mockReset();
});

describe('HL7 feed route authorization and input presence', () => {
  test.each(['ADMIN', 'SUPER_ADMIN', 'INTEGRATION_ADMIN'])(
    'allows %s to read the management surface',
    async (role) => {
      const response = await request(app)
        .get('/api/v1/hl7-feeds/subscriptions')
        .set('x-test-role', role);

      expect(response.statusCode).toBe(200);
      expect(listSubscriptionsMock).toHaveBeenCalledTimes(1);
    },
  );

  test.each(['NURSING_STAFF', 'DOCTOR', 'RECEPTIONIST'])(
    'denies %s before any feed service executes',
    async (role) => {
      const response = await request(app)
        .get('/api/v1/hl7-feeds/subscriptions')
        .set('x-test-role', role);

      expect(response.statusCode).toBe(403);
      expect(listSubscriptionsMock).not.toHaveBeenCalled();
    },
  );

  test('passes the resolved tenant to denied-request security auditing', async () => {
    await request(app)
      .get('/api/v1/hl7-feeds/subscriptions?authHeader=receiver-secret')
      .set('x-test-role', 'NURSING_STAFF')
      .expect(403);

    expect(logSecurityEventMock).toHaveBeenCalledWith(
      'PERMISSION_DENIED',
      expect.objectContaining({
        tenantId: '00000000-0000-4000-8000-000000000001',
        path: '/api/v1/hl7-feeds/subscriptions?authHeader=receiver-secret',
      }),
    );
  });

  test('preserves omitted fields and forwards explicit clear/replace values', async () => {
    await request(app)
      .post('/api/v1/hl7-feeds/subscriptions')
      .set('x-test-role', 'INTEGRATION_ADMIN')
      .send({ name: 'Receiver', endpoint_url: 'https://receiver.example/hl7' })
      .expect(201);

    const omitted = createSubscriptionMock.mock.calls[0][0];
    expect(Object.hasOwn(omitted, 'authHeader')).toBe(false);
    expect(Object.hasOwn(omitted, 'messageTypes')).toBe(false);

    await request(app)
      .post('/api/v1/hl7-feeds/subscriptions')
      .set('x-test-role', 'INTEGRATION_ADMIN')
      .send({
        name: 'Receiver',
        endpoint_url: 'https://receiver.example/hl7',
        auth_header: null,
        message_types: ['ORU^R01'],
      })
      .expect(201);

    expect(createSubscriptionMock.mock.calls[1][0]).toEqual({
      name: 'Receiver',
      endpointUrl: 'https://receiver.example/hl7',
      authHeader: null,
      messageTypes: ['ORU^R01'],
    });
  });

  test('turns a body-less create into the named validation error instead of a TypeError 500', async () => {
    const response = await request(app)
      .post('/api/v1/hl7-feeds/subscriptions')
      .set('x-test-role', 'INTEGRATION_ADMIN');

    expect(response.statusCode).toBe(400);
    expect(response.body.code).toBe('HL7_FEED_NAME_REQUIRED');
  });

  test.each(['0', '-1', '1junk', '2147483648'])(
    'rejects malformed subscription id %s without calling the service',
    async (id) => {
      const response = await request(app)
        .delete(`/api/v1/hl7-feeds/subscriptions/${id}`)
        .set('x-test-role', 'INTEGRATION_ADMIN');

      expect(response.statusCode).toBe(400);
      expect(response.body.code).toBe('HL7_FEED_BAD_SUBSCRIPTION_ID');
      expect(deactivateSubscriptionMock).not.toHaveBeenCalled();
    },
  );
});

describe('HL7 feeds handleFailure relays AppError code + details', () => {
  test('AppError carries code at the root and forwards details', async () => {
    listSubscriptionsMock.mockRejectedValueOnce(AppError.conflict(
      'Subscription endpoint already registered',
      'HL7_SUBSCRIPTION_DUPLICATE',
      { endpoint: 'https://receiver.example' },
    ));

    const response = await request(app).get('/api/v1/hl7-feeds/subscriptions');

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('HL7_SUBSCRIPTION_DUPLICATE');
    expect(response.body.details).toEqual({ endpoint: 'https://receiver.example' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('non-AppError returns the generic 500 and never leaks err.message', async () => {
    listSubscriptionsMock.mockRejectedValueOnce(
      new Error('connect ECONNREFUSED 127.0.0.1:5433'),
    );

    const response = await request(app).get('/api/v1/hl7-feeds/subscriptions');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Failed to list subscriptions');
    expect(response.body.message).not.toMatch(/ECONNREFUSED/);
  });
});
