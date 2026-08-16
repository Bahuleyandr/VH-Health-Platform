// ABHA enrolment → verified-link (migrations 701 + 653) — deep suite.
//
// The gateway is mocked (scripted OTP/enrol responses against a real RSA
// certificate pair); everything else — enrolment service, prisma, the 701
// session table with its CHECKs/uniques, the 653 canonical verified unique on
// users, and the canonical audit writer — runs for real against the test
// Postgres. Self-skips when unconfigured.
//
// Pins:
//   1. The happy path lands the full evidence chain: session otp_sent →
//      linked, users.abha_verification_status='verified' (gateway-issued ⇒
//      verified by construction), and the ABHA_ENROLLED clinical_audit_events
//      row from the same transaction. No clinical_timeline_events row —
//      identity, not clinical care.
//   2. The 653 gate holds under enrolment: a second patient enrolling the
//      SAME ABHA hits the canonical partial unique → 409 ABHA_ALREADY_LINKED,
//      session failed with error_code abha_already_linked while KEEPING the
//      gateway-issued evidence columns.
//   3. The 701 constraints are live: result-evidence CHECK, txn-presence
//      CHECK, and the (tenant, txn, environment) unique.
//
// PRIVACY: the Aadhaar fixture must never appear in any persisted row — the
// suite greps the session + audit rows for the digits.

import { jest } from '@jest/globals';
import crypto from 'crypto';

process.env.ABDM_ENABLED = 'true';
process.env.ABDM_HIP_ID = 'enrol-test-hip';
process.env.ABDM_CALLBACK_SECRET = 'x'.repeat(64);
process.env.ABDM_VERIFY_CONSENT_ARTEFACT = 'true';
process.env.ABDM_CM_PUBLIC_KEY = 'test-key';

const { publicKey: RSA_PUBLIC, privateKey: RSA_PRIVATE } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const fetchEnrolmentPublicCertificate = jest.fn(async () => ({
  publicKey: RSA_PUBLIC.export({ type: 'spki', format: 'pem' }).toString(),
}));
const requestEnrolmentOtp = jest.fn();
const enrolByAadhaar = jest.fn();
jest.unstable_mockModule('../services/abdm/abdmGateway.js', () => ({
  default: {
    fetchEnrolmentPublicCertificate,
    requestEnrolmentOtp,
    enrolByAadhaar,
    verifyMobileOtp: jest.fn(),
  },
}));

const { default: prisma } = await import('../lib/prisma.js');
const enrolmentService = (await import('../services/abdm/abhaEnrolmentService.js')).default;
const { verhoeffValidate } = await import('../services/abdm/abhaEnrolmentService.js');

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_A = '70100000-0000-4000-8000-00000000000a';
const PATIENT_B = '70100000-0000-4000-8000-00000000000b';
const PHONE_A = '+919000701001';
const PHONE_B = '+919000701002';
// The ABHA the mocked gateway "issues" — both patients race for it.
const ISSUED_ABHA_CLEAN = '70100000000001';
const ISSUED_ABHA = '70-1000-0000-0001';

const VALID_AADHAAR = (() => {
  const base = '34512345123';
  for (let dgt = 0; dgt <= 9; dgt += 1) {
    if (verhoeffValidate(base + dgt)) return base + dgt;
  }
  throw new Error('no valid check digit found');
})();

function rsaDecrypt(b64) {
  return crypto.privateDecrypt(
    { key: RSA_PRIVATE, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING },
    Buffer.from(b64, 'base64'),
  ).toString('utf8');
}

let savedSettings = null;

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM abha_enrolment_sessions WHERE tenant_id = $1::uuid AND patient_uid IN ($2::uuid, $3::uuid)`,
    TENANT_ID, PATIENT_A, PATIENT_B,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`,
    PATIENT_A, PATIENT_B,
  ).catch(() => {});
}

