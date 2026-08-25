/**
 * ABHA enrolment state machine (migration 701) — unit suite, gateway mocked.
 *
 * Pins the four things the enrolment flow must never get wrong:
 *   1. The privacy contract: NO Aadhaar material in any persisted arg, any log
 *      line, or any gateway payload other than as RSA ciphertext (asserted by
 *      decrypting the ciphertext with the test key and scanning every other
 *      mock surface for the digits).
 *   2. The state machine: start → otp_sent → linked; OTP attempt cap; expiry;
 *      gateway OTP rejection keeps the session retryable.
 *   3. The 653 verified gate: linking rides users.abha_verification_status =
 *      'verified' + a same-tx clinical_audit_events row (identity — no
 *      timeline event), and a canonical-unique conflict maps to 409
 *      ABHA_ALREADY_LINKED with the session failed as abha_already_linked.
 *   4. Config gating: ABDM_ENABLED and tenants.settings.abdmEnrolment.enabled
 *      are both required (503 / 403 fail-closed).
 */
import { jest } from '@jest/globals';
import crypto from 'crypto';

const prismaQuery = jest.fn();
const prismaExecute = jest.fn();
const fetchEnrolmentPublicCertificate = jest.fn();
const requestEnrolmentOtp = jest.fn();
const enrolByAadhaar = jest.fn();
const verifyMobileOtp = jest.fn();
const recordClinicalAuditEventMock = jest.fn();
const getAbdmEnrolmentSettings = jest.fn();
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

jest.unstable_mockModule('../../config/abdmConfig.js', () => ({
  ABDM_CONFIG: {
    enabled: true,
    environment: 'sandbox',
    cmId: 'sbx',
    hipId: 'TEST_HIP',
    abhaEnrolmentBaseUrl: 'https://abhasbx.abdm.gov.in/abha/api/v3',
    PURPOSES: ['CAREMGT'],
  },
}));
const __prismaMock = { $queryRawUnsafe: prismaQuery, $executeRawUnsafe: prismaExecute };
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaMock,
  setTenant: jest.fn(),
  setTenantTx: async (_tenantId, fn) => fn(__prismaMock),
  setSystemJobTx: async (fn) => fn(__prismaMock),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({ default: loggerMock }));
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordClinicalAuditEvent: recordClinicalAuditEventMock,
}));
jest.unstable_mockModule('../../services/tenant/tenantSettingsService.js', () => ({
  getAbdmEnrolmentSettings,
  getAbdmHiuSettings: jest.fn(),
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: (tenantId) => {
    if (!tenantId) {
      const err = new Error('Tenant context is required');
      err.isOperational = true;
      err.statusCode = 403;
      err.code = 'TENANT_REQUIRED';
      throw err;
    }
    return tenantId;
  },
  DEFAULT_TENANT_ID: '00000000-0000-4000-8000-000000000001',
}));
jest.unstable_mockModule('../../services/abdm/abdmGateway.js', () => ({
  default: {
    fetchEnrolmentPublicCertificate,
    requestEnrolmentOtp,
    enrolByAadhaar,
    verifyMobileOtp,
  },
}));

const {
  default: enrolmentService,
  verhoeffValidate,
  requireValidAadhaar,
} = await import('../../services/abdm/abhaEnrolmentService.js');

const TENANT_ID = '70100000-0000-4000-8000-00000000b001';
const PATIENT_UID = '70100000-0000-4000-8000-0000000007b1';
const CLAIM_ID = '70100000-0000-4000-8000-00000000c1a1';

// RSA pair for the enrolment certificate: the service must encrypt with the
// PUBLIC key; the test holds the private key to prove the ciphertext decrypts
// to exactly the input (and nothing else carries it).
const { publicKey: RSA_PUBLIC, privateKey: RSA_PRIVATE } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const RSA_PUBLIC_PEM = RSA_PUBLIC.export({ type: 'spki', format: 'pem' }).toString();

function rsaDecrypt(b64) {
  return crypto.privateDecrypt(
    { key: RSA_PRIVATE, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING },
    Buffer.from(b64, 'base64'),
  ).toString('utf8');
}

// A Verhoeff-valid Aadhaar fixture, derived from the service's own validator
// (self-consistency) — plus the independent known vector below.
const VALID_AADHAAR = (() => {
  const base = '23412341234';
  for (let d = 0; d <= 9; d += 1) {
    if (verhoeffValidate(base + d)) return base + d;
  }
  throw new Error('no valid check digit found');
})();

