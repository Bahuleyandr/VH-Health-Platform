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
// defaulting.
//
// These tests call the service methods directly (the route wiring + HMAC are
// covered by abdm-callback-replay-and-ratelimit; here we isolate the tenant
// binding). Needs the test Postgres. Self-skips when unconfigured.

import prisma from '../lib/prisma.js';
import abdmService from '../services/abdm/abdmService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_B = 'ab100000-0000-4000-8000-00000000b001';
const TENANT_C = 'ab100000-0000-4000-8000-00000000c001';
const PATIENT_B = 'ab100000-0000-4000-8000-0000000007b1';
const PATIENT_C = 'ab100000-0000-4000-8000-0000000007c1';
const ABHA_UNIQUE = '11-1111-1111-1111';   // only in tenant B
const ABHA_DUP = '22-2222-2222-2222';       // in BOTH tenant B and C
const PHONE_B = '+919000010b01';
const PHONE_C = '+919000010c01';
const CONSENT_ID = 'ab100000-consent-0000-0000-00000000c1';
const TXN_ID = 'ab100000-txn-0000-0000-00000000f1';

async function cleanup() {
  await prisma.$executeRawUnsafe(`DELETE FROM abdm_data_requests WHERE transaction_id = $1`, TXN_ID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM abdm_consents WHERE consent_id IN ($1, $2)`, CONSENT_ID, `${CONSENT_ID}-dup`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM prescriptions WHERE patient_uid IN ($1::uuid, $2::uuid)`, PATIENT_B, PATIENT_C).catch(() => {});
  // PATIENT_B/C have fixed uids, but the second duplicate-ABHA patient ("B2") is
  // inserted with a RANDOM uid + a fixed phone, so a uid-only delete leaks it
  // across runs (users.phone is globally unique → next run 23505). Also delete by
  // the test ABHAs + B2's phone.
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid) OR abha_number IN ($3, $4) OR phone = $5`,
    PATIENT_B, PATIENT_C, ABHA_UNIQUE, ABHA_DUP, '+919000010b02',
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
    // Patient B in tenant B holds the UNIQUE ABHA.
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, abha_number, is_active, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, 'ABDM Patient B', 'PATIENT', $4, true, NOW())`,
      PATIENT_B, TENANT_B, PHONE_B, ABHA_UNIQUE,
    );
    // Patient C in tenant C holds the DUPLICATE ABHA.
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, abha_number, is_active, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, 'ABDM Patient C', 'PATIENT', $4, true, NOW())`,
      PATIENT_C, TENANT_C, PHONE_C, ABHA_DUP,
    );
    // A second patient (in tenant B) ALSO holds the DUPLICATE ABHA, so ABHA_DUP
    // resolves across BOTH tenant B and tenant C → ambiguous match.
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, abha_number, is_active, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, $2, 'ABDM Patient B2', 'PATIENT', $3, true, NOW())`,
      TENANT_B, '+919000010b02', ABHA_DUP,
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
    const consent = await abdmService.handleConsentRequest({
      consentRequestId: CONSENT_ID,
      purpose: 'CAREMGT',
      hiTypes: ['Prescription'],
      patient: { id: ABHA_UNIQUE },
      hiu: { id: 'HIU-TEST' },
      requester: { name: 'Test HIU' },
      dateRange: { from: '2026-01-01', to: '2026-12-31' },
      expiry: '2027-01-01',
    });
    expect(consent.consent_id).toBe(CONSENT_ID);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT tenant_id::text AS tenant_id, patient_uid::text AS patient_uid
         FROM abdm_consents WHERE consent_id = $1`,
      CONSENT_ID,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].tenant_id).toBe(TENANT_B);
    expect(rows[0].patient_uid).toBe(PATIENT_B);
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
        expiry: '2027-01-01',
      }),
    ).rejects.toMatchObject({ statusCode: expect.any(Number) });

    const rows = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM abdm_consents WHERE consent_id = $1`,
      `${CONSENT_ID}-dup`,
    );
    expect(rows[0].n).toBe(0); // nothing written for the ambiguous match
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
    });
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
