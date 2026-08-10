// C-4 (interop) — ABDM inbound tenant binding.
//
// handleConsentRequest resolved the patient by ABHA with NO tenant scope and
// inserted abdm_consents without an explicit tenant; handleDataRequest /
// collectHealthData filtered only by patient_uid and inserted abdm_data_requests
// without a tenant. Under RLS the tenant_id column DEFAULT (literal default
// tenant) then stamps a NON-default patient's consent/data-request into the
// WRONG tenant — cross-tenant PHI export under one global callback secret.
//
// The fix resolves the patient's (or consent's) tenant from the matched record
// and runs every read/write under setTenant(tenant, …) with explicit tenant_id.
// A multi-tenant ABHA match is rejected deterministically rather than silently
// defaulting. Guard-now / retire-later (2026-08-06): the legacy non-strict
// (env default-secret) path is further confined to DEFAULT-tenant patients —
// any other resolved tenant now requires the strict per-tenant callback route.
//
// These tests call the service methods directly (the route wiring + HMAC are
// covered by abdm-callback-replay-and-ratelimit; here we isolate the tenant
// binding). Needs the test Postgres. Self-skips when unconfigured.

import crypto from 'crypto';
import prisma from '../lib/prisma.js';
import abdmService from '../services/abdm/abdmService.js';
import { DEFAULT_TENANT_ID } from '../services/tenant/tenantService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_B = 'ab100000-0000-4000-8000-00000000b001';
const TENANT_C = 'ab100000-0000-4000-8000-00000000c001';
const PATIENT_B = 'ab100000-0000-4000-8000-0000000007b1';
const PATIENT_C = 'ab100000-0000-4000-8000-0000000007c1';
const ABHA_UNIQUE = '11-1111-1111-1111';   // only in tenant B
const ABHA_DUP = '22-2222-2222-2222';       // in BOTH tenant B and C
const ABHA_DEFAULT = '33-3333-3333-3333';   // only in the platform DEFAULT tenant
const PHONE_B = '+919000010b01';
const PHONE_C = '+919000010c01';
const PHONE_D = '+919000010d01';
const PATIENT_D = 'ab100000-0000-4000-8000-0000000007d1'; // DEFAULT tenant
const CONSENT_ID = 'ab100000-consent-0000-0000-00000000c1';
const CONSENT_ID_LEGACY = 'ab100000-consent-0000-0000-00000000c2';
const CONSENT_ID_DEFAULT = 'ab100000-consent-0000-0000-00000000c3';
const SIGNED_CONSENT_ID = 'ab100000-signed-consent-0000-00000000c1';
const TXN_ID = 'ab100000-txn-0000-0000-00000000f1';
const TXN_LEGACY = 'ab100000-txn-0000-0000-00000000f2';
const TXN_DEFAULT = 'ab100000-txn-0000-0000-00000000f3';
// Consent expiry must stay ahead of the run date: handleDataRequest
// hard-expires the consent (CONSENT_EXPIRED) once expiry_date < NOW(),
// which would shadow the tenant-binding assertions below.
const CONSENT_EXPIRY = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
const SIGNED_ARTEFACT = {
  schemaVersion: '1.0',
  consentId: SIGNED_CONSENT_ID,
  patient: { id: ABHA_UNIQUE },
  hip: { id: 'HIP-DEEP' },
  hiu: { id: 'HIU-DEEP' },
  consentManager: { id: 'CM-DEEP' },
  requester: { name: 'Deep Test HIU' },
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
const SIGNED_ARTEFACT_JSON = JSON.stringify(SIGNED_ARTEFACT);
const SIGNED_ARTEFACT_HASH = crypto.createHash('sha256').update(SIGNED_ARTEFACT_JSON).digest('hex');
const KEYPAIR = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function signArtefact(payload) {
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(payload);
  signer.end();
  return signer.sign(KEYPAIR.privateKey).toString('base64');
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM abdm_data_requests WHERE transaction_id IN ($1, $2, $3)`,
    TXN_ID, TXN_LEGACY, TXN_DEFAULT,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM abdm_consents WHERE consent_id IN ($1, $2, $3, $4, $5)`,
    CONSENT_ID, `${CONSENT_ID}-dup`, SIGNED_CONSENT_ID, CONSENT_ID_LEGACY, CONSENT_ID_DEFAULT,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM interop_replay_guard WHERE namespace = $1 AND request_id = $2`,
    'abdm-consent-artefact-sha256', SIGNED_ARTEFACT_HASH,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM prescriptions WHERE patient_uid IN ($1::uuid, $2::uuid)`, PATIENT_B, PATIENT_C).catch(() => {});
  // PATIENT_B/C have fixed uids, but the second duplicate-ABHA patient ("B2") is
  // inserted with a RANDOM uid + a fixed phone, so a uid-only delete leaks it
  // across runs (users.phone is globally unique → next run 23505). Also delete by
  // the test ABHAs + B2's phone.
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid) OR abha_number IN ($4, $5, $6) OR phone IN ($7, $8)`,
    PATIENT_B, PATIENT_C, PATIENT_D, ABHA_UNIQUE, ABHA_DUP, ABHA_DEFAULT, '+919000010b02', PHONE_D,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`, TENANT_B, TENANT_C).catch(() => {});
}