const BASE_SESSION = {
  id: 11,
  tenant_id: TENANT_ID,
  patient_uid: PATIENT_UID,
  flow: 'aadhaar_otp',
  environment: 'sandbox',
  status: 'otp_sent',
  otp_attempts: 0,
  mobile_last4: null,
  abha_number: null,
  abha_address: null,
  error_code: null,
  txn_id: 'txn-001',
  metadata: {},
  resend_count: 0,
  resend_claim_id: null,
  resend_claimed_at: null,
  otp_sent_at: new Date(),
  expires_at: new Date(Date.now() + 10 * 60 * 1000),
  created_at: new Date(),
};

/** Route prisma calls on SQL substrings; tests override entries per case. */
let routes;
function route(sqlIncludes, impl) {
  routes.unshift([sqlIncludes, impl]);
}
// loadSession selects an epoch-millisecond twin beside `expires_at`, because a
// timestamptz materialised by the pg driver is shifted by the database session
// timezone and the expiry check compares against the process clock. Postgres
// computes that column, so this double derives it centrally rather than per
// fixture — otherwise a fixture omits it, the service reads undefined, and an
// expired session silently looks like one with no expiry set.
// An explicitly supplied twin wins, so a test can still pin an odd value.
const EPOCH_TWIN_COLUMNS = [['expires_at', 'expires_at_epoch_ms']];
function withDerivedEpochs(row) {
  if (!row || typeof row !== 'object') return row;
  let out = row;
  for (const [source, twin] of EPOCH_TWIN_COLUMNS) {
    if (source in out && !(twin in out)) {
      const ms = out[source] == null ? NaN : new Date(out[source]).getTime();
      out = { ...out, [twin]: Number.isFinite(ms) ? BigInt(ms) : null };
    }
  }
  return out;
}
function dispatch(sql, args) {
  for (const [needle, impl] of routes) {
    if (sql.includes(needle)) {
      const rows = impl(sql, args);
      return Array.isArray(rows) ? rows.map(withDerivedEpochs) : rows;
    }
  }
  return [];
}

beforeEach(() => {
  jest.clearAllMocks();
  routes = [];
  prismaQuery.mockImplementation(async (sql, ...args) => dispatch(sql, args));
  prismaExecute.mockImplementation(async (sql, ...args) => dispatch(sql, args));
  getAbdmEnrolmentSettings.mockResolvedValue({ enabled: true });
  fetchEnrolmentPublicCertificate.mockResolvedValue({ publicKey: RSA_PUBLIC_PEM });
  requestEnrolmentOtp.mockResolvedValue({ txnId: 'txn-001' });

  // Default happy-path rows.
  route('FROM users', () => [{
    uid: PATIENT_UID, abha_number: null, abha_verification_status: 'pending',
  }]);
  route('INSERT INTO abha_enrolment_sessions', () => [{ ...BASE_SESSION, status: 'initiated', txn_id: null }]);
  route("status = 'otp_sent', otp_sent_at", () => [BASE_SESSION]);
  route("SET status = 'otp_verifying'", () => [{
    ...BASE_SESSION,
    status: 'otp_verifying',
    otp_attempts: 1,
    verification_claim_id: CLAIM_ID,
    verification_claimed_at: new Date(),
  }]);
  route('SET resend_count = resend_count + 1', (_sql, args) => [{
    ...BASE_SESSION,
    resend_count: 1,
    resend_claim_id: args[3],
    resend_claimed_at: new Date(),
  }]);
  route('SELECT id, tenant_id, patient_uid, flow', () => [BASE_SESSION]);
  route("SET abha_number = $1", () => [{ uid: PATIENT_UID }]);
  route("status = 'linked'", () => [{
    ...BASE_SESSION,
    status: 'linked',
    abha_number: '91-1234-5678-9012',
    abha_address: 'newuser@sbx',
    enrolled_at: new Date(),
    linked_at: new Date(),
  }]);
});

