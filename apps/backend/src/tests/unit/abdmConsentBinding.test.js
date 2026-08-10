/**
 * ABDM consent artefact binding (audit finding #33).
 *
 * The detached CM signature authenticates consentArtefact, not the outer
 * notification wrapper. Every authorization-critical wrapper value must
 * therefore agree with the verified payload, and persistence must use the
 * verified values. The artefact digest is also a one-time replay claim.
 */
import { jest } from '@jest/globals';
import crypto from 'crypto';

const prismaQuery = jest.fn();
const txQuery = jest.fn();
const setTenantMock = jest.fn();
const notifyConsentStatus = jest.fn();

jest.unstable_mockModule('../../config/abdmConfig.js', () => ({
  ABDM_CONFIG: {
    enabled: true,
    hipId: 'HIP-VERIFIED',
    PURPOSES: ['CAREMGT', 'PUBHLTH'],
  },
}));
const __prismaMock = { $queryRawUnsafe: prismaQuery };
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

const TENANT_ID = 'ab100000-0000-4000-8000-00000000b001';
const PATIENT_UID = 'ab100000-0000-4000-8000-0000000007b1';
const SAVED_ENV = {
  enabled: process.env.ABDM_VERIFY_CONSENT_ARTEFACT,
  publicKey: process.env.ABDM_CM_PUBLIC_KEY,
  cmId: process.env.ABDM_CM_ID,
};

let abdmService;
let keypair;

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function signArtefact(artefact) {
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(JSON.stringify(artefact));
  signer.end();
  return signer.sign(keypair.privateKey).toString('base64');
}

function buildArtefact() {
  return {
    schemaVersion: '1.0',
    consentId: 'consent-verified-1',
    patient: { id: '11-1111-1111-1111' },
    hip: { id: 'HIP-VERIFIED' },
    hiu: { id: 'HIU-VERIFIED' },
    consentManager: { id: 'CM-VERIFIED' },
    requester: { name: 'Verified HIU' },
    purpose: { code: 'CAREMGT' },
    hiTypes: ['DiagnosticReport', 'Prescription'],
    permission: {
      dateRange: {
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-12-31T23:59:59.000Z',
      },
      dataEraseAt: '2099-01-31T00:00:00.000Z',
    },
  };
}

function buildRequest(artefact = buildArtefact()) {
  return {
    consentRequestId: artefact.consentId,
    patient: { id: artefact.patient.id },
    hip: { id: artefact.hip.id },
    authenticatedHipId: artefact.hip.id,
    hiu: { id: artefact.hiu.id },
    consentManager: { id: artefact.consentManager.id },
    authenticatedConsentManagerId: artefact.consentManager.id,
    purpose: artefact.purpose.code,
    hiTypes: [...artefact.hiTypes].reverse(),
    dateRange: { ...artefact.permission.dateRange },
    expiry: artefact.permission.dataEraseAt,
    requester: { name: 'Verified HIU' },
    consentArtefact: artefact,
    signature: signArtefact(artefact),
  };
}

function installSuccessfulQueries() {
  txQuery.mockImplementation(async (sql) => {
    if (sql.includes('INSERT INTO interop_replay_guard')) {
      return [{ id: 1 }];
    }
    if (sql.includes('SELECT id FROM abdm_consents')) {
      return [];
    }
    if (sql.includes('INSERT INTO abdm_consents')) {
      return [{
        id: 41,
        consent_id: 'consent-verified-1',
        patient_uid: PATIENT_UID,
        purpose: 'CAREMGT',
        hi_types: ['DiagnosticReport', 'Prescription'],
        status: 'REQUESTED',
      }];
    }
    throw new Error(`Unexpected SQL in ABDM binding test: ${sql}`);
  });
}

beforeAll(async () => {
  abdmService = (await import('../../services/abdm/abdmService.js')).default;
  keypair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
});

beforeEach(() => {
  jest.clearAllMocks();
  notifyConsentStatus.mockResolvedValue(undefined);
  process.env.ABDM_VERIFY_CONSENT_ARTEFACT = 'true';
  process.env.ABDM_CM_PUBLIC_KEY = keypair.publicKey.export({ type: 'spki', format: 'pem' });
  process.env.ABDM_CM_ID = 'CM-VERIFIED';

  jest.spyOn(abdmService, '_resolvePatientTenantByAbha').mockResolvedValue({
    patientUid: PATIENT_UID,
    tenantId: TENANT_ID,
  });
  setTenantMock.mockImplementation(async (_tenantId, callback) => callback({
    $queryRawUnsafe: txQuery,
  }));
  installSuccessfulQueries();
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  restoreEnv('ABDM_VERIFY_CONSENT_ARTEFACT', SAVED_ENV.enabled);
  restoreEnv('ABDM_CM_PUBLIC_KEY', SAVED_ENV.publicKey);
  restoreEnv('ABDM_CM_ID', SAVED_ENV.cmId);
});

