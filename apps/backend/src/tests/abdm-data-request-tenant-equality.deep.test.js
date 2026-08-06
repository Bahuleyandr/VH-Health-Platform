// ABDM data-request callback-tenant equality (CAN-007).
//
// When the data-request callback is authenticated by a PER-TENANT secret, the
// consent it names must belong to that same tenant — otherwise a tenant-A HIP
// callback could pull tenant-B PHI to its own dataPushUrl. Enforced via
// opts.strict + opts.callbackTenantId. Guard-now (2026-08-06): the legacy
// (no-opts) path is confined to DEFAULT-tenant consents — see
// abdm-inbound-tenant-binding for its coverage.
import prisma from '../lib/prisma.js';
import abdmService from '../services/abdm/abdmService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_B = 'c0de0207-0000-4000-8000-00000000b001';
const OTHER_TENANT = '00000000-0000-4000-8000-000000000001'; // platform default ≠ B
const PATIENT_B = 'c0de0207-0000-4000-8000-0000000007b1';
const CONSENT_ID = 'c0de0207-consent-0000-0000-00000000c1';
const TXN_MISMATCH = 'c0de0207-txn-0000-0000-0000000000f1';
const TXN_MATCH = 'c0de0207-txn-0000-0000-0000000000f2';

async function cleanup() {
  await prisma.$executeRawUnsafe(`DELETE FROM abdm_data_requests WHERE transaction_id IN ($1,$2)`, TXN_MISMATCH, TXN_MATCH).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM abdm_consents WHERE consent_id = $1`, CONSENT_ID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, PATIENT_B).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, TENANT_B).catch(() => {});
}

d('ABDM data-request callback-tenant equality (CAN-007)', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid,'abdm-eq-b','ABDM Eq B') ON CONFLICT (id) DO NOTHING`, TENANT_B);
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid,$2::uuid,'+919000207701','ABDM Eq Patient','PATIENT',true,NOW())`, PATIENT_B, TENANT_B);
    // Expiry must stay ahead of the run date: handleDataRequest hard-expires
    // the consent (CONSENT_EXPIRED) once expiry_date < NOW(), which would
    // shadow both the mismatch code and the happy path asserted below.
    await prisma.$executeRawUnsafe(
      `INSERT INTO abdm_consents (consent_id, tenant_id, patient_uid, status, hi_types, date_range_from, date_range_to, expiry_date, granted_at, created_at)
       VALUES ($1,$2::uuid,$3::uuid,'GRANTED', ARRAY['Prescription'], '2026-01-01'::timestamptz,'2026-12-31'::timestamptz, NOW() + interval '365 days', NOW(), NOW())`,
      CONSENT_ID, TENANT_B, PATIENT_B);
  }, 30000);
  afterAll(async () => { await cleanup(); }, 30000);

  const req = (transactionId) => ({
    transactionId, consentId: CONSENT_ID, hiTypes: ['Prescription'],
    dateRange: { from: '2026-01-01', to: '2026-12-31' }, keyMaterial: null, dataPushUrl: null,
  });

  it('rejects a per-tenant callback whose authenticated tenant != consent tenant', async () => {
    await expect(
      abdmService.handleDataRequest(req(TXN_MISMATCH), { strict: true, callbackTenantId: OTHER_TENANT }),
    ).rejects.toMatchObject({ code: 'ABDM_CONSENT_TENANT_MISMATCH' });
    const rows = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM abdm_data_requests WHERE transaction_id = $1`, TXN_MISMATCH);
    expect(rows[0].n).toBe(0); // nothing written
  });

  it('accepts a per-tenant callback whose authenticated tenant matches the consent tenant', async () => {
    const result = await abdmService.handleDataRequest(req(TXN_MATCH), { strict: true, callbackTenantId: TENANT_B });
    expect(result.transaction_id).toBe(TXN_MATCH);
    const rows = await prisma.$queryRawUnsafe(`SELECT tenant_id::text AS tenant_id FROM abdm_data_requests WHERE transaction_id = $1`, TXN_MATCH);
    expect(rows.length).toBe(1);
    expect(rows[0].tenant_id).toBe(TENANT_B);
  });
});