/** Every string that crossed a mock boundary, EXCLUDING nothing. */
function allMockSurfaces() {
  const chunks = [];
  for (const call of prismaQuery.mock.calls) chunks.push(JSON.stringify(call));
  for (const call of prismaExecute.mock.calls) chunks.push(JSON.stringify(call));
  for (const fn of [loggerMock.info, loggerMock.warn, loggerMock.error]) {
    for (const call of fn.mock.calls) chunks.push(JSON.stringify(call));
  }
  for (const call of recordClinicalAuditEventMock.mock.calls) chunks.push(JSON.stringify(call));
  for (const fn of [requestEnrolmentOtp, enrolByAadhaar, verifyMobileOtp]) {
    for (const call of fn.mock.calls) chunks.push(JSON.stringify(call));
  }
  return chunks.join('\n');
}

describe('Verhoeff validation', () => {
  it('accepts the independent known vector 2363 (check digit of 236 is 3)', () => {
    expect(verhoeffValidate('2363')).toBe(true);
    expect(verhoeffValidate('2364')).toBe(false);
  });

  it('rejects a mutated check digit on the Aadhaar fixture', () => {
    const mutated = VALID_AADHAAR.slice(0, 11)
      + String((Number(VALID_AADHAAR[11]) + 1) % 10);
    expect(verhoeffValidate(mutated)).toBe(false);
    expect(() => requireValidAadhaar(mutated)).toThrow(
      expect.objectContaining({ code: 'INVALID_AADHAAR' }),
    );
  });

  it('rejects non-12-digit and 0/1-prefixed values without echoing them', () => {
    for (const bad of ['12345', '123456789012', 'aaaaaaaaaaaa', '']) {
      try {
        requireValidAadhaar(bad);
        throw new Error('should have thrown');
      } catch (err) {
        expect(err.code).toBe('INVALID_AADHAAR');
        expect(err.message).not.toContain(bad || 'EMPTY');
      }
    }
  });
});

describe('startEnrolment', () => {
  it('creates the session, encrypts the Aadhaar for the gateway, and stamps otp_sent', async () => {
    const session = await enrolmentService.startEnrolment({
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      aadhaarNumber: VALID_AADHAAR,
    });

    expect(session.status).toBe('otp_sent');
    // Public projection never leaks the gateway txn or profile snapshot.
    expect(session).not.toHaveProperty('txn_id');
    expect(session).not.toHaveProperty('profile_snapshot');

    // The gateway received RSA ciphertext that decrypts to the Aadhaar…
    expect(requestEnrolmentOtp).toHaveBeenCalledTimes(1);
    const arg = requestEnrolmentOtp.mock.calls[0][0];
    expect(arg.scope).toBe('abha-enrol');
    expect(arg.encryptedValue).not.toContain(VALID_AADHAAR);
    expect(rsaDecrypt(arg.encryptedValue)).toBe(VALID_AADHAAR);
  });

  it('NEVER persists or logs Aadhaar material anywhere (privacy contract)', async () => {
    await enrolmentService.startEnrolment({
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      aadhaarNumber: VALID_AADHAAR,
    });

    expect(allMockSurfaces()).not.toContain(VALID_AADHAAR);
  });

  it('rejects a live-session double start as 409 ABHA_ENROLMENT_IN_PROGRESS', async () => {
    route('INSERT INTO abha_enrolment_sessions', () => {
      throw new Error('duplicate key value violates unique constraint "ux_abha_enrolment_patient_live"');
    });

    await expect(enrolmentService.startEnrolment({
      tenantId: TENANT_ID, patientUid: PATIENT_UID, aadhaarNumber: VALID_AADHAAR,
    })).rejects.toMatchObject({ code: 'ABHA_ENROLMENT_IN_PROGRESS', statusCode: 409 });
    expect(requestEnrolmentOtp).not.toHaveBeenCalled();
  });

  it('collapses a replayed gateway txn on the 701 unique (409 TXN_REPLAY, session failed)', async () => {
    route("status = 'otp_sent', otp_sent_at", () => {
      throw new Error('duplicate key value violates unique constraint "ux_abha_enrolment_tenant_txn"');
    });

    await expect(enrolmentService.startEnrolment({
      tenantId: TENANT_ID, patientUid: PATIENT_UID, aadhaarNumber: VALID_AADHAAR,
    })).rejects.toMatchObject({ code: 'ABHA_ENROLMENT_TXN_REPLAY', statusCode: 409 });
    const failSql = prismaExecute.mock.calls.map((c) => c[0]).join('\n');
    expect(failSql).toContain("status = 'failed'");
  });

  it('marks the session failed when the gateway OTP request fails', async () => {
    requestEnrolmentOtp.mockRejectedValue(Object.assign(
      new Error('gateway down'), { isOperational: true, statusCode: 500 },
    ));

    await expect(enrolmentService.startEnrolment({
      tenantId: TENANT_ID, patientUid: PATIENT_UID, aadhaarNumber: VALID_AADHAAR,
    })).rejects.toMatchObject({ message: 'gateway down' });
    const failCall = prismaExecute.mock.calls.find((c) => c[0].includes("status = 'failed'"));
    expect(failCall).toBeDefined();
    expect(failCall.slice(1)).toContain('otp_request_failed');
  });

  it('refuses a patient who already holds a verified ABHA (653 gate)', async () => {
    route('FROM users', () => [{
      uid: PATIENT_UID, abha_number: '91-0000-0000-0001', abha_verification_status: 'verified',
    }]);

    await expect(enrolmentService.startEnrolment({
      tenantId: TENANT_ID, patientUid: PATIENT_UID, aadhaarNumber: VALID_AADHAAR,
    })).rejects.toMatchObject({ code: 'ABHA_ALREADY_VERIFIED', statusCode: 409 });
  });

  it('fails closed: 403 ABDM_ENROLMENT_DISABLED while the tenant setting is off', async () => {
    getAbdmEnrolmentSettings.mockResolvedValue({ enabled: false });

    await expect(enrolmentService.startEnrolment({
      tenantId: TENANT_ID, patientUid: PATIENT_UID, aadhaarNumber: VALID_AADHAAR,
    })).rejects.toMatchObject({ code: 'ABDM_ENROLMENT_DISABLED', statusCode: 403 });
    expect(prismaQuery).not.toHaveBeenCalled();
    expect(requestEnrolmentOtp).not.toHaveBeenCalled();
  });

  it('validates the Aadhaar BEFORE any DB or gateway work', async () => {
    await expect(enrolmentService.startEnrolment({
      tenantId: TENANT_ID, patientUid: PATIENT_UID, aadhaarNumber: '123456789012',
    })).rejects.toMatchObject({ code: 'INVALID_AADHAAR' });
    expect(prismaQuery).not.toHaveBeenCalled();
    expect(fetchEnrolmentPublicCertificate).not.toHaveBeenCalled();
  });
});