const MISMATCH_CASES = [
  ['identity / consent id', (request) => { request.consentRequestId = 'consent-wrapper'; }],
  ['identity / ABHA', (request) => { request.patient.id = '22-2222-2222-2222'; }],
  ['actor / HIP', (request) => { request.hip.id = 'HIP-WRAPPER'; }],
  ['actor / authenticated HIP', (request) => { request.authenticatedHipId = 'HIP-CALLBACK'; }],
  ['actor / HIU', (request) => { request.hiu.id = 'HIU-WRAPPER'; }],
  ['actor / consent manager', (request) => { request.consentManager.id = 'CM-WRAPPER'; }],
  ['actor / authenticated consent manager', (request) => {
    request.authenticatedConsentManagerId = 'CM-CALLBACK';
  }],
  ['scope / purpose', (request) => { request.purpose = 'PUBHLTH'; }],
  ['scope / HI types', (request) => { request.hiTypes = ['Prescription']; }],
  ['temporal / date range from', (request) => {
    request.dateRange.from = '2026-02-01T00:00:00.000Z';
  }],
  ['temporal / date range to', (request) => {
    request.dateRange.to = '2026-11-30T23:59:59.000Z';
  }],
  ['temporal / expiry', (request) => { request.expiry = '2099-02-01T00:00:00.000Z'; }],
];

const MISSING_CASES = [
  ['consent id', (request) => { delete request.consentRequestId; }],
  ['ABHA', (request) => { delete request.patient.id; }],
  ['HIP', (request) => { delete request.hip.id; }],
  ['authenticated HIP', (request) => { delete request.authenticatedHipId; }],
  ['HIU', (request) => { delete request.hiu.id; }],
  ['consent manager', (request) => { delete request.consentManager.id; }],
  ['purpose', (request) => { delete request.purpose; }],
  ['HI types', (request) => { request.hiTypes = []; }],
  ['date range from', (request) => { delete request.dateRange.from; }],
  ['date range to', (request) => { delete request.dateRange.to; }],
  ['expiry', (request) => { delete request.expiry; }],
];

