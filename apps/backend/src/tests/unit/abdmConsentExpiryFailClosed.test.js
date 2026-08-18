/**
 * ABDM consent-expiry gates fail CLOSED on a NULL expiry.
 *
 * `abdm_consents.expiry_date` is nullable in the schema (000_baseline.sql), and
 * `epochMsOrNull` deliberately returns null for SQL NULL so callers decide what
 * absence means. For consent expiry the documented decision (dbInstant.js) is
 * "a missing consent expiry denies access": the legacy comparison
 * `new Date(null) < new Date()` evaluated NULL as epoch 0 (expired), and the
 * epoch-twin rewrite must preserve that fail-closed posture. This file pins
 * both gates — grantConsent and the HIP data-request export gate — against
 * NULL, past, and future expiry values.
 */
import { jest } from '@jest/globals';

const prismaQuery = jest.fn();
const setTenantMock = jest.fn();
const notifyConsentStatus = jest.fn();

const __prismaMock = { $queryRawUnsafe: prismaQuery };
jest.unstable_mockModule('../../config/abdmConfig.js', () => ({
  ABDM_CONFIG: {
    enabled: false,
    hipId: 'HIP-TEST',
    PURPOSES: ['CAREMGT'],
  },
}));
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaMock,
  setTenant: setTenantMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaMock),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));
jest.unstable_mockModule('../../services/abdm/abdmCrypto.js', () => ({
  encryptFhirBundle: jest.fn(),
}));
jest.unstable_mockModule('../../services/abdm/abdmGateway.js', () => ({
  default: { notifyConsentStatus },
}));
jest.unstable_mockModule('../../utils/ssrfGuard.js', () => ({
  assertSafeOutboundUrl: jest.fn(),
}));

const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'ab200000-0000-4000-8000-0000000007c2';
const CONSENT_ID = 'consent-expiry-1';
const HOUR_MS = 60 * 60 * 1000;

let abdmService;

function consentRow(expiryEpochMs) {
  return {
    id: 7,
    consent_id: CONSENT_ID,
    patient_uid: PATIENT_UID,
    hip_id: 'HIP-TEST',
    hiu_id: 'HIU-TEST',
    purpose: 'CAREMGT',
    hi_types: ['Prescription'],
    date_range_from: '2026-01-01T00:00:00.000Z',
    date_range_to: '2026-12-31T23:59:59.000Z',
    expiry_date: expiryEpochMs == null ? null : new Date(expiryEpochMs),
    expiry_date_epoch_ms: expiryEpochMs == null ? null : BigInt(expiryEpochMs),
    status: 'REQUESTED',
    requester_name: 'Test HIU',
    consent_artifact: null,
    granted_at: null,
    revoked_at: null,
    patient_abha: '11-1111-1111-1111',
  };
}

function dataRequestConsentRow(expiryEpochMs) {
  return {
    consent_id: CONSENT_ID,
    patient_uid: PATIENT_UID,
    tenant_id: DEFAULT_TENANT_ID,
    status: 'GRANTED',
    hi_types: ['Prescription'],
    date_range_from: '2026-01-01T00:00:00.000Z',
    date_range_to: '2026-12-31T23:59:59.000Z',
    expiry_date: expiryEpochMs == null ? null : new Date(expiryEpochMs),
    expiry_date_epoch_ms: expiryEpochMs == null ? null : BigInt(expiryEpochMs),
  };
}

beforeAll(async () => {
  abdmService = (await import('../../services/abdm/abdmService.js')).default;
});