describe('verifyEnrolmentOtp — happy path to linked', () => {
  beforeEach(() => {
    enrolByAadhaar.mockResolvedValue({
      txnId: 'txn-001',
      isNew: true,
      ABHAProfile: {
        ABHANumber: '91-1234-5678-9012',
        phrAddress: ['newuser@sbx'],
        firstName: 'Asha', lastName: 'Patient', gender: 'F',
        yearOfBirth: '1990', mobile: '9876543210',
      },
    });
  });

  it('links through the 653 verified gate with the same-tx audit row', async () => {
    const session = await enrolmentService.verifyEnrolmentOtp({
      tenantId: TENANT_ID, sessionId: 11, patientUid: PATIENT_UID, otp: '123456',
    });

    expect(session.status).toBe('linked');
    // users UPDATE mints 'verified' — gateway-issued, verified by construction.
    const usersUpdate = prismaQuery.mock.calls.find((c) => c[0].includes("abha_verification_status = 'verified'"));
    expect(usersUpdate).toBeDefined();
    expect(usersUpdate[1]).toBe('91-1234-5678-9012');
    // Identity split: audit row yes (same tx), timeline row never.
    expect(recordClinicalAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ABHA_ENROLLED',
        patientUid: PATIENT_UID,
        tenantId: TENANT_ID,
        idempotencyKey: 'abha-enrol:11:linked',
        metadata: expect.objectContaining({ verification_status: 'verified', gateway_issued: true }),
      }),
      expect.objectContaining({ db: expect.anything() }),
    );
    const allSql = prismaQuery.mock.calls.map((c) => c[0]).join('\n');
    expect(allSql).not.toContain('clinical_timeline_events');
    // The OTP reached the gateway only as RSA ciphertext.
    const gatewayArg = enrolByAadhaar.mock.calls[0][0];
    expect(rsaDecrypt(gatewayArg.encryptedOtp)).toBe('123456');
  });

  it('sanitizes the profile snapshot: allowlist only, mobile reduced to last4', async () => {
    enrolByAadhaar.mockResolvedValue({
      ABHAProfile: {
        ABHANumber: '91-1234-5678-9012',
        firstName: 'Asha',
        mobile: '9876543210',
        photo: 'base64bytes-should-drop',
        maskedAadhaar: 'xxxx-xxxx-1234',
      },
    });

    await enrolmentService.verifyEnrolmentOtp({
      tenantId: TENANT_ID, sessionId: 11, patientUid: PATIENT_UID, otp: '123456',
    });

    const linkedUpdate = prismaQuery.mock.calls.find((c) => c[0].includes("status = 'linked'"));
    const snapshot = JSON.parse(linkedUpdate[5]);
    expect(snapshot).toEqual({ firstName: 'Asha', mobile_last4: '3210' });
  });

  it('never carries Aadhaar or OTP material into persisted args or logs', async () => {
    await enrolmentService.verifyEnrolmentOtp({
      tenantId: TENANT_ID, sessionId: 11, patientUid: PATIENT_UID, otp: '123456',
    });
    const surfaces = allMockSurfaces();
    expect(surfaces).not.toContain(VALID_AADHAAR);
    // The plaintext OTP appears nowhere except the encrypted gateway field
    // (which we already proved is ciphertext): scan everything but that field.
    const withoutGateway = surfaces.replace(
      JSON.stringify(enrolByAadhaar.mock.calls[0]), '',
    );
    expect(withoutGateway).not.toMatch(/"123456"/);
  });
});