describe('ABDM verified consent artefact binding', () => {
  test.each(MISMATCH_CASES)(
    'rejects a %s mismatch before persistence',
    async (_label, mutateWrapper) => {
      const request = buildRequest();
      mutateWrapper(request);

      await expect(abdmService.handleConsentRequest(request)).rejects.toMatchObject({
        statusCode: 403,
        code: 'ABDM_CONSENT_BINDING_MISMATCH',
      });
      expect(setTenantMock).not.toHaveBeenCalled();
      expect(txQuery).not.toHaveBeenCalled();
    },
  );

  test.each(MISSING_CASES)(
    'rejects a missing %s wrapper field before persistence',
    async (_label, removeWrapperField) => {
      const request = buildRequest();
      removeWrapperField(request);

      await expect(abdmService.handleConsentRequest(request)).rejects.toMatchObject({
        statusCode: 403,
        code: 'ABDM_CONSENT_BINDING_MISMATCH',
      });
      expect(setTenantMock).not.toHaveBeenCalled();
      expect(txQuery).not.toHaveBeenCalled();
    },
  );

  it('rejects a strict callback tenant mismatch before persistence', async () => {
    await expect(abdmService.handleConsentRequest(buildRequest(), {
      callbackTenantId: 'ab100000-0000-4000-8000-00000000c001',
      strict: true,
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'ABDM_CONSENT_BINDING_MISMATCH',
      details: { fields: ['tenant'] },
    });
    expect(setTenantMock).not.toHaveBeenCalled();
  });

  it('rejects reuse of an already-claimed verified artefact hash', async () => {
    txQuery.mockImplementation(async (sql) => {
      if (sql.includes('INSERT INTO interop_replay_guard')) {
        return [];
      }
      throw new Error(`Unexpected SQL after duplicate artefact claim: ${sql}`);
    });

    // Strict per-tenant opts: the mocked patient tenant is non-default, and the
    // legacy non-strict path now refuses non-default tenants outright
    // (guard-now 2026-08-06) before the replay claim under test here.
    await expect(abdmService.handleConsentRequest(buildRequest(), {
      callbackTenantId: TENANT_ID,
      strict: true,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'ABDM_CONSENT_ARTEFACT_REUSED',
    });
    expect(txQuery.mock.calls.some(([sql]) => sql.includes('INSERT INTO abdm_consents'))).toBe(false);
  });

  it('persists matching verified values and returns the created consent unchanged', async () => {
    const request = buildRequest();
    const expectedHash = crypto.createHash('sha256')
      .update(JSON.stringify(request.consentArtefact))
      .digest('hex');
    // Strict per-tenant opts (see the reuse test above for why).
    const result = await abdmService.handleConsentRequest(request, {
      callbackTenantId: TENANT_ID,
      strict: true,
    });

    expect(result).toEqual({
      id: 41,
      consent_id: 'consent-verified-1',
      patient_uid: PATIENT_UID,
      purpose: 'CAREMGT',
      hi_types: ['DiagnosticReport', 'Prescription'],
      status: 'REQUESTED',
    });

    const insertCall = txQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO abdm_consents'));
    expect(insertCall).toBeDefined();
    const [, consentId, patientUid, tenantId, hipId, hiuId, purpose, hiTypes,
      dateFrom, dateTo, expiry, requesterName, evidenceJson] = insertCall;
    expect({ consentId, patientUid, tenantId, hipId, hiuId, purpose, hiTypes, requesterName }).toEqual({
      consentId: 'consent-verified-1',
      patientUid: PATIENT_UID,
      tenantId: TENANT_ID,
      hipId: 'HIP-VERIFIED',
      hiuId: 'HIU-VERIFIED',
      purpose: 'CAREMGT',
      hiTypes: ['DiagnosticReport', 'Prescription'],
      requesterName: 'Verified HIU',
    });
    expect(dateFrom.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(dateTo.toISOString()).toBe('2026-12-31T23:59:59.000Z');
    expect(expiry.toISOString()).toBe('2099-01-31T00:00:00.000Z');
    expect(JSON.parse(evidenceJson)).toEqual({
      verification: {
        signatureVerified: true,
        artefactHash: expectedHash,
        patientAbha: '11-1111-1111-1111',
        consentManagerId: 'CM-VERIFIED',
      },
    });
    const claimCall = txQuery.mock.calls.find(
      ([sql]) => sql.includes('INSERT INTO interop_replay_guard'),
    );
    expect(claimCall.slice(1)).toEqual(['abdm-consent-artefact-sha256', expectedHash]);
  });

  it('preserves verified hash evidence when the patient grants consent', async () => {
    const verifiedArtefactHash = 'a'.repeat(64);
    jest.spyOn(abdmService, '_getConsentForPatient').mockResolvedValue({
      consent_id: 'consent-verified-1',
      patient_uid: PATIENT_UID,
      patient_abha: '22-2222-2222-2222',
      hip_id: 'HIP-VERIFIED',
      hiu_id: 'HIU-VERIFIED',
      purpose: 'CAREMGT',
      hi_types: ['DiagnosticReport', 'Prescription'],
      date_range_from: new Date('2026-01-01T00:00:00.000Z'),
      date_range_to: new Date('2026-12-31T23:59:59.000Z'),
      expiry_date: new Date('2099-01-31T00:00:00.000Z'),
      status: 'REQUESTED',
      consent_artifact: {
        verification: {
          signatureVerified: true,
          artefactHash: verifiedArtefactHash,
          patientAbha: '11-1111-1111-1111',
          consentManagerId: 'CM-SIGNED',
        },
      },
    });
    prismaQuery.mockResolvedValue([{
      id: 41,
      consent_id: 'consent-verified-1',
      patient_uid: PATIENT_UID,
      purpose: 'CAREMGT',
      status: 'GRANTED',
      consent_artifact: { consentId: 'consent-verified-1' },
    }]);

    const result = await abdmService.grantConsent('consent-verified-1', PATIENT_UID);

    expect(result.consent_artifact).toEqual({ consentId: 'consent-verified-1' });
    const [sql, outgoingJson] = prismaQuery.mock.calls.find(
      ([query]) => query.includes('UPDATE abdm_consents'),
    );
    expect(sql).toMatch(/jsonb_set\([\s\S]*\{grantedPayload\}[\s\S]*\$1::jsonb/);
    expect(sql).toMatch(/\$1::jsonb AS consent_artifact/);
    expect(JSON.parse(outgoingJson)).not.toHaveProperty('verifiedArtefactHash');
    expect(notifyConsentStatus).toHaveBeenCalledWith(
      'consent-verified-1',
      'GRANTED',
      expect.objectContaining({
        patient: { id: '11-1111-1111-1111' },
        consentManager: { id: 'CM-SIGNED' },
      }),
    );
  });
});
