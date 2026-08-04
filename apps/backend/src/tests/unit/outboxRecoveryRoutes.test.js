import { readFileSync } from 'node:fs';

import express from 'express';
import { jest } from '@jest/globals';
import request from 'supertest';

const TENANT = '00000000-0000-4000-8000-000000000001';
const ACTOR = '11111111-1111-4111-8111-111111111111';

const listEventsMock = jest.fn();
const redriveFailedEventMock = jest.fn();
const phiAccessMiddlewareMock = jest.fn((_req, _res, next) => next());
const phiAccessLoggerMock = jest.fn(() => phiAccessMiddlewareMock);
const enqueueDeliveryMock = jest.fn();
const markDeliveryDeadMock = jest.fn();
const redriveDeliveryMock = jest.fn();
const createSubscriptionMock = jest.fn();

jest.unstable_mockModule('../../middleware/phiAccessMiddleware.js', () => ({
  phiAccessLogger: phiAccessLoggerMock,
}));
jest.unstable_mockModule('../../services/events/eventOutboxService.js', () => ({
  listEvents: listEventsMock,
  redriveFailedEvent: redriveFailedEventMock,
}));
jest.unstable_mockModule('../../services/integrations/integrationService.js', () => ({
  archiveIntegration: jest.fn(),
  createIntegration: jest.fn(),
  getIntegration: jest.fn(),
  listIntegrationLogs: jest.fn(),
  listIntegrations: jest.fn(),
  updateIntegration: jest.fn(),
  writeIntegrationLog: jest.fn(),
}));
jest.unstable_mockModule('../../services/integrations/webhookSubscriptionService.js', () => ({
  createSubscription: createSubscriptionMock,
  deleteSubscription: jest.fn(),
  getSubscription: jest.fn(),
  listSubscriptions: jest.fn(),
  updateSubscription: jest.fn(),
}));
jest.unstable_mockModule('../../services/integrations/webhookDeliveryService.js', () => ({
  dispatchPendingDeliveries: jest.fn(),
  enqueueDelivery: enqueueDeliveryMock,
  getDelivery: jest.fn(),
  listDeliveries: jest.fn(),
  markDeliveryDead: markDeliveryDeadMock,
  redriveDelivery: redriveDeliveryMock,
}));

const { default: eventOutboxRoutes } = await import('../../routes/admin/eventOutboxRoutes.js');
const { deliveryRouter, integrationRouter } = await import('../../routes/admin/integrationRoutes.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantId = TENANT;
    req.user = { uid: ACTOR, role: 'ADMIN', rawRole: 'super_admin' };
    req.id = 'server-request-id';
    next();
  });
  app.use('/events', eventOutboxRoutes);
  app.use('/integrations', integrationRouter);
  app.use('/webhook-deliveries', deliveryRouter);
  app.use((error, _req, res, _next) => {
    res.status(error.statusCode || 500).json({ code: error.code, message: error.message });
  });
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  listEventsMock.mockResolvedValue([]);
  redriveFailedEventMock.mockResolvedValue({ id: '9223372036854775807', status: 'pending' });
  createSubscriptionMock.mockResolvedValue({
    id: 3,
    integration_id: 9,
    event_type: 'patient.admitted',
    endpoint_url: 'https://subscriber.example.test/webhook',
  });
  enqueueDeliveryMock.mockResolvedValue({ matched: 0, enqueued: [] });
  markDeliveryDeadMock.mockResolvedValue({ id: 7, status: 'dead' });
  redriveDeliveryMock.mockResolvedValue({ id: 7, status: 'pending' });
});