describe('verifyEnrolmentOtp — failure modes', () => {
  it('caps OTP attempts at 3 and fails the session', async () => {
    let loads = 0;
    route('SELECT id, tenant_id, patient_uid, flow', () => {
      loads += 1;
      return [{ ...BASE_SESSION, otp_attempts: loads > 1 ? 3 : 0 }];
    });
    route("SET status = 'otp_verifying'", () => []);

    await expect(enrolmentService.verifyEnrolmentOtp({
      tenantId: TENANT_ID, sessionId: 11, patientUid: PATIENT_UID, otp: '123456',
    })).rejects.toMatchObject({ code: 'ABHA_ENROLMENT_OTP_ATTEMPTS_EXCEEDED', statusCode: 429 });
    const failCall = prismaExecute.mock.calls.find((c) => c[0].includes("status = 'failed'"));
    expect(failCall[0]).toContain("error_code = 'otp_attempts_exceeded'");
    expect(enrolByAadhaar).not.toHaveBeenCalled();
  });

  it('expires a session past expires_at instead of calling the gateway', async () => {
    route('SELECT id, tenant_id, patient_uid, flow', () => [{
      ...BASE_SESSION, expires_at: new Date(Date.now() - 1000),
    }]);

    await expect(enrolmentService.verifyEnrolmentOtp({
      tenantId: TENANT_ID, sessionId: 11, patientUid: PATIENT_UID, otp: '123456',
    })).rejects.toMatchObject({ code: 'ABHA_ENROLMENT_EXPIRED' });
    const expireCall = prismaExecute.mock.calls.find((c) => c[0].includes("status = 'expired'"));
    expect(expireCall).toBeDefined();
    expect(enrolByAadhaar).not.toHaveBeenCalled();
  });

  it('keeps the session retryable when the gateway rejects the OTP below the cap', async () => {
    enrolByAadhaar.mockRejectedValue(Object.assign(new Error('OTP mismatch'), {
      isOperational: true, statusCode: 500,
    }));
    route('SET status = $4::text', (sql, args) => [{
      ...BASE_SESSION, status: args[3], otp_attempts: 1,
    }]);

    await expect(enrolmentService.verifyEnrolmentOtp({
      tenantId: TENANT_ID, sessionId: 11, patientUid: PATIENT_UID, otp: '123456',
    })).rejects.toMatchObject({ code: 'ABHA_ENROLMENT_OTP_REJECTED', statusCode: 400 });
    const releaseCall = prismaQuery.mock.calls.find((c) => c[0].includes('verification_claim_id = NULL'));
    expect(releaseCall[4]).toBe('otp_sent');
  });

  it('maps the 653 canonical-unique conflict to 409 and fails the session as abha_already_linked', async () => {
    enrolByAadhaar.mockResolvedValue({
      ABHAProfile: { ABHANumber: '91-1234-5678-9012' },
    });
    route("SET abha_number = $1", () => {
      throw Object.assign(new Error('duplicate key value violates unique constraint "uniq_users_tenant_abha_number_canonical"'), {});
    });

    await expect(enrolmentService.verifyEnrolmentOtp({
      tenantId: TENANT_ID, sessionId: 11, patientUid: PATIENT_UID, otp: '123456',
    })).rejects.toMatchObject({ code: 'ABHA_ALREADY_LINKED', statusCode: 409 });
    const failCall = prismaExecute.mock.calls.find((c) => c[0].includes("error_code = 'abha_already_linked'"));
    expect(failCall).toBeDefined();
    // The enrolment evidence (the ABHA the gateway issued) is preserved.
    expect(failCall[0]).toContain('abha_number = $3');
  });

  it('returns a linked session as a replay-safe terminal result', async () => {
    route('SELECT id, tenant_id, patient_uid, flow', () => [{ ...BASE_SESSION, status: 'linked' }]);

    await expect(enrolmentService.verifyEnrolmentOtp({
      tenantId: TENANT_ID, sessionId: 11, patientUid: PATIENT_UID, otp: '123456',
    })).resolves.toMatchObject({ status: 'linked' });
    expect(enrolByAadhaar).not.toHaveBeenCalled();
  });

  it('returns the linked terminal row when a concurrent verifier wins before claim', async () => {
    let loads = 0;
    route('SELECT id, tenant_id, patient_uid, flow', () => {
      loads += 1;
      return [{
        ...BASE_SESSION,
        status: loads > 1 ? 'linked' : 'otp_sent',
        abha_number: loads > 1 ? '91-1234-5678-9012' : null,
        enrolled_at: loads > 1 ? new Date() : null,
      }];
    });
    route("SET status = 'otp_verifying'", () => []);

    const result = await enrolmentService.verifyEnrolmentOtp({
      tenantId: TENANT_ID, sessionId: 11, patientUid: PATIENT_UID, otp: '123456',
    });
    expect(result.status).toBe('linked');
    expect(enrolByAadhaar).not.toHaveBeenCalled();
    expect(prismaExecute.mock.calls.some((call) => call[0].includes("status = 'failed'"))).toBe(false);
  });

  it('does not update the patient when a stale verification claim loses its terminal CAS', async () => {
    route("status = 'linked'", () => []);
    await expect(enrolmentService.verifyEnrolmentOtp({
      tenantId: TENANT_ID, sessionId: 11, patientUid: PATIENT_UID, otp: '123456',
    })).rejects.toMatchObject({ code: 'ABHA_ENROLMENT_VERIFY_SUPERSEDED' });
    const usersUpdate = prismaQuery.mock.calls.find(
      (call) => call[0].includes("abha_verification_status = 'verified'"),
    );
    expect(usersUpdate).toBeUndefined();
  });
});

