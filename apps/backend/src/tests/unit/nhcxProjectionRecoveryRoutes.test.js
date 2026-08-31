import express from 'express';
import request from 'supertest';
import { jest } from '@jest/globals';

const getRecoveryMock = jest.fn();
const retryRecoveryMock = jest.fn();

jest.unstable_mockModule('../../services/insurance/claimsService.js', () => ({}));
jest.unstable_mockModule('../../services/insurance/claimCapsService.js', () => ({}));
jest.unstable_mockModule('../../services/insurance/packagesService.js', () => ({}));
jest.unstable_mockModule('../../services/nhcx/nhcxOutboundDispatcherService.js', () => ({
  getAcceptedNHCXProjectionRecovery: getRecoveryMock,
  retryAcceptedNHCXProjection: retryRecoveryMock,
}));
jest.unstable_mockModule('../../middleware/idempotencyMiddleware.js', () => ({
  requireIdempotencyKey: () => (req, res, next) => {
    const key = req.get('idempotency-key');
    if (!key) return res.status(400).json({ success: false, message: 'Idempotency-Key header is required' });
    req.idempotencyClaim = { requestKey: key };
    return next();
  },
}));

const { default: claimsRoutes } = await import('../../routes/insurance/claimsRoutes.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const ACTOR = '22222222-2222-4222-8222-222222222222';

function makeApp(role = 'INSURANCE_COORDINATOR') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantId = TENANT;
    req.user = { uid: ACTOR, role };
    next();
  });
  app.use('/api/v1/insurance', claimsRoutes);
  return app;
}

beforeEach(() => {
  getRecoveryMock.mockReset();
  retryRecoveryMock.mockReset();
});

describe('insurance NHCX accepted projection recovery routes', () => {
  it('returns the exact task and immutable transport receipt', async () => {
    getRecoveryMock.mockResolvedValueOnce({
      message_id: 42,
      projection_status: 'reconciliation_required',
      task_id: 71,
      owner_role: 'INSURANCE_COORDINATOR',
      transport_response_sha256: 'a'.repeat(64),
    });

    const response = await request(makeApp()).get('/api/v1/insurance/nhcx/projections/42');

    expect(response.status).toBe(200);
    expect(response.body.data.task_id).toBe(71);
    expect(getRecoveryMock).toHaveBeenCalledWith({
      tenantId: TENANT,
      messageId: '42',
      actorUid: ACTOR,
    });
  });

  it('requires an idempotency key and sends only a server-hashed command', async () => {
    const missing = await request(makeApp())
      .post('/api/v1/insurance/nhcx/projections/42/retry')
      .send({ expected_transport_response_sha256: 'a'.repeat(64) });
    expect(missing.status).toBe(400);
    expect(retryRecoveryMock).not.toHaveBeenCalled();

    retryRecoveryMock.mockResolvedValueOnce({ message_id: 42, projection_status: 'applied' });
    const response = await request(makeApp())
      .post('/api/v1/insurance/nhcx/projections/42/retry')
      .set('Idempotency-Key', 'nhcx-projection-42')
      .send({ expected_transport_response_sha256: 'a'.repeat(64) });

    expect(response.status).toBe(200);
    expect(retryRecoveryMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      messageId: '42',
      actorUid: ACTOR,
      expectedTransportResponseSha256: 'a'.repeat(64),
      commandKeySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
  });

  it('rejects non-insurance actors before service or command claim', async () => {
    const response = await request(makeApp('CASHIER'))
      .post('/api/v1/insurance/nhcx/projections/42/retry')
      .set('Idempotency-Key', 'nhcx-projection-42')
      .send({ expected_transport_response_sha256: 'a'.repeat(64) });

    expect(response.status).toBe(403);
    expect(retryRecoveryMock).not.toHaveBeenCalled();
  });
});
