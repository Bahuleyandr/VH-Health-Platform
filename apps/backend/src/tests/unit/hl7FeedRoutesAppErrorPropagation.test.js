import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for the relayAppError port of the shared
// HL7-feeds handleFailure (previously `err.details ?? { code: err.code }`).

const listSubscriptionsMock = jest.fn();
const createSubscriptionMock = jest.fn();

jest.unstable_mockModule('../../services/hl7/hl7OutboundService.js', () => ({
  listSubscriptions: listSubscriptionsMock,
  createSubscription: createSubscriptionMock,
  deactivateSubscription: jest.fn(),
  listFeedMessages: jest.fn(),
  replayFeedMessage: jest.fn(),
  deliverPendingFeedMessages: jest.fn(),
}));

const { default: hl7FeedRoutes } = await import('../../routes/hl7/hl7FeedRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'ADMIN' };
  req.tenantId = '00000000-0000-4000-8000-000000000001';
  next();
});
app.use('/api/v1/hl7-feeds', hl7FeedRoutes);

beforeEach(() => {
  listSubscriptionsMock.mockReset();
  createSubscriptionMock.mockReset();
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

// The service treats auth_header as three-valued (undefined = keep the stored
// secret, null/'' = clear it, string = set it). The route is where "field
// absent from the JSON body" must survive as `undefined` — the old
// `req.body.auth_header || null` collapsed absent into an explicit clear,
// which is exactly the credential-wiping upsert the roadmap flagged.
describe('POST /subscriptions maps body.auth_header presence onto the service contract', () => {
  const base = { name: 'HIE bridge', endpoint_url: 'https://hie.example.org/hl7' };

  test('an omitted auth_header reaches the service as undefined (keep stored secret)', async () => {
    createSubscriptionMock.mockResolvedValueOnce({ id: 1, auth_header_set: true });

    const response = await request(app).post('/api/v1/hl7-feeds/subscriptions').send(base);

    expect(response.statusCode).toBe(201);
    expect(createSubscriptionMock).toHaveBeenCalledTimes(1);
    const [payload] = createSubscriptionMock.mock.calls[0];
    expect('authHeader' in payload).toBe(true);
    expect(payload.authHeader).toBeUndefined();
  });

  test('an explicit auth_header: null reaches the service as null (clear)', async () => {
    createSubscriptionMock.mockResolvedValueOnce({ id: 1, auth_header_set: false });

    const response = await request(app)
      .post('/api/v1/hl7-feeds/subscriptions')
      .send({ ...base, auth_header: null });

    expect(response.statusCode).toBe(201);
    const [payload] = createSubscriptionMock.mock.calls[0];
    expect(payload.authHeader).toBeNull();
  });

  test('a provided auth_header string passes through unchanged', async () => {
    createSubscriptionMock.mockResolvedValueOnce({ id: 1, auth_header_set: true });

    const response = await request(app)
      .post('/api/v1/hl7-feeds/subscriptions')
      .send({ ...base, auth_header: 'Bearer s3cret' });

    expect(response.statusCode).toBe(201);
    const [payload] = createSubscriptionMock.mock.calls[0];
    expect(payload.authHeader).toBe('Bearer s3cret');
  });
});
