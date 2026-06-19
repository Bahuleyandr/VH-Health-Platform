/**
 * ABDM consent-artefact signature verification (audit finding C-4b).
 *
 * Two behaviours under test:
 *   1. ROUTE EXTRACTION (the bug): POST /abdm/consent/on-notify must extract the
 *      CM-signed consent artefact + its signature from the notification body and
 *      thread them into handleConsentRequest. Before the fix the route built the
 *      consentRequest WITHOUT those two fields, so _verifyConsentArtefact always
 *      received undefined and — with verification enabled — rejected every
 *      consent as ABDM_CONSENT_UNSIGNED.
 *   2. VERIFIER (crypto): _verifyConsentArtefact accepts a validly CM-signed
 *      artefact, rejects a tampered signature (ABDM_CONSENT_SIG_INVALID), rejects
 *      a missing artefact/signature (ABDM_CONSENT_UNSIGNED), and is a no-op when
 *      verification is disabled.
 *
 * No real DB/HMAC: abdmService's heavy deps are stubbed, the ABDM HMAC validator
 * + config are mocked so the route handler is reachable, and handleConsentRequest
 * is spied for the extraction assertion.
 */
import { jest } from '@jest/globals';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';

// --- mocks (must precede the dynamic imports) -----------------------------
jest.unstable_mockModule('../../config/abdmConfig.js', () => ({
  ABDM_CONFIG: {
    enabled: true,
    hipId: 'TEST_HIP',
    callbackSecret: 'test-secret',
    PURPOSES: ['CAREMGT'],
  },
}));
// Let the route's HMAC gate pass without a real signed gateway request.
jest.unstable_mockModule('../../utils/signedRequest.js', () => ({
  verifySignedRequest: jest.fn(),
}));
jest.unstable_mockModule('../../middleware/rateLimitMiddleware.js', () => ({
  genericLimiter: (_req, _res, next) => next(),
}));
// abdmService imports these; the verifier doesn't use them and the route test
// spies handleConsentRequest, so stub them to keep the import side-effect-free.
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: jest.fn() },
  setTenant: jest.fn(),
}));
jest.unstable_mockModule('../../services/abdm/abdmCrypto.js', () => ({
  encryptFhirBundle: jest.fn(),
}));
jest.unstable_mockModule('../../services/abdm/abdmGateway.js', () => ({
  default: {},
}));
jest.unstable_mockModule('../../utils/ssrfGuard.js', () => ({
  assertSafeOutboundUrl: jest.fn(),
}));

let abdmService;
let callbackRouter;
let keypair;

beforeAll(async () => {
  abdmService = (await import('../../services/abdm/abdmService.js')).default;
  ({ callbackRouter } = await import('../../routes/abdm/abdmRoutes.js'));
  keypair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
});

const SAVED = {
  enable: process.env.ABDM_VERIFY_CONSENT_ARTEFACT,
  key: process.env.ABDM_CM_PUBLIC_KEY,
};
afterEach(() => {
  process.env.ABDM_VERIFY_CONSENT_ARTEFACT = SAVED.enable;
  process.env.ABDM_CM_PUBLIC_KEY = SAVED.key;
  jest.restoreAllMocks();
});

function signArtefact(payloadObj, privateKey) {
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(JSON.stringify(payloadObj));
  signer.end();
  return signer.sign(privateKey).toString('base64');
}

function caughtCode(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return e.code || e.message;
  }
}

// =============================== verifier (crypto) ===============================
describe('abdmService._verifyConsentArtefact', () => {
  const artefact = { consentId: 'c-1', hiTypes: ['Prescription'], patient: { id: 'abha@sbx' } };

  beforeEach(() => {
    process.env.ABDM_VERIFY_CONSENT_ARTEFACT = 'true';
    process.env.ABDM_CM_PUBLIC_KEY = keypair.publicKey.export({ type: 'spki', format: 'pem' });
  });

  it('accepts a validly CM-signed artefact', () => {
    const signature = signArtefact(artefact, keypair.privateKey);
    expect(caughtCode(() => abdmService._verifyConsentArtefact({
      consentRequestId: 'c-1', consentArtefact: artefact, signature,
    }))).toBeNull();
  });

  it('rejects a tampered signature with ABDM_CONSENT_SIG_INVALID', () => {
    // Signature is computed over DIFFERENT data than the artefact we present.
    const signature = signArtefact({ ...artefact, hiTypes: ['DiagnosticReport'] }, keypair.privateKey);
    expect(caughtCode(() => abdmService._verifyConsentArtefact({
      consentRequestId: 'c-1', consentArtefact: artefact, signature,
    }))).toBe('ABDM_CONSENT_SIG_INVALID');
  });

  it('rejects a missing artefact/signature with ABDM_CONSENT_UNSIGNED', () => {
    expect(caughtCode(() => abdmService._verifyConsentArtefact({
      consentRequestId: 'c-1', consentArtefact: undefined, signature: undefined,
    }))).toBe('ABDM_CONSENT_UNSIGNED');
  });

  it('is a no-op when verification is disabled (flag off)', () => {
    process.env.ABDM_VERIFY_CONSENT_ARTEFACT = 'false';
    expect(caughtCode(() => abdmService._verifyConsentArtefact({
      consentRequestId: 'c-1', consentArtefact: undefined, signature: undefined,
    }))).toBeNull();
  });
});

// ===================== route extraction (the C-4b bug) =====================
describe('POST /abdm/consent/on-notify', () => {
  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use(callbackRouter);
    return app;
  }

  it('threads the CM-signed consentArtefact + signature into handleConsentRequest', async () => {
    const spy = jest.spyOn(abdmService, 'handleConsentRequest')
      .mockResolvedValue({ consent_id: 'test-consent' });

    const consentDetail = {
      consentId: 'cr-9',
      purpose: { code: 'CAREMGT' },
      patient: { id: 'abha@sbx' },
      hiTypes: ['Prescription'],
    };
    const signature = 'Zm9vYmFyc2lnbmF0dXJl';

    const res = await request(buildApp())
      .post('/consent/on-notify')
      .set('x-hip-id', 'TEST_HIP')
      .send({
        notification: {
          consentRequestId: 'cr-9',
          purpose: { code: 'CAREMGT' },
          patient: { id: 'abha@sbx' },
          consentDetail,
          signature,
        },
      });

    expect(res.status).toBe(202);
    expect(spy).toHaveBeenCalledTimes(1);
    const arg = spy.mock.calls[0][0];
    expect(arg.consentArtefact).toEqual(consentDetail);
    expect(arg.signature).toBe(signature);
  });
});
