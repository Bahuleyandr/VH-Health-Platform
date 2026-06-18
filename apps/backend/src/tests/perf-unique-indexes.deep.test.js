// Audit 2026-06-18 §3 (Data layer, MEDIUM) — perf + uniqueness backstops.
//
// Migration 326 adds two classes of index:
//
//  1. Composite (tenant_id, patient_uid) btree indexes on the hot PHI tables
//     that previously had ONLY a singleton (tenant_id) index. The RLS hot path
//     is "this tenant's rows for this patient", and a leading-tenant_id index
//     that also keys patient_uid lets a single index satisfy both the RLS
//     predicate and the per-patient filter. Covered tables (those that actually
//     carry both columns): admissions, prescriptions, investigations,
//     patient_vitals. medical_records is intentionally excluded — it keys
//     patients by patient_id (int), not patient_uid, so the composite does
//     not apply.
//
//  2. Partial UNIQUE indexes on the generated human identifiers
//     e_prescriptions.prescription_number ('RX-'||uuid) and
//     pharmacy_orders.order_number ('PO-'||uuid). Both default to a generated
//     value but had NO uniqueness contract, so a duplicate number was possible
//     (e.g. a caller passing an explicit number, or a future generator
//     collision). Both tables carry a NOT NULL tenant_id, so the unique key is
//     (tenant_id, <number>) WHERE <number> IS NOT NULL — tenant-scoped, and
//     NULL numbers are exempt (a NULL number is "unassigned", many allowed).
//
// These tests prove:
//   * the migration is recorded in the tracker
//   * each composite (tenant_id, patient_uid) index exists in pg_indexes with
//     the right column order, and medical_records did NOT get one
//   * a duplicate (tenant_id, prescription_number) raises 23505; a different
//     tenant with the same number is fine; a NULL number is exempt
//   * a duplicate (tenant_id, order_number) raises 23505; cross-tenant + NULL
//     behave the same
//
// Self-isolating fixtures: own synthetic tenant(s) + fixed patient/number uids,
// cleaned up before + after. patient_uid on these tables has no FK, so no
// parent patient rows are needed. Needs the test Postgres; self-skips when
// unconfigured.

import prisma from '../lib/prisma.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

// Distinct synthetic tenants so this suite can never collide with real data or
// other deep tests.
const TENANT_A = 'fee00000-0000-4000-8000-0000000000a1';
const TENANT_B = 'fee00000-0000-4000-8000-0000000000b1';
const PATIENT_1 = 'fee00000-0000-4000-8000-000000010001';

// Fixed generated-identifier values we control, so cleanup is exact and the
// duplicate-insert assertion targets a known number.
const RX_NUMBER = 'RX-TEST-326-AAAA';
const PO_NUMBER = 'PO-TEST-326-AAAA';

// Pull the 23505 SQLSTATE out of the various shapes the Prisma driver adapter
// wraps a raw-query error in (mirrors appointment-double-booking.deep.test.js).
function sqlState(err) {
  return (
    err?.meta?.driverAdapterError?.cause?.code
    || err?.meta?.driverAdapterError?.cause?.originalCode
    || err?.code
  );
}

async function cleanup() {
  for (const sql of [
    `DELETE FROM e_prescriptions WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    `DELETE FROM pharmacy_orders WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    `DELETE FROM admissions WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    `DELETE FROM prescriptions WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    `DELETE FROM investigations WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    `DELETE FROM patient_vitals WHERE tenant_id IN ($1::uuid, $2::uuid)`,
  ]) {
    await prisma.$executeRawUnsafe(sql, TENANT_A, TENANT_B).catch(() => {});
  }
  // Drop the synthetic tenants last (children removed above).
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`,
    TENANT_A, TENANT_B,
  ).catch(() => {});
}

async function insertEPrescription({ tenantId, number }) {
  // number may be a string or null (null => column default would normally fire,
  // so we pass it explicitly to test the NULL-exempt path).
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO e_prescriptions (tenant_id, patient_uid, prescription_number)
       VALUES ($1::uuid, $2::uuid, $3)
     RETURNING id`,
    tenantId, PATIENT_1, number,
  );
  return rows[0].id;
}

async function insertPharmacyOrder({ tenantId, number }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO pharmacy_orders (tenant_id, phone, order_note, order_number, updated_at)
       VALUES ($1::uuid, '+910000000000', 'test', $2, NOW())
     RETURNING id`,
    tenantId, number,
  );
  return rows[0].id;
}