describe('event outbox recovery admin routes', () => {
  test('tenant-scopes list pagination and attaches PHI access logging', async () => {
    const response = await request(buildApp())
      .get('/events')
      .query({ status: 'failed', limit: '25', offset: '5' });
    expect(response.status).toBe(200);
    expect(listEventsMock).toHaveBeenCalledWith({
      tenantId: TENANT,
      status: 'failed',
      limit: '25',
      offset: '5',
    });
    expect(phiAccessMiddlewareMock).toHaveBeenCalledTimes(1);
    const source = readFileSync(
      new URL('../../routes/admin/eventOutboxRoutes.js', import.meta.url),
      'utf8',
    );
    expect(source).toContain("phiAccessLogger('EVENT_OUTBOX')");
  });

  test('passes only server-derived tenant, actor, role, and request provenance to redrive', async () => {
    const response = await request(buildApp())
      .post('/events/9223372036854775807/redrive')
      .send({
        reason: 'Reviewed the failure',
        actor_uid: '22222222-2222-4222-8222-222222222222',
        actor_role: 'DOCTOR',
        tenant_id: '33333333-3333-4333-8333-333333333333',
      });
    expect(response.status).toBe(200);
    expect(redriveFailedEventMock).toHaveBeenCalledWith({
      tenantId: TENANT,
      id: '9223372036854775807',
      reason: 'Reviewed the failure',
      actorUid: ACTOR,
      actorRole: 'SUPER_ADMIN',
      requestId: 'server-request-id',
    });
  });

  test('exposes failed-state redrive only and removes blind delivered/failed setters', () => {
    const source = readFileSync(
      new URL('../../routes/admin/eventOutboxRoutes.js', import.meta.url),
      'utf8',
    );
    expect(source).toContain("router.post('/:id/redrive'");
    expect(source).not.toMatch(/router\.(?:post|put|patch)\('\/:id\/(?:delivered|failed)'/);
    expect(source).not.toContain('markDelivered');
    expect(source).not.toContain('markFailed');
  });
});

describe('webhook recovery admin routes', () => {
  test('does not allow ad-hoc enqueue to impersonate the source bridge', async () => {
    const response = await request(buildApp())
      .post('/webhook-deliveries/enqueue')
      .send({
        event_type: 'patient.admitted',
        event_outbox_id: '9223372036854775807',
        source_identity: 'admin:patient-admitted:1',
        payload: { patient_uid: 'secret' },
        request_id: 'client-request-id',
      });
    expect(response.status).toBe(201);
    expect(enqueueDeliveryMock).toHaveBeenCalledWith({
      tenantId: TENANT,
      eventType: 'patient.admitted',
      payload: { patient_uid: 'secret' },
      sourceIdentity: 'admin:patient-admitted:1',
      requestId: 'client-request-id',
    });
    expect(enqueueDeliveryMock.mock.calls[0][0]).not.toHaveProperty('eventOutboxId');
  });

  test('binds subscriber acknowledgement classification to the authenticated owner', async () => {
    const response = await request(buildApp())
      .post('/integrations/9/subscriptions')
      .send({
        event_type: 'patient.admitted',
        endpoint_url: 'https://subscriber.example.test/webhook',
        signing_algorithm: 'none',
        downstream_effect_classification: 'clinical_or_operational_effect',
        acknowledgement_contract: 'response_body_sha256',
        acknowledgement_config: { expected_sha256: 'a'.repeat(64) },
        recovery_contract_owner_reason: 'Subscriber contract reviewed',
      });
    expect(response.status).toBe(201);
    expect(createSubscriptionMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      integrationId: '9',
      downstreamEffectClassification: 'clinical_or_operational_effect',
      acknowledgementContract: 'response_body_sha256',
      acknowledgementConfig: { expected_sha256: 'a'.repeat(64) },
      recoveryContractOwnerUid: ACTOR,
      recoveryContractOwnerReason: 'Subscriber contract reviewed',
    }));
  });

  test.each([
    ['patch', '/webhook-deliveries/7/mark-dead', markDeliveryDeadMock],
    ['post', '/webhook-deliveries/7/redrive', redriveDeliveryMock],
  ])('threads the required reason and server actor through %s %s', async (method, path, service) => {
    const response = await request(buildApp())[method](path).send({
      reason: 'Operator reviewed recovery evidence',
      actor_uid: '22222222-2222-4222-8222-222222222222',
      actor_role: 'DOCTOR',
    });
    expect(response.status).toBe(method === 'post' ? 201 : 200);
    expect(service).toHaveBeenCalledWith({
      tenantId: TENANT,
      id: '7',
      reason: 'Operator reviewed recovery evidence',
      actorUid: ACTOR,
      actorRole: 'SUPER_ADMIN',
      requestId: 'server-request-id',
    });
  });
});