d('ABDM inbound tenant binding (C-4)', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES
         ($1::uuid, 'abdm-tenant-b', 'ABDM Tenant B'),
         ($2::uuid, 'abdm-tenant-c', 'ABDM Tenant C')
       ON CONFLICT (id) DO NOTHING`,
      TENANT_B, TENANT_C,
    );
    // Fixtures are inserted VERIFIED (migration 653): inbound callback
    // resolution now binds to gateway-verified links only, and this suite
    // exercises the tenant binding of resolvable links.
    // Patient B in tenant B holds the UNIQUE ABHA.
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, abha_number, abha_verification_status, abha_verified_at, is_active, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, 'ABDM Patient B', 'PATIENT', $4, 'verified', NOW(), true, NOW())`,
      PATIENT_B, TENANT_B, PHONE_B, ABHA_UNIQUE,
    );
    // Patient C in tenant C holds the DUPLICATE ABHA.
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, abha_number, abha_verification_status, abha_verified_at, is_active, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, 'ABDM Patient C', 'PATIENT', $4, 'verified', NOW(), true, NOW())`,
      PATIENT_C, TENANT_C, PHONE_C, ABHA_DUP,
    );
    // A second patient (in tenant B) ALSO holds the DUPLICATE ABHA, so ABHA_DUP
    // resolves across BOTH tenant B and tenant C → ambiguous match.
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, abha_number, abha_verification_status, abha_verified_at, is_active, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, $2, 'ABDM Patient B2', 'PATIENT', $3, 'verified', NOW(), true, NOW())`,
      TENANT_B, '+919000010b02', ABHA_DUP,
    );
    // Patient D lives in the platform DEFAULT tenant — the only population the
    // legacy default-secret (non-strict) callback path may still serve.
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, abha_number, abha_verification_status, abha_verified_at, is_active, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, 'ABDM Patient D', 'PATIENT', $4, 'verified', NOW(), true, NOW())`,
      PATIENT_D, DEFAULT_TENANT_ID, PHONE_D, ABHA_DEFAULT,
    );
    // A prescription for patient B, explicitly IN TENANT B (a plain insert would
    // land in the default tenant via the GUC-reading column default, so we set
    // tenant_id here to actually exercise the export's tenant-scoping).
    await prisma.$executeRawUnsafe(
      `INSERT INTO prescriptions (patient_uid, tenant_id, medication_name, dosage, frequency, duration_days, status, issued_at, created_at)
       VALUES ($1::uuid, $2::uuid, 'Atorvastatin 10mg', '10 mg', 'OD', 30, 'active', NOW(), NOW())`,
      PATIENT_B, TENANT_B,
    );
  }, 30000);

  afterAll(async () => {
    await cleanup();
  }, 30000);

  test('consent request binds to the patient tenant (not the default)', async () => {
    const previousVerification = process.env.ABDM_VERIFY_CONSENT_ARTEFACT;
    process.env.ABDM_VERIFY_CONSENT_ARTEFACT = 'false';
    let consent;
    try {
      // Guard-now (2026-08-06): a NON-default-tenant patient must arrive on the
      // sanctioned strict per-tenant path — the legacy non-strict path is now
      // default-tenant-only (covered below).
      consent = await abdmService.handleConsentRequest({
        consentRequestId: CONSENT_ID,
        purpose: 'CAREMGT',
        hiTypes: ['Prescription'],
        patient: { id: ABHA_UNIQUE },
        hiu: { id: 'HIU-TEST' },
        requester: { name: 'Test HIU' },
        dateRange: { from: '2026-01-01', to: '2026-12-31' },
        expiry: CONSENT_EXPIRY,
      }, { callbackTenantId: TENANT_B, strict: true });
    } finally {
      restoreEnv('ABDM_VERIFY_CONSENT_ARTEFACT', previousVerification);
    }
    expect(consent.consent_id).toBe(CONSENT_ID);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT tenant_id::text AS tenant_id, patient_uid::text AS patient_uid, consent_artifact
         FROM abdm_consents WHERE consent_id = $1`,
      CONSENT_ID,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].tenant_id).toBe(TENANT_B);
    expect(rows[0].patient_uid).toBe(PATIENT_B);
    expect(rows[0].consent_artifact).toBeNull();
  });

  test('a multi-tenant ABHA match is rejected deterministically (no default-tenant pick)', async () => {
    await expect(
      abdmService.handleConsentRequest({
        consentRequestId: `${CONSENT_ID}-dup`,
        purpose: 'CAREMGT',
        hiTypes: ['Prescription'],
        patient: { id: ABHA_DUP },
        hiu: { id: 'HIU-TEST' },
        requester: { name: 'Test HIU' },
        dateRange: { from: '2026-01-01', to: '2026-12-31' },
        expiry: CONSENT_EXPIRY,
      }),
    ).rejects.toMatchObject({ statusCode: expect.any(Number) });

    const rows = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM abdm_consents WHERE consent_id = $1`,
      `${CONSENT_ID}-dup`,
    );
    expect(rows[0].n).toBe(0); // nothing written for the ambiguous match
  });

  test('verified artefact hash is persisted and the same artefact cannot be reused', async () => {
    const savedVerification = process.env.ABDM_VERIFY_CONSENT_ARTEFACT;
    const savedPublicKey = process.env.ABDM_CM_PUBLIC_KEY;
    const savedCmId = process.env.ABDM_CM_ID;
    process.env.ABDM_VERIFY_CONSENT_ARTEFACT = 'true';
    process.env.ABDM_CM_PUBLIC_KEY = KEYPAIR.publicKey.export({ type: 'spki', format: 'pem' });
    process.env.ABDM_CM_ID = 'CM-DEEP';

    const request = {
      consentRequestId: SIGNED_CONSENT_ID,
      purpose: 'CAREMGT',
      hiTypes: ['Prescription', 'DiagnosticReport'],
      patient: { id: ABHA_UNIQUE },
      hip: { id: 'HIP-DEEP' },
      authenticatedHipId: 'HIP-DEEP',
      hiu: { id: 'HIU-DEEP' },
      consentManager: { id: 'CM-DEEP' },
      requester: { name: 'Deep Test HIU' },
      dateRange: { ...SIGNED_ARTEFACT.permission.dateRange },
      expiry: SIGNED_ARTEFACT.permission.dataEraseAt,
      consentArtefact: SIGNED_ARTEFACT,
      signature: signArtefact(SIGNED_ARTEFACT_JSON),
    };

    try {
      const attempts = await Promise.allSettled([
        abdmService.handleConsentRequest(request, { callbackTenantId: TENANT_B, strict: true }),
        abdmService.handleConsentRequest(request, { callbackTenantId: TENANT_B, strict: true }),
      ]);
      const accepted = attempts.filter((attempt) => attempt.status === 'fulfilled');
      const rejected = attempts.filter((attempt) => attempt.status === 'rejected');
      expect(accepted).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toMatchObject({
        statusCode: 409,
        code: 'ABDM_CONSENT_ARTEFACT_REUSED',
      });

      const consent = accepted[0].value;
      expect(consent.consent_id).toBe(SIGNED_CONSENT_ID);

      const rows = await prisma.$queryRawUnsafe(
        `SELECT tenant_id::text AS tenant_id, patient_uid::text AS patient_uid,
                hip_id, hiu_id, purpose, hi_types, date_range_from, date_range_to,
                expiry_date, consent_artifact
           FROM abdm_consents WHERE consent_id = $1`,
        SIGNED_CONSENT_ID,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tenant_id: TENANT_B,
        patient_uid: PATIENT_B,
        hip_id: 'HIP-DEEP',
        hiu_id: 'HIU-DEEP',
        purpose: 'CAREMGT',
        hi_types: ['DiagnosticReport', 'Prescription'],
        consent_artifact: {
          verification: {
            signatureVerified: true,
            artefactHash: SIGNED_ARTEFACT_HASH,
            patientAbha: ABHA_UNIQUE,
            consentManagerId: 'CM-DEEP',
          },
        },
      });
      expect(rows[0].date_range_from.toISOString()).toBe('2026-01-01T00:00:00.000Z');
      expect(rows[0].date_range_to.toISOString()).toBe('2026-12-31T23:59:59.000Z');
      expect(rows[0].expiry_date.toISOString()).toBe('2099-01-31T00:00:00.000Z');

      const counts = await prisma.$queryRawUnsafe(
        `SELECT
           (SELECT count(*)::int FROM abdm_consents WHERE consent_id = $1) AS consent_count,
           (SELECT count(*)::int FROM interop_replay_guard
             WHERE namespace = $2 AND request_id = $3) AS claim_count`,
        SIGNED_CONSENT_ID,
        'abdm-consent-artefact-sha256',
        SIGNED_ARTEFACT_HASH,
      );
      expect(counts[0]).toEqual({ consent_count: 1, claim_count: 1 });

      const granted = await abdmService.grantConsent(SIGNED_CONSENT_ID, PATIENT_B);
      expect(granted.consent_artifact).toMatchObject({
        consentId: SIGNED_CONSENT_ID,
        patient: { id: ABHA_UNIQUE },
        consentManager: { id: 'CM-DEEP' },
      });
      expect(granted.consent_artifact).not.toHaveProperty('verifiedArtefactHash');

      const durableEvidence = await prisma.$queryRawUnsafe(
        `SELECT consent_artifact FROM abdm_consents WHERE consent_id = $1`,
        SIGNED_CONSENT_ID,
      );
      expect(durableEvidence[0].consent_artifact).toMatchObject({
        verification: {
          artefactHash: SIGNED_ARTEFACT_HASH,
          patientAbha: ABHA_UNIQUE,
          consentManagerId: 'CM-DEEP',
        },
        grantedPayload: { consentId: SIGNED_CONSENT_ID },
      });
    } finally {
      restoreEnv('ABDM_VERIFY_CONSENT_ARTEFACT', savedVerification);
      restoreEnv('ABDM_CM_PUBLIC_KEY', savedPublicKey);
      restoreEnv('ABDM_CM_ID', savedCmId);
    }
  });

  test('a failed consent insert rolls back its artefact hash claim', async () => {
    const savedVerification = process.env.ABDM_VERIFY_CONSENT_ARTEFACT;
    const savedPublicKey = process.env.ABDM_CM_PUBLIC_KEY;
    const savedCmId = process.env.ABDM_CM_ID;
    process.env.ABDM_VERIFY_CONSENT_ARTEFACT = 'true';
    process.env.ABDM_CM_PUBLIC_KEY = KEYPAIR.publicKey.export({ type: 'spki', format: 'pem' });
    process.env.ABDM_CM_ID = 'CM-DEEP';

    const overlongConsentId = 'c'.repeat(101);
    const artefact = { ...SIGNED_ARTEFACT, consentId: overlongConsentId };
    const serialized = JSON.stringify(artefact);
    const hash = crypto.createHash('sha256').update(serialized).digest('hex');

    try {
      await expect(abdmService.handleConsentRequest({
        consentRequestId: overlongConsentId,
        purpose: 'CAREMGT',
        hiTypes: ['DiagnosticReport', 'Prescription'],
        patient: { id: ABHA_UNIQUE },
        hip: { id: 'HIP-DEEP' },
        authenticatedHipId: 'HIP-DEEP',
        hiu: { id: 'HIU-DEEP' },
        consentManager: { id: 'CM-DEEP' },
        requester: { name: 'Deep Test HIU' },
        dateRange: { ...artefact.permission.dateRange },
        expiry: artefact.permission.dataEraseAt,
        consentArtefact: artefact,
        signature: signArtefact(serialized),
      }, { callbackTenantId: TENANT_B, strict: true })).rejects.toBeDefined();

      const claims = await prisma.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM interop_replay_guard
          WHERE namespace = $1 AND request_id = $2`,
        'abdm-consent-artefact-sha256',
        hash,
      );
      expect(claims[0].n).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe(
        `DELETE FROM interop_replay_guard WHERE namespace = $1 AND request_id = $2`,
        'abdm-consent-artefact-sha256',
        hash,
      ).catch(() => {});
      restoreEnv('ABDM_VERIFY_CONSENT_ARTEFACT', savedVerification);
      restoreEnv('ABDM_CM_PUBLIC_KEY', savedPublicKey);
      restoreEnv('ABDM_CM_ID', savedCmId);
    }
  });

  test('data request + collected bundle bind to the consent tenant', async () => {
    // The consent created above is REQUESTED; move it to GRANTED for the export.
    await prisma.$executeRawUnsafe(
      `UPDATE abdm_consents SET status = 'GRANTED', granted_at = NOW(),
              date_range_from = '2026-01-01'::timestamptz, date_range_to = '2026-12-31'::timestamptz
        WHERE consent_id = $1`,
      CONSENT_ID,
    );

    const result = await abdmService.handleDataRequest({
      transactionId: TXN_ID,
      consentId: CONSENT_ID,
      hiTypes: ['Prescription'],
      dateRange: { from: '2026-01-01', to: '2026-12-31' },
      keyMaterial: null, // no key → _processDataRequest fails closed AFTER the row is written
      dataPushUrl: null,
    }, { callbackTenantId: TENANT_B, strict: true });
    expect(result.transaction_id).toBe(TXN_ID);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT tenant_id::text AS tenant_id, patient_uid::text AS patient_uid
         FROM abdm_data_requests WHERE transaction_id = $1`,
      TXN_ID,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].tenant_id).toBe(TENANT_B);
    expect(rows[0].patient_uid).toBe(PATIENT_B);
  });

  // Guard-now / retire-later (2026-08-06): the env-backed default callback
  // secret (non-strict) keeps working unchanged for DEFAULT-tenant patients
  // and refuses any other resolved tenant with
  // ABDM_DEFAULT_SECRET_TENANT_FORBIDDEN, before any write.
  test('guard-now: a legacy default-secret consent request refuses a non-default-tenant patient', async () => {
    const previousVerification = process.env.ABDM_VERIFY_CONSENT_ARTEFACT;
    process.env.ABDM_VERIFY_CONSENT_ARTEFACT = 'false';
    try {
      await expect(
        abdmService.handleConsentRequest({
          consentRequestId: CONSENT_ID_LEGACY,
          purpose: 'CAREMGT',
          hiTypes: ['Prescription'],
          patient: { id: ABHA_UNIQUE }, // resolves to tenant B
          hiu: { id: 'HIU-TEST' },
          requester: { name: 'Test HIU' },
          dateRange: { from: '2026-01-01', to: '2026-12-31' },
          expiry: CONSENT_EXPIRY,
        }), // no opts → legacy non-strict default-secret path
      ).rejects.toMatchObject({
        statusCode: 403,
        code: 'ABDM_DEFAULT_SECRET_TENANT_FORBIDDEN',
      });
    } finally {
      restoreEnv('ABDM_VERIFY_CONSENT_ARTEFACT', previousVerification);
    }

    const rows = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM abdm_consents WHERE consent_id = $1`,
      CONSENT_ID_LEGACY,
    );
    expect(rows[0].n).toBe(0); // nothing written
  });

  test('guard-now: a legacy default-secret data request refuses a non-default-tenant consent', async () => {
    // CONSENT_ID was moved to GRANTED in tenant B by the previous test — a
    // GRANTED consent named on the legacy non-strict path must still refuse.
    await expect(
      abdmService.handleDataRequest({
        transactionId: TXN_LEGACY,
        consentId: CONSENT_ID,
        hiTypes: ['Prescription'],
        dateRange: { from: '2026-01-01', to: '2026-12-31' },
        keyMaterial: null,
        dataPushUrl: null,
      }), // no opts → legacy non-strict default-secret path
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'ABDM_DEFAULT_SECRET_TENANT_FORBIDDEN',
    });

    const rows = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM abdm_data_requests WHERE transaction_id = $1`,
      TXN_LEGACY,
    );
    expect(rows[0].n).toBe(0); // nothing written
  });

  test('the legacy default-secret path still serves a DEFAULT-tenant patient unchanged', async () => {
    const previousVerification = process.env.ABDM_VERIFY_CONSENT_ARTEFACT;
    process.env.ABDM_VERIFY_CONSENT_ARTEFACT = 'false';
    let consent;
    try {
      consent = await abdmService.handleConsentRequest({
        consentRequestId: CONSENT_ID_DEFAULT,
        purpose: 'CAREMGT',
        hiTypes: ['Prescription'],
        patient: { id: ABHA_DEFAULT }, // resolves to the DEFAULT tenant
        hiu: { id: 'HIU-TEST' },
        requester: { name: 'Test HIU' },
        dateRange: { from: '2026-01-01', to: '2026-12-31' },
        expiry: CONSENT_EXPIRY,
      }); // no opts → legacy non-strict default-secret path
    } finally {
      restoreEnv('ABDM_VERIFY_CONSENT_ARTEFACT', previousVerification);
    }
    expect(consent.consent_id).toBe(CONSENT_ID_DEFAULT);

    const consentRows = await prisma.$queryRawUnsafe(
      `SELECT tenant_id::text AS tenant_id, patient_uid::text AS patient_uid
         FROM abdm_consents WHERE consent_id = $1`,
      CONSENT_ID_DEFAULT,
    );
    expect(consentRows.length).toBe(1);
    expect(consentRows[0].tenant_id).toBe(DEFAULT_TENANT_ID);
    expect(consentRows[0].patient_uid).toBe(PATIENT_D);

    // Grant it, then prove the legacy data-request path also still works for
    // the DEFAULT tenant.
    await prisma.$executeRawUnsafe(
      `UPDATE abdm_consents SET status = 'GRANTED', granted_at = NOW(),
              date_range_from = '2026-01-01'::timestamptz, date_range_to = '2026-12-31'::timestamptz
        WHERE consent_id = $1`,
      CONSENT_ID_DEFAULT,
    );

    const result = await abdmService.handleDataRequest({
      transactionId: TXN_DEFAULT,
      consentId: CONSENT_ID_DEFAULT,
      hiTypes: ['Prescription'],
      dateRange: { from: '2026-01-01', to: '2026-12-31' },
      keyMaterial: null, // no key → fails closed AFTER the row is written
      dataPushUrl: null,
    }); // no opts → legacy non-strict default-secret path
    expect(result.transaction_id).toBe(TXN_DEFAULT);

    const requestRows = await prisma.$queryRawUnsafe(
      `SELECT tenant_id::text AS tenant_id, patient_uid::text AS patient_uid
         FROM abdm_data_requests WHERE transaction_id = $1`,
      TXN_DEFAULT,
    );
    expect(requestRows.length).toBe(1);
    expect(requestRows[0].tenant_id).toBe(DEFAULT_TENANT_ID);
    expect(requestRows[0].patient_uid).toBe(PATIENT_D);
  });

  test('collectHealthData scoped to the tenant returns only that tenant\'s rows', async () => {
    const bundle = await abdmService.collectHealthData(
      PATIENT_B, ['Prescription'], null, null, { tenantId: TENANT_B },
    );
    expect(bundle.resourceType).toBe('Bundle');
    expect(bundle.total).toBe(1);
    expect(bundle.entry[0].medicationName).toBe('Atorvastatin 10mg');

    // The SAME patient_uid queried under a DIFFERENT tenant must return nothing
    // (RLS scoping proves the read is tenant-bound, not patient_uid-only).
    const crossTenant = await abdmService.collectHealthData(
      PATIENT_B, ['Prescription'], null, null, { tenantId: TENANT_C },
    );
    expect(crossTenant.total).toBe(0);
  });
});