d('perf + uniqueness indexes (migration 326)', () => {
  beforeAll(async () => {
    await cleanup();
    // All six target tables FK tenant_id -> tenants(id), so the synthetic
    // tenants must exist before any fixture insert. Plain prisma bypasses RLS
    // (permissive policy when the GUC is unset), so cross-tenant setup is fine.
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES
         ($1::uuid, 'fee-tenant-a', 'Perf Tenant A'),
         ($2::uuid, 'fee-tenant-b', 'Perf Tenant B')
       ON CONFLICT (id) DO NOTHING`,
      TENANT_A, TENANT_B,
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  // Clear the child rows (not the tenants) between tests so each uniqueness
  // assertion starts from a clean slate — otherwise a number inserted by the
  // "duplicate rejected" test would leak into the "cross-tenant allowed" test.
  afterEach(async () => {
    for (const sql of [
      `DELETE FROM e_prescriptions WHERE tenant_id IN ($1::uuid, $2::uuid)`,
      `DELETE FROM pharmacy_orders WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    ]) {
      await prisma.$executeRawUnsafe(sql, TENANT_A, TENANT_B).catch(() => {});
    }
  });

  test('the migration is recorded in the tracker', async () => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT 1 FROM _migrations WHERE name = $1 LIMIT 1`,
      '326_perf_unique_indexes.sql',
    );
    expect(rows.length).toBe(1);
  });

  // ---- 1. Composite (tenant_id, patient_uid) indexes exist -----------------

  test.each([
    ['admissions', 'idx_admissions_tenant_patient'],
    ['prescriptions', 'idx_prescriptions_tenant_patient'],
    ['investigations', 'idx_investigations_tenant_patient'],
    ['patient_vitals', 'idx_patient_vitals_tenant_patient'],
  ])('%s has a (tenant_id, patient_uid) composite index', async (table, indexName) => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = $1 AND indexname = $2`,
      table, indexName,
    );
    expect(rows.length).toBe(1);
    // Column order matters: tenant_id must lead, patient_uid second.
    expect(rows[0].indexdef).toMatch(/\(tenant_id,\s*patient_uid\)/);
  });

  test('medical_records did NOT get a (tenant_id, patient_uid) index (no patient_uid column)', async () => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'medical_records'
          AND indexname = 'idx_medical_records_tenant_patient'`,
    );
    expect(rows.length).toBe(0);
  });

  // ---- 2. e_prescriptions.prescription_number partial-unique ---------------

  test('duplicate (tenant_id, prescription_number) is rejected with 23505', async () => {
    const firstId = await insertEPrescription({ tenantId: TENANT_A, number: RX_NUMBER });
    expect(firstId).toBeGreaterThan(0);

    let err = null;
    try {
      await insertEPrescription({ tenantId: TENANT_A, number: RX_NUMBER });
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    expect(String(sqlState(err))).toBe('23505');
  });

  test('same prescription_number in a different tenant is allowed (tenant-scoped)', async () => {
    const inA = await insertEPrescription({ tenantId: TENANT_A, number: RX_NUMBER });
    const inB = await insertEPrescription({ tenantId: TENANT_B, number: RX_NUMBER });
    expect(inA).toBeGreaterThan(0);
    expect(inB).toBeGreaterThan(0);
  });

  test('NULL prescription_number is exempt — multiple allowed in the same tenant', async () => {
    const a = await insertEPrescription({ tenantId: TENANT_A, number: null });
    const b = await insertEPrescription({ tenantId: TENANT_A, number: null });
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
  });

  // ---- 3. pharmacy_orders.order_number partial-unique ----------------------

  test('duplicate (tenant_id, order_number) is rejected with 23505', async () => {
    const firstId = await insertPharmacyOrder({ tenantId: TENANT_A, number: PO_NUMBER });
    expect(firstId).toBeGreaterThan(0);

    let err = null;
    try {
      await insertPharmacyOrder({ tenantId: TENANT_A, number: PO_NUMBER });
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    expect(String(sqlState(err))).toBe('23505');
  });

  test('same order_number in a different tenant is allowed (tenant-scoped)', async () => {
    const inA = await insertPharmacyOrder({ tenantId: TENANT_A, number: PO_NUMBER });
    const inB = await insertPharmacyOrder({ tenantId: TENANT_B, number: PO_NUMBER });
    expect(inA).toBeGreaterThan(0);
    expect(inB).toBeGreaterThan(0);
  });

  test('NULL order_number is exempt — multiple allowed in the same tenant', async () => {
    const a = await insertPharmacyOrder({ tenantId: TENANT_A, number: null });
    const b = await insertPharmacyOrder({ tenantId: TENANT_A, number: null });
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
  });
});
