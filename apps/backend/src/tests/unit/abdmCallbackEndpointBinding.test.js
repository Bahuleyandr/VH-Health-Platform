import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const SECRET = 'endpoint-bound-abdm-secret'.repeat(2);
const replayClaims = new Set();
const executeRaw = jest.fn(async (sql, ...args) => {
  if (String(sql).includes('INSERT INTO interop_replay_guard')) {
    const key = `${args[0]}:${args[1]}`;
    if (replayClaims.has(key)) {
      const duplicate = new Error('duplicate replay identity');
      duplicate.code = '23505';
      throw duplicate;
    }
    replayClaims.add(key);
  }
  return 1;
});
// assertSharedReplayOnce also issues a best-effort expired-row sweep
// (`DELETE FROM interop_replay_guard ...`) on ~2% of successful claims, so a
// global $executeRawUnsafe call count flakes. Durable-claim assertions must
// count only the claim INSERTs.
const replayClaimCalls = () => executeRaw.mock.calls.filter(
  ([sql]) => String(sql).includes('INSERT INTO interop_replay_guard'),
);
const handleConsentRequest = jest.fn();
const handleDataRequest = jest.fn();
const recordAuthenticatedAbdmCallback = jest.fn();
const markAuthenticatedAbdmCallback = jest.fn();
const ABDM_CONFIG_MOCK = {
  enabled: true,
  hipId: 'TEST_HIP',
  callbackSecret: SECRET,
  allowLegacyUnboundCallbacks: false,
  PURPOSES: ['CAREMGT'],
};

jest.unstable_mockModule('../../config/abdmConfig.js', () => ({
  ABDM_CONFIG: ABDM_CONFIG_MOCK,
}));
jest.unstable_mockModule('../../middleware/rateLimitMiddleware.js', () => ({
  genericLimiter: (_req, _res, next) => next(),
}));
jest.unstable_mockModule('../../services/interop/tenantInteropSecretService.js', () => ({
  resolveInteropCredentialSnapshot: jest.fn().mockResolvedValue(null),
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  DEFAULT_TENANT_ID: TENANT_ID,
}));
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $executeRawUnsafe: executeRaw },
}));
jest.unstable_mockModule('../../lib/redis.js', () => ({
  getRedisClient: () => null,
}));
jest.unstable_mockModule('../../services/abdm/abdmService.js', () => ({
  default: {
    handleConsentRequest,
    handleDataRequest,
  },
}));
jest.unstable_mockModule('../../utils/hipaaAudit.js', () => ({
  logPhiAccess: jest.fn(),
}));
jest.unstable_mockModule('../../services/integrations/externalAbdmRecoveryService.js', () => ({
  recordAuthenticatedAbdmCallback,
  markAuthenticatedAbdmCallback,
}));

const {
  SIGNED_REQUEST_SIGNATURE_VERSIONS,
  signSignedRequest,
  __testing__: signedRequestTesting,
} = await import('../../utils/signedRequest.js');
const { callbackRouter } = await import('../../routes/abdm/abdmRoutes.js');

function buildApp() {
  const app = express();
  app.use(express.json({
    verify: (req, _res, body) => { req.abdmRawBody = Buffer.from(body); },
  }));
  app.use('/api/v1/abdm', callbackRouter);
  return app;
}

function signedHeaders({ body, timestamp, requestId, method = 'POST', canonicalPath }) {
  const signature = signSignedRequest({
    secret: SECRET,
    timestamp,
    requestId,
    payload: Buffer.from(JSON.stringify(body)),
    signatureVersion: SIGNED_REQUEST_SIGNATURE_VERSIONS.ENDPOINT_BOUND_V1,
    method,
    canonicalPath,
    context: 'ABDM callback',
    codePrefix: 'ABDM_CALLBACK',
  });
  return {
    'x-hip-id': 'TEST_HIP',
    'x-abdm-signature': signature,
    'x-abdm-signature-version': 'v1',
    timestamp,
    'request-id': requestId,
  };
}

beforeEach(() => {
  ABDM_CONFIG_MOCK.allowLegacyUnboundCallbacks = false;
  replayClaims.clear();
  signedRequestTesting.replayCache.clear();
  executeRaw.mockClear();
  handleConsentRequest.mockReset().mockResolvedValue({ consent_id: 'c-1' });
  handleDataRequest.mockReset().mockResolvedValue({ request_id: 'unexpected' });
  recordAuthenticatedAbdmCallback.mockReset().mockResolvedValue({
    event: { id: '71', external_event_id: 'c-1', status: 'pending' },
    duplicate: false,
  });
  markAuthenticatedAbdmCallback.mockReset().mockResolvedValue({ id: '71', status: 'processed' });
});