beforeEach(() => {
  jest.clearAllMocks();
  setTenantMock.mockImplementation(async (_tenantId, callback) =>
    callback({ $queryRawUnsafe: prismaQuery }));
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('grantConsent expiry gate', () => {
  function installConsent(expiryEpochMs) {
    jest
      .spyOn(abdmService, '_getConsentForPatient')
      .mockResolvedValue(consentRow(expiryEpochMs));
  }

  it('denies a consent with a NULL expiry (fail-closed) and flips it EXPIRED', async () => {
    installConsent(null);
    prismaQuery.mockResolvedValue([]);

    await expect(abdmService.grantConsent(CONSENT_ID, PATIENT_UID)).rejects.toMatchObject({
      code: 'CONSENT_EXPIRED',
    });

    const expiredFlip = prismaQuery.mock.calls.find(([sql]) =>
      sql.includes("SET status = 'EXPIRED'"));
    expect(expiredFlip).toBeDefined();
  });

  it('denies a consent whose expiry is in the past', async () => {
    installConsent(Date.now() - HOUR_MS);
    prismaQuery.mockResolvedValue([]);

    await expect(abdmService.grantConsent(CONSENT_ID, PATIENT_UID)).rejects.toMatchObject({
      code: 'CONSENT_EXPIRED',
    });
  });

  it('grants a consent whose expiry is in the future', async () => {
    installConsent(Date.now() + HOUR_MS);
    prismaQuery.mockImplementation(async (sql) => {
      if (sql.includes("SET status = 'GRANTED'")) {
        return [{
          id: 7,
          consent_id: CONSENT_ID,
          patient_uid: PATIENT_UID,
          purpose: 'CAREMGT',
          status: 'GRANTED',
        }];
      }
      throw new Error(`Unexpected SQL in grantConsent success path: ${sql}`);
    });

    await expect(abdmService.grantConsent(CONSENT_ID, PATIENT_UID)).resolves.toMatchObject({
      status: 'GRANTED',
    });

    const expiredFlip = prismaQuery.mock.calls.find(([sql]) =>
      sql.includes("SET status = 'EXPIRED'"));
    expect(expiredFlip).toBeUndefined();
  });
});

describe('handleDataRequest expiry gate', () => {
  function installConsentSelect(expiryEpochMs) {
    prismaQuery.mockImplementation(async (sql) => {
      if (sql.includes('FROM abdm_consents')) {
        return [dataRequestConsentRow(expiryEpochMs)];
      }
      if (sql.includes("SET status = 'EXPIRED'")) {
        return [];
      }
      throw new Error(`Unexpected SQL in handleDataRequest test: ${sql}`);
    });
  }

  function request() {
    return {
      transactionId: 'txn-expiry-1',
      consentId: CONSENT_ID,
      hiTypes: ['Prescription'],
    };
  }

  it('refuses export for a consent with a NULL expiry (fail-closed) and flips it EXPIRED', async () => {
    installConsentSelect(null);

    await expect(abdmService.handleDataRequest(request())).rejects.toMatchObject({
      code: 'CONSENT_EXPIRED',
    });

    expect(setTenantMock).toHaveBeenCalledWith(DEFAULT_TENANT_ID, expect.any(Function));
    const expiredFlip = prismaQuery.mock.calls.find(([sql]) =>
      sql.includes("SET status = 'EXPIRED'"));
    expect(expiredFlip).toBeDefined();
  });

  it('refuses export for a consent whose expiry is in the past', async () => {
    installConsentSelect(Date.now() - HOUR_MS);

    await expect(abdmService.handleDataRequest(request())).rejects.toMatchObject({
      code: 'CONSENT_EXPIRED',
    });
  });

  it('passes the gate for a consent whose expiry is in the future', async () => {
    installConsentSelect(Date.now() + HOUR_MS);

    // Request an HI type outside the granted set so the run stops at the very
    // next guard — proving the expiry gate let a future-dated consent through
    // without mocking the whole export pipeline.
    await expect(
      abdmService.handleDataRequest({
        transactionId: 'txn-expiry-2',
        consentId: CONSENT_ID,
        hiTypes: ['DiagnosticReport'],
      }),
    ).rejects.toMatchObject({ code: 'ABDM_HITYPE_OUT_OF_SCOPE' });

    const expiredFlip = prismaQuery.mock.calls.find(([sql]) =>
      sql.includes("SET status = 'EXPIRED'"));
    expect(expiredFlip).toBeUndefined();
  });
});
