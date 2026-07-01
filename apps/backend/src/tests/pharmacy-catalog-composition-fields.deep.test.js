// Deep integration test for the ADDITIVE composition metadata fields on
// GET /api/v1/pharmacy-orders/catalog (Phase 2 of composition-based drug search).
//
// The catalog response gains 8 additive columns sourced from pharmacy_catalog's
// structured composition columns (migration 350) + the joined drug_compositions
// display_label. This is UNGATED metadata (not PHI, not clinician-facing
// behaviour — the UI only reads it under a later feature flag). The test proves:
//   1. a catalog row WITH a composition surfaces all 8 fields correctly,
//   2. a catalog row WITHOUT a composition surfaces null composition_id /
//      composition_label (LEFT JOIN must not crash or drop the row),
//   3. the pre-existing catalog fields are unchanged (no regression from the
//      column qualification + JOIN).

import { authClient } from './testClient.js';
import prisma from '../lib/prisma.js';

const TENANT = '00000000-0000-4000-8000-0000cf000001';
// Distinctive search term shared by both rows so a single search matches both.
const SEARCH = 'CMPTEST';
const NAME_WITH = 'CMPTEST Augmentin 625 Duo';
const NAME_WITHOUT = 'CMPTEST Plain Paracetamol 500';

describe('GET /pharmacy-orders/catalog — additive composition metadata fields', () => {
  const staff = authClient('PHARMACY_STAFF');
  let compositionId;
  let idWith;
  let idWithout;

  beforeAll(async () => {
    // Clean any orphans from prior runs.
    await prisma.$executeRawUnsafe(`DELETE FROM pharmacy_catalog WHERE name LIKE 'CMPTEST %'`);
    await prisma.$executeRawUnsafe(`DELETE FROM drug_compositions WHERE composition_key = 'cmptest+amoxicillin+clavulanic_acid'`);

    // Seed the tenant (idempotent).
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, 'cmptest-tenant', 'CMPTEST Tenant')
       ON CONFLICT (id) DO NOTHING`,
      TENANT);

    // Global composition row.
    const comp = await prisma.$queryRawUnsafe(
      `INSERT INTO drug_compositions (composition_key, display_label, active_ingredients, source)
       VALUES ('cmptest+amoxicillin+clavulanic_acid', 'Amoxicillin + Clavulanic acid',
               ARRAY['amoxicillin','clavulanic_acid'], 'curated')
       RETURNING id`);
    compositionId = Number(comp[0].id);

    // Row A — has a composition + all structured columns populated.
    const a = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (name, generic_name, is_active, tenant_id,
          composition_id, strength, strength_key, form, form_key, release_key, composition_confidence,
          updated_at)
       VALUES ($1, 'Amoxicillin + Clavulanic acid', TRUE, $2::uuid,
               $3::int, '625 mg', '625mg', 'tablet', 'tablet', NULL, 'high',
               NOW())
       RETURNING id`,
      NAME_WITH, TENANT, compositionId);
    idWith = Number(a[0].id);

    // Row B — no composition, null composition columns.
    const b = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (name, generic_name, is_active, tenant_id, composition_id, updated_at)
       VALUES ($1, 'Paracetamol', TRUE, $2::uuid, NULL, NOW())
       RETURNING id`,
      NAME_WITHOUT, TENANT);
    idWithout = Number(b[0].id);
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM pharmacy_catalog WHERE name LIKE 'CMPTEST %'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM drug_compositions WHERE composition_key = 'cmptest+amoxicillin+clavulanic_acid'`).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  it('surfaces the 8 additive composition fields on a row that has a composition', async () => {
    const res = await staff.get(`/api/v1/pharmacy-orders/catalog?search=${SEARCH}`);
    expect(res.statusCode).toBe(200);
    const rows = res.body.data;
    expect(Array.isArray(rows)).toBe(true);

    const rowA = rows.find((r) => Number(r.id) === idWith);
    expect(rowA).toBeDefined();

    // Additive composition metadata.
    expect(Number(rowA.composition_id)).toBe(compositionId);
    expect(rowA.composition_label).toBe('Amoxicillin + Clavulanic acid');
    expect(rowA.strength).toBe('625 mg');
    expect(rowA.strength_key).toBe('625mg');
    expect(rowA.form).toBe('tablet');
    expect(rowA.form_key).toBe('tablet');
    expect(rowA.release_key).toBeNull();
    expect(rowA.composition_confidence).toBe('high');
  });

  it('returns null composition fields (LEFT JOIN) for a row with no composition', async () => {
    const res = await staff.get(`/api/v1/pharmacy-orders/catalog?search=${SEARCH}`);
    expect(res.statusCode).toBe(200);
    const rows = res.body.data;

    const rowB = rows.find((r) => Number(r.id) === idWithout);
    expect(rowB).toBeDefined();
    expect(rowB.composition_id).toBeNull();
    expect(rowB.composition_label).toBeNull();
  });

  it('does not regress the pre-existing catalog fields on either row', async () => {
    const res = await staff.get(`/api/v1/pharmacy-orders/catalog?search=${SEARCH}`);
    expect(res.statusCode).toBe(200);
    const rows = res.body.data;

    const rowA = rows.find((r) => Number(r.id) === idWith);
    const rowB = rows.find((r) => Number(r.id) === idWithout);

    // Row A pre-existing fields intact.
    expect(rowA.id).toBeDefined();
    expect(rowA.name).toBe(NAME_WITH);
    expect(rowA.generic_name).toBe('Amoxicillin + Clavulanic acid');
    expect(rowA).toHaveProperty('in_stock');
    expect(rowA).toHaveProperty('is_available');
    expect(rowA).toHaveProperty('requires_prescription');
    expect(rowA).toHaveProperty('stock');
    expect(rowA).toHaveProperty('created_at');
    expect(rowA.created_at).not.toBeNull();

    // Row B pre-existing fields intact (proves the id/created_at qualification
    // resolves to pharmacy_catalog, not the joined drug_compositions).
    expect(rowB.id).toBeDefined();
    expect(rowB.name).toBe(NAME_WITHOUT);
    expect(rowB.generic_name).toBe('Paracetamol');
    expect(rowB).toHaveProperty('created_at');
    expect(rowB.created_at).not.toBeNull();
  });
});