describe('ABDM endpoint-bound callback signature', () => {
  it('rejects cross-method/path preplay before replay claim, then accepts the intended callback', async () => {
    const app = buildApp();
    const timestamp = String(Date.now());
    const requestId = 'abdm-preplay-1';
    const body = {
      notification: {
        consentRequestId: 'c-1',
        purpose: { code: 'CAREMGT' },
        patient: { id: 'patient@sbx' },
      },
    };
    const headers = signedHeaders({
      body,
      timestamp,
      requestId,
      canonicalPath: '/api/v1/abdm/consent/on-notify',
    });

    const wrongMethod = await request(app)
      .put('/api/v1/abdm/consent/on-notify')
      .set(headers)
      .send(body);
    expect(wrongMethod.status).toBe(401);
    expect(wrongMethod.body.code).toBe('ABDM_CALLBACK_SIGNATURE_INVALID');

    const wrongPath = await request(app)
      .post('/api/v1/abdm/health-info/on-request')
      .set(headers)
      .send(body);
    expect(wrongPath.status).toBe(401);
    expect(wrongPath.body.code).toBe('ABDM_CALLBACK_SIGNATURE_INVALID');
    expect(executeRaw).not.toHaveBeenCalled();
    expect(handleDataRequest).not.toHaveBeenCalled();

    const intended = await request(app)
      .post('/api/v1/abdm/consent/on-notify?ignored=true')
      .set(headers)
      .set('x-forwarded-prefix', '/hospital-edge')
      .send(body);
    expect(intended.status).toBe(202);
    expect(handleConsentRequest).toHaveBeenCalledTimes(1);
    const claims = replayClaimCalls();
    expect(claims).toHaveLength(1);
    expect(claims[0][1]).toBe('abdm-callback');
    expect(claims[0][2]).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(recordAuthenticatedAbdmCallback).toHaveBeenCalledWith(expect.objectContaining({
      auth: expect.objectContaining({
        signatureVersion: 'v1',
        method: 'POST',
        canonicalPath: '/api/v1/abdm/consent/on-notify',
      }),
    }));

    const replay = await request(app)
      .post('/api/v1/abdm/consent/on-notify')
      .set(headers)
      .send(body);
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('ABDM_CALLBACK_REPLAY');
    expect(replayClaimCalls()).toHaveLength(1);
    expect(handleConsentRequest).toHaveBeenCalledTimes(1);
  });

  it('keeps durable-claim accounting immune to the opportunistic guard sweep', async () => {
    const app = buildApp();
    const timestamp = String(Date.now());
    const requestId = 'abdm-sweep-1';
    const body = {
      notification: {
        consentRequestId: 'c-1',
        purpose: { code: 'CAREMGT' },
        patient: { id: 'patient@sbx' },
      },
    };
    const headers = signedHeaders({
      body,
      timestamp,
      requestId,
      canonicalPath: '/api/v1/abdm/consent/on-notify',
    });

    // Force the ~2% post-claim expired-row sweep in assertSharedReplayOnce to
    // fire deterministically — the exact condition behind the CI flake this
    // suite is pinned against (an extra, non-claim $executeRawUnsafe DELETE
    // recorded alongside the claim INSERT).
    const sweepRoll = jest.spyOn(Math, 'random').mockReturnValue(0);
    let accepted;
    try {
      accepted = await request(app)
        .post('/api/v1/abdm/consent/on-notify')
        .set(headers)
        .send(body);
    } finally {
      sweepRoll.mockRestore();
    }

    expect(accepted.status).toBe(202);
    expect(handleConsentRequest).toHaveBeenCalledTimes(1);
    // The sweep DELETE reached the store...
    expect(executeRaw.mock.calls.some(
      ([sql]) => String(sql).includes('DELETE FROM interop_replay_guard'),
    )).toBe(true);
    // ...but exactly one durable replay claim was written.
    const claims = replayClaimCalls();
    expect(claims).toHaveLength(1);
    expect(claims[0][1]).toBe('abdm-callback');
    expect(claims[0][2]).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  it('accepts an unversioned legacy signature only behind the explicit compatibility switch', async () => {
    ABDM_CONFIG_MOCK.allowLegacyUnboundCallbacks = true;
    const body = {
      notification: {
        consentRequestId: 'c-legacy',
        purpose: { code: 'CAREMGT' },
        patient: { id: 'patient@sbx' },
      },
    };
    const timestamp = String(Date.now());
    const requestId = 'abdm-legacy-1';
    const signature = signSignedRequest({
      secret: SECRET,
      timestamp,
      requestId,
      payload: Buffer.from(JSON.stringify(body)),
    });

    const response = await request(buildApp())
      .post('/api/v1/abdm/consent/on-notify')
      .set('x-hip-id', 'TEST_HIP')
      .set('x-abdm-signature', signature)
      .set('timestamp', timestamp)
      .set('request-id', requestId)
      .send(body);

    expect(response.status).toBe(202);
    expect(recordAuthenticatedAbdmCallback).toHaveBeenCalledWith(expect.objectContaining({
      auth: expect.objectContaining({ signatureVersion: 'legacy' }),
    }));
  });
});