describe('resend / cancel / status / sweep', () => {
  it('resendOtp re-requires the Aadhaar (never stored), resets attempts, caps resends', async () => {
    route('SELECT id, tenant_id, patient_uid, flow', () => [{
      ...BASE_SESSION, resend_count: 1, metadata: { resend_count: 1 },
    }]);
    route('SET resend_count = resend_count + 1', (_sql, args) => [{
      ...BASE_SESSION,
      resend_count: 2,
      resend_claim_id: args[3],
      resend_claimed_at: new Date(),
    }]);
    route('otp_attempts = 0', () => [{ ...BASE_SESSION }]);

    await enrolmentService.resendEnrolmentOtp({
      tenantId: TENANT_ID, sessionId: 11, patientUid: PATIENT_UID, aadhaarNumber: VALID_AADHAAR,
    });
    const arg = requestEnrolmentOtp.mock.calls[0][0];
    expect(arg.txnId).toBe('txn-001');
    expect(rsaDecrypt(arg.encryptedValue)).toBe(VALID_AADHAAR);
    expect(allMockSurfaces()).not.toContain(VALID_AADHAAR);

    // Cap: resend_count 3 refuses.
    route('SELECT id, tenant_id, patient_uid, flow', () => [{
      ...BASE_SESSION, resend_count: 3, metadata: { resend_count: 3 },
    }]);
    await expect(enrolmentService.resendEnrolmentOtp({
      tenantId: TENANT_ID, sessionId: 11, patientUid: PATIENT_UID, aadhaarNumber: VALID_AADHAAR,
    })).rejects.toMatchObject({ code: 'ABHA_ENROLMENT_RESEND_EXCEEDED', statusCode: 429 });
  });

  it('admits only one concurrent resend claim and sends only once', async () => {
    let claimAttempts = 0;
    let releaseGateway;
    requestEnrolmentOtp.mockImplementationOnce(() => new Promise((resolve) => {
      releaseGateway = resolve;
    }));
    route('SELECT id, tenant_id, patient_uid, flow', () => [{
      ...BASE_SESSION,
      resend_claim_id: claimAttempts > 0 ? CLAIM_ID : null,
      resend_claimed_at: claimAttempts > 0 ? new Date() : null,
    }]);
    route('SET resend_count = resend_count + 1', (_sql, args) => {
      claimAttempts += 1;
      return claimAttempts === 1 ? [{
        ...BASE_SESSION,
        resend_count: 1,
        resend_claim_id: args[3],
        resend_claimed_at: new Date(),
      }] : [];
    });
    route('otp_attempts = 0', () => [{ ...BASE_SESSION, resend_count: 1 }]);

    const first = enrolmentService.resendEnrolmentOtp({
      tenantId: TENANT_ID,
      sessionId: 11,
      patientUid: PATIENT_UID,
      aadhaarNumber: VALID_AADHAAR,
    });
    await new Promise(setImmediate);
    await expect(enrolmentService.resendEnrolmentOtp({
      tenantId: TENANT_ID,
      sessionId: 11,
      patientUid: PATIENT_UID,
      aadhaarNumber: VALID_AADHAAR,
    })).rejects.toMatchObject({ code: 'ABHA_ENROLMENT_RESEND_IN_PROGRESS', statusCode: 409 });

    releaseGateway({ txnId: 'txn-002' });
    await expect(first).resolves.toMatchObject({ status: 'otp_sent' });
    expect(requestEnrolmentOtp).toHaveBeenCalledTimes(1);
    expect(claimAttempts).toBe(2);
  });

  it('releases a failed resend lease without decrementing the durable count', async () => {
    requestEnrolmentOtp.mockRejectedValueOnce(new Error('gateway unavailable'));
    route('resend_claim_id = NULL, resend_claimed_at = NULL', () => []);

    await expect(enrolmentService.resendEnrolmentOtp({
      tenantId: TENANT_ID,
      sessionId: 11,
      patientUid: PATIENT_UID,
      aadhaarNumber: VALID_AADHAAR,
    })).rejects.toThrow('gateway unavailable');

    const release = prismaExecute.mock.calls.find(
      ([sql]) => sql.includes('resend_claim_id = NULL, resend_claimed_at = NULL'),
    );
    expect(release).toBeDefined();
    expect(release[0]).not.toContain('resend_count = resend_count -');
  });

  // ---------------------------------------------------------------------
  // 'otp_verifying' is a LIVE status (LIVE_STATUSES, and the migration-707
  // one-live-session unique index), so a row sitting in it holds the
  // patient's only enrolment slot. Cancel used to omit it from its WHERE and
  // answer 404, which left the patient unable to start again until the
  // 5-minute expiry sweep passed the row's expires_at.
  // ---------------------------------------------------------------------

  it('cancelEnrolment retires an otp_verifying session whose claim went stale', async () => {
    route("status = 'cancelled'", () => [{ ...BASE_SESSION, status: 'cancelled' }]);

    const session = await enrolmentService.cancelEnrolment({
      tenantId: TENANT_ID, sessionId: 11, patientUid: PATIENT_UID,
    });
    expect(session.status).toBe('cancelled');

    // The predicate, not just the outcome: the mock would answer any WHERE.
    const [sql, ...args] = prismaQuery.mock.calls.at(-1);
    expect(sql).toContain("status = 'otp_verifying'");
    // ...but only once the claim is older than the verifier reclaim TTL, so a
    // verifier that is still inside the gateway call is not cancelled under.
    expect(sql).toContain('verification_claimed_at <=');
    expect(args).toContain(5); // OTP_VERIFY_CLAIM_TTL_MINUTES
    // The claim token is cleared with the row, mirroring the expiry sweep.
    expect(sql).toContain('verification_claim_id = NULL');
  });

  it('cancelEnrolment refuses while an OTP verification claim is still fresh', async () => {
    // The UPDATE matches nothing (fresh claim fails the age guard)...
    route("status = 'cancelled'", () => []);
    // ...and the row is still there, in otp_verifying.
    route('SELECT id FROM abha_enrolment_sessions', () => [{ id: 11 }]);

    await expect(enrolmentService.cancelEnrolment({
      tenantId: TENANT_ID, sessionId: 11, patientUid: PATIENT_UID,
    })).rejects.toMatchObject({
      code: 'ABHA_ENROLMENT_VERIFY_IN_PROGRESS',
      statusCode: 409,
    });
  });

  it('cancelEnrolment cancels only live sessions', async () => {
    route("status = 'cancelled'", () => [{ ...BASE_SESSION, status: 'cancelled' }]);
    const session = await enrolmentService.cancelEnrolment({
      tenantId: TENANT_ID, sessionId: 11, patientUid: PATIENT_UID,
    });
    expect(session.status).toBe('cancelled');

    route("status = 'cancelled'", () => []);
    await expect(enrolmentService.cancelEnrolment({
      tenantId: TENANT_ID, sessionId: 11, patientUid: PATIENT_UID,
    }))
      .rejects.toMatchObject({ code: 'ABHA_ENROLMENT_SESSION_NOT_FOUND' });
  });

  it('binds OTP, resend and cancel operations to the expected patient UID', async () => {
    route('SELECT id, tenant_id, patient_uid, flow', () => []);
    await expect(enrolmentService.verifyEnrolmentOtp({
      tenantId: TENANT_ID,
      sessionId: 11,
      patientUid: '70300000-0000-4000-8000-0000000007b4',
      otp: '123456',
    })).rejects.toMatchObject({ code: 'ABHA_ENROLMENT_SESSION_NOT_FOUND' });
    expect(prismaQuery.mock.calls.at(-1)[0]).toContain('patient_uid = $3::uuid');

    await expect(enrolmentService.resendEnrolmentOtp({
      tenantId: TENANT_ID,
      sessionId: 11,
      patientUid: '70300000-0000-4000-8000-0000000007b4',
      aadhaarNumber: VALID_AADHAAR,
    })).rejects.toMatchObject({ code: 'ABHA_ENROLMENT_SESSION_NOT_FOUND' });

    route("status = 'cancelled'", () => []);
    await expect(enrolmentService.cancelEnrolment({
      tenantId: TENANT_ID,
      sessionId: 11,
      patientUid: '70300000-0000-4000-8000-0000000007b4',
    })).rejects.toMatchObject({ code: 'ABHA_ENROLMENT_SESSION_NOT_FOUND' });
    expect(prismaQuery.mock.calls.at(-1)[0]).toContain('patient_uid = $3::uuid');
  });

  it('getEnrolmentStatus returns the safe projection (or null)', async () => {
    route('ORDER BY created_at DESC LIMIT 1', () => [BASE_SESSION]);
    const status = await enrolmentService.getEnrolmentStatus({
      tenantId: TENANT_ID, patientUid: PATIENT_UID,
    });
    expect(status.session.id).toBe(11);
    expect(status.session).not.toHaveProperty('txn_id');

    route('ORDER BY created_at DESC LIMIT 1', () => []);
    const empty = await enrolmentService.getEnrolmentStatus({
      tenantId: TENANT_ID, patientUid: PATIENT_UID,
    });
    expect(empty.session).toBeNull();
  });

  it('sweep expires live sessions past expires_at', async () => {
    route("SET status = 'expired'", () => [{ id: 1 }, { id: 2 }]);
    const result = await enrolmentService.sweepExpiredEnrolmentSessions();
    expect(result).toEqual({ expired: 2 });
  });

  it('requires a tenant context on every entry point', async () => {
    await expect(enrolmentService.startEnrolment({ patientUid: PATIENT_UID, aadhaarNumber: VALID_AADHAAR }))
      .rejects.toMatchObject({ code: 'TENANT_REQUIRED' });
    await expect(enrolmentService.getEnrolmentStatus({ patientUid: PATIENT_UID }))
      .rejects.toMatchObject({ code: 'TENANT_REQUIRED' });
  });
});