d('ABHA enrolment deep (701 + 653 verified gate)', () => {
  beforeAll(async () => {
    await cleanup();
    const settingsRows = await prisma.$queryRawUnsafe(
      `SELECT settings FROM tenants WHERE id = $1::uuid`, TENANT_ID,
    );
    savedSettings = settingsRows[0]?.settings ?? {};
    await prisma.$executeRawUnsafe(
      `UPDATE tenants
          SET settings = COALESCE(settings, '{}'::jsonb) || '{"abdmEnrolment":{"enabled":true}}'::jsonb
        WHERE id = $1::uuid`,
      TENANT_ID,
    );
    for (const [uid, phone, name] of [
      [PATIENT_A, PHONE_A, 'Enrol Patient A'],
      [PATIENT_B, PHONE_B, 'Enrol Patient B'],
    ]) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, 'PATIENT', true, NOW())`,
        uid, TENANT_ID, phone, name,
      );
    }
  });

  afterAll(async () => {
    await cleanup();
    if (savedSettings !== null) {
      await prisma.$executeRawUnsafe(
        `UPDATE tenants SET settings = $2::jsonb WHERE id = $1::uuid`,
        TENANT_ID, JSON.stringify(savedSettings),
      ).catch(() => {});
    }
    await prisma.$disconnect().catch(() => {});
  });

  beforeEach(() => {
    requestEnrolmentOtp.mockReset();
    enrolByAadhaar.mockReset();
    requestEnrolmentOtp.mockImplementation(async () => ({ txnId: `txn-${crypto.randomUUID()}` }));
    enrolByAadhaar.mockResolvedValue({
      isNew: true,
      ABHAProfile: {
        ABHANumber: ISSUED_ABHA,
        phrAddress: ['enrolled@sbx'],
        firstName: 'Enrol', lastName: 'Patient', gender: 'F',
        yearOfBirth: '1991', mobile: '9111222333',
      },
    });
  });

  test('happy path: session → linked, users verified through the 653 gate, audit row present, no Aadhaar anywhere', async () => {
    const started = await enrolmentService.startEnrolment({
      tenantId: TENANT_ID, patientUid: PATIENT_A, aadhaarNumber: VALID_AADHAAR,
    });
    expect(started.status).toBe('otp_sent');

    // The gateway saw ciphertext that decrypts to the Aadhaar — proof the
    // value crossed only in encrypted form.
    const otpArg = requestEnrolmentOtp.mock.calls[0][0];
    expect(rsaDecrypt(otpArg.encryptedValue)).toBe(VALID_AADHAAR);

    const linked = await enrolmentService.verifyEnrolmentOtp({
      tenantId: TENANT_ID, sessionId: started.id, otp: '123456',
    });
    expect(linked.status).toBe('linked');
    expect(linked.abha_number).toBe(ISSUED_ABHA);

    // users row: verified through the 653 gate, gateway-issued.
    const users = await prisma.$queryRawUnsafe(
      `SELECT abha_number, abha_verification_status, abha_verified_at
         FROM users WHERE uid = $1::uuid`,
      PATIENT_A,
    );
    expect(users[0]).toMatchObject({
      abha_number: ISSUED_ABHA,
      abha_verification_status: 'verified',
    });
    expect(users[0].abha_verified_at).not.toBeNull();

    // Same-tx canonical audit row; identity split — no timeline row.
    const audit = await prisma.$queryRawUnsafe(
      `SELECT action, metadata FROM clinical_audit_events
        WHERE patient_uid = $1::uuid AND action = 'ABHA_ENROLLED'
        ORDER BY occurred_at DESC LIMIT 1`,
      PATIENT_A,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({
      verification_status: 'verified',
      gateway_issued: true,
      enrolment_session_id: started.id,
    });
    const timeline = await prisma.$queryRawUnsafe(
      `SELECT id FROM clinical_timeline_events WHERE patient_uid = $1::uuid`,
      PATIENT_A,
    );
    expect(timeline).toHaveLength(0);

    // PRIVACY: the Aadhaar digits are in NO persisted row.
    const sessionRows = await prisma.$queryRawUnsafe(
      `SELECT to_jsonb(s.*) AS row FROM abha_enrolment_sessions s
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
      TENANT_ID, PATIENT_A,
    );
    expect(JSON.stringify(sessionRows)).not.toContain(VALID_AADHAAR);
    expect(JSON.stringify(audit)).not.toContain(VALID_AADHAAR);
  });

  test('the 653 canonical unique blocks a second enrolment of the same ABHA: 409, session failed with preserved evidence', async () => {
    const started = await enrolmentService.startEnrolment({
      tenantId: TENANT_ID, patientUid: PATIENT_B, aadhaarNumber: VALID_AADHAAR,
    });

    await expect(enrolmentService.verifyEnrolmentOtp({
      tenantId: TENANT_ID, sessionId: started.id, otp: '654321',
    })).rejects.toMatchObject({ code: 'ABHA_ALREADY_LINKED', statusCode: 409 });

    const sessions = await prisma.$queryRawUnsafe(
      `SELECT status, error_code, abha_number, enrolled_at
         FROM abha_enrolment_sessions
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
        ORDER BY created_at DESC LIMIT 1`,
      TENANT_ID, PATIENT_B,
    );
    expect(sessions[0]).toMatchObject({
      status: 'failed',
      error_code: 'abha_already_linked',
      abha_number: ISSUED_ABHA, // gateway-issued evidence preserved
    });
    expect(sessions[0].enrolled_at).not.toBeNull();

    // Patient B stays unlinked; patient A keeps the verified slot.
    const users = await prisma.$queryRawUnsafe(
      `SELECT uid::text AS uid, abha_number, abha_verification_status
         FROM users WHERE uid IN ($1::uuid, $2::uuid) ORDER BY uid`,
      PATIENT_A, PATIENT_B,
    );
    const byUid = Object.fromEntries(users.map((r) => [r.uid, r]));
    expect(byUid[PATIENT_A].abha_verification_status).toBe('verified');
    expect(byUid[PATIENT_B].abha_number).toBeNull();
  });

  test('701 constraints are live: result-evidence CHECK, txn-presence CHECK, txn unique', async () => {
    // enrolled without abha_number/enrolled_at → CHECK violation.
    await expect(prisma.$executeRawUnsafe(
      `INSERT INTO abha_enrolment_sessions
         (tenant_id, patient_uid, flow, environment, status, txn_id)
       VALUES ($1::uuid, $2::uuid, 'aadhaar_otp', 'sandbox', 'enrolled', 'txn-check-1')`,
      TENANT_ID, PATIENT_A,
    )).rejects.toThrow(/chk_abha_enrolment_result_evidence/);

    // otp_sent without a txn behind it → CHECK violation.
    await expect(prisma.$executeRawUnsafe(
      `INSERT INTO abha_enrolment_sessions
         (tenant_id, patient_uid, flow, environment, status)
       VALUES ($1::uuid, $2::uuid, 'aadhaar_otp', 'sandbox', 'otp_sent')`,
      TENANT_ID, PATIENT_A,
    )).rejects.toThrow(/chk_abha_enrolment_txn_presence/);

    // (tenant, txn, environment) unique collapses replays.
    await prisma.$executeRawUnsafe(
      `INSERT INTO abha_enrolment_sessions
         (tenant_id, patient_uid, flow, environment, status, txn_id)
       VALUES ($1::uuid, $2::uuid, 'aadhaar_otp', 'sandbox', 'failed', 'txn-unique-1')`,
      TENANT_ID, PATIENT_A,
    );
    await expect(prisma.$executeRawUnsafe(
      `INSERT INTO abha_enrolment_sessions
         (tenant_id, patient_uid, flow, environment, status, txn_id)
       VALUES ($1::uuid, $2::uuid, 'aadhaar_otp', 'sandbox', 'failed', 'txn-unique-1')`,
      TENANT_ID, PATIENT_B,
    )).rejects.toThrow(/ux_abha_enrolment_tenant_txn/);
  });

  test('one live session per patient is DB-enforced', async () => {
    // PATIENT_B has only terminal sessions so far; start a live one directly.
    await prisma.$executeRawUnsafe(
      `INSERT INTO abha_enrolment_sessions
         (tenant_id, patient_uid, flow, environment, status, txn_id)
       VALUES ($1::uuid, $2::uuid, 'aadhaar_otp', 'sandbox', 'otp_sent', 'txn-live-1')`,
      TENANT_ID, PATIENT_B,
    );
    await expect(prisma.$executeRawUnsafe(
      `INSERT INTO abha_enrolment_sessions
         (tenant_id, patient_uid, flow, environment, status, txn_id)
       VALUES ($1::uuid, $2::uuid, 'aadhaar_otp', 'sandbox', 'otp_sent', 'txn-live-2')`,
      TENANT_ID, PATIENT_B,
    )).rejects.toThrow(/ux_abha_enrolment_patient_live/);
  });
});
