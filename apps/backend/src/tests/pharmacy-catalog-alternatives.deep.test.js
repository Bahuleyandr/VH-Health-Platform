// Deep integration test for the GATED same-composition alternatives endpoint
// GET /api/v1/pharmacy-orders/catalog/:id/alternatives (Phase 2 of
// composition-based drug search).
//
// The endpoint is keyed by a CATALOG id (never a client-sent composition id),
// tenant-scoped, and gated behind the per-tenant composition_search flag. It
// returns other brands sharing the selected brand's composition, grouped by
// strength+form, in-stock first, tagged with a server-derived `substitutable`
// boolean and an `availability_status`.
//
// The test proves the full contract:
//   - flag ON + high-confidence combo selected → siblings returned, correctly
//     grouped (matched group first), substitutability computed per the rules
//     (same strength_key + form_key + release + route + per-ingredient combo
//     split), in-stock ordering, and tenant scoping (tenant-B brand absent);
//   - flag OFF → 200 with empty groups/alternatives (a valid empty answer);
//   - nonexistent / wrong-tenant catalog id (flag on) → 404;
//   - a selected row that is low-confidence or has no composition → 200 empty.
//
// Tenant selection is deterministic: each SUPER_ADMIN token is minted with the
// target tenant_id claim, so tenantContextMiddleware resolves req.tenantId to
// exactly that tenant. SUPER_ADMIN collapses to ADMIN for route RBAC (ADMIN is
// in pharmacyCatalogRoutes), so the shared catalog-read RBAC is satisfied.

import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';
import { setCompositionSearchEnabled } from '../services/pharmacy/compositionFeatureService.js';

const TENANT_A = '00000000-0000-4000-8000-0000cfa10001';
const TENANT_B = '00000000-0000-4000-8000-0000cfa10002';
const TENANT_OFF = '00000000-0000-4000-8000-0000cfa10003';

const SA_UID = 'a7777777-7777-4777-8777-77777777aa01';

const COMBO_KEY = 'alttest+amoxicillin+clavulanic_acid';
const MONO_KEY = 'alttest+paracetamol';

// SUPER_ADMIN tokens minted per-tenant so req.tenantId resolves deterministically.
const tokenA = generateTestToken('SUPER_ADMIN', { uid: SA_UID, tenant_id: TENANT_A });
const tokenOff = generateTestToken('SUPER_ADMIN', { uid: SA_UID, tenant_id: TENANT_OFF });

function clientFor(token) {
  return {
    get: (path) =>
      request(app).get(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

const combo625 = JSON.stringify([
  { ingredient: 'amoxicillin', amount: 500, unit: 'mg' },
  { ingredient: 'clavulanic_acid', amount: 125, unit: 'mg' },
]);
const comboSplit625 = JSON.stringify([
  { ingredient: 'amoxicillin', amount: 400, unit: 'mg' },
  { ingredient: 'clavulanic_acid', amount: 225, unit: 'mg' },
]);

describe('GET /pharmacy-orders/catalog/:id/alternatives — gated composition alternatives', () => {
  let comboId;
  let monoId;
  const ids = {};

  async function cleanup() {
    await prisma
      .$executeRawUnsafe(`DELETE FROM pharmacy_catalog WHERE name LIKE 'ALTTEST %'`)
      .catch(() => {});
    await prisma
      .$executeRawUnsafe(
        `DELETE FROM composition_search_settings WHERE tenant_id IN ($1::uuid, $2::uuid, $3::uuid)`,
        TENANT_A, TENANT_B, TENANT_OFF,
      )
      .catch(() => {});
    await prisma
      .$executeRawUnsafe(
        `DELETE FROM drug_compositions WHERE composition_key IN ($1, $2)`,
        COMBO_KEY, MONO_KEY,
      )
      .catch(() => {});
  }

  // Insert a tenant-A/B catalog row and return its numeric id.
  async function seedCatalog(tenantId, name, {
    compositionId,
    strength,
    strengthKey,
    strengthComponents,
    form,
    formKey,
    releaseKey = null,
    route = null,
    confidence = 'high',
    stockQuantity = 10,
    inStock = true,
    manufacturer = 'ALTTEST Pharma',
  }) {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (name, generic_name, manufacturer, is_active, tenant_id,
          composition_id, strength, strength_key, strength_components,
          form, form_key, release_key, route, composition_confidence,
          stock_quantity, stock, in_stock, is_available, updated_at)
       VALUES ($1, 'Amoxicillin + Clavulanic acid', $2, TRUE, $3::uuid,
               $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12,
               $13, $13, $14, $14, NOW())
       RETURNING id`,
      name, manufacturer, tenantId,
      compositionId, strength, strengthKey, strengthComponents ?? null,
      form, formKey, releaseKey, route, confidence,
      stockQuantity, inStock,
    );
    return Number(rows[0].id);
  }

  beforeAll(async () => {
    await cleanup();

    // Seed all three tenants (TENANT_A default may already exist; use unique ids).
    for (const [id, slug] of [
      [TENANT_A, 'alttest-a'],
      [TENANT_B, 'alttest-b'],
      [TENANT_OFF, 'alttest-off'],
    ]) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO tenants (id, slug, name, region, status, created_at, updated_at)
         VALUES ($1::uuid, $2, $3, 'IN', 'active', NOW(), NOW())
         ON CONFLICT (id) DO NOTHING`,
        id, slug, `ALTTEST ${slug}`,
      );
    }

    // Global composition rows: one combo (amox+clav), one mono (paracetamol).
    const comboRow = await prisma.$queryRawUnsafe(
      `INSERT INTO drug_compositions (composition_key, display_label, active_ingredients, source)
       VALUES ($1, 'Amoxicillin + Clavulanic acid', ARRAY['amoxicillin','clavulanic_acid'], 'curated')
       RETURNING id`,
      COMBO_KEY,
    );
    comboId = Number(comboRow[0].id);
    const monoRow = await prisma.$queryRawUnsafe(
      `INSERT INTO drug_compositions (composition_key, display_label, active_ingredients, source)
       VALUES ($1, 'Paracetamol', ARRAY['paracetamol'], 'curated')
       RETURNING id`,
      MONO_KEY,
    );
    monoId = Number(monoRow[0].id);

    // --- Tenant A: the selected brand + siblings sharing the combo composition.
    ids.selected = await seedCatalog(TENANT_A, 'ALTTEST Augmentin 625', {
      compositionId: comboId,
      strength: '625 mg',
      strengthKey: '625mg',
      strengthComponents: combo625,
      form: 'tablet',
      formKey: 'tablet',
      releaseKey: null,
      route: null,
      confidence: 'high',
      stockQuantity: 25,
      inStock: true,
      manufacturer: 'GSK',
    });

    // SUB_OK — identical strength/form/release/components, high → substitutable.
    ids.subOk = await seedCatalog(TENANT_A, 'ALTTEST Clavam 625', {
      compositionId: comboId,
      strength: '625 mg',
      strengthKey: '625mg',
      strengthComponents: combo625,
      form: 'tablet',
      formKey: 'tablet',
      confidence: 'high',
      stockQuantity: 8,
      inStock: true,
      manufacturer: 'Alkem',
    });

    // DIFF_STRENGTH — same composition, different strength → not substitutable,
    // different group.
    ids.diffStrength = await seedCatalog(TENANT_A, 'ALTTEST Clavam 375', {
      compositionId: comboId,
      strength: '375 mg',
      strengthKey: '375mg',
      strengthComponents: JSON.stringify([
        { ingredient: 'amoxicillin', amount: 250, unit: 'mg' },
        { ingredient: 'clavulanic_acid', amount: 125, unit: 'mg' },
      ]),
      form: 'tablet',
      formKey: 'tablet',
      confidence: 'high',
      stockQuantity: 5,
      inStock: true,
    });

    // DIFF_FORM — same strength_key, different form → not substitutable, diff group.
    ids.diffForm = await seedCatalog(TENANT_A, 'ALTTEST Augmentin Injection', {
      compositionId: comboId,
      strength: '625 mg',
      strengthKey: '625mg',
      strengthComponents: combo625,
      form: 'injection',
      formKey: 'injection',
      confidence: 'high',
      stockQuantity: 4,
      inStock: true,
    });

    // COMBO_SPLIT — same strength_key + form_key + release, high, but a different
    // per-ingredient split (400+225 vs 500+125) → NOT substitutable.
    ids.comboSplit = await seedCatalog(TENANT_A, 'ALTTEST Someclav 625', {
      compositionId: comboId,
      strength: '625 mg',
      strengthKey: '625mg',
      strengthComponents: comboSplit625,
      form: 'tablet',
      formKey: 'tablet',
      confidence: 'high',
      stockQuantity: 3,
      inStock: true,
    });

    // OUT_OF_STOCK — same everything as SUB_OK but zero stock → out_of_stock,
    // ordered after the in-stock siblings.
    ids.outOfStock = await seedCatalog(TENANT_A, 'ALTTEST Novaclav 625', {
      compositionId: comboId,
      strength: '625 mg',
      strengthKey: '625mg',
      strengthComponents: combo625,
      form: 'tablet',
      formKey: 'tablet',
      confidence: 'high',
      stockQuantity: 0,
      inStock: false,
      manufacturer: 'Cipla',
    });

    // Tenant A low-confidence brand — should NOT surface alternatives when selected.
    ids.lowConfidence = await seedCatalog(TENANT_A, 'ALTTEST Fuzzy 625', {
      compositionId: comboId,
      strength: '625 mg',
      strengthKey: '625mg',
      strengthComponents: combo625,
      form: 'tablet',
      formKey: 'tablet',
      confidence: 'low',
      stockQuantity: 10,
      inStock: true,
    });

    // --- Tenant B: same-composition brand, must NEVER appear in tenant-A results.
    ids.tenantB = await seedCatalog(TENANT_B, 'ALTTEST Moxikind 625', {
      compositionId: comboId,
      strength: '625 mg',
      strengthKey: '625mg',
      strengthComponents: combo625,
      form: 'tablet',
      formKey: 'tablet',
      confidence: 'high',
      stockQuantity: 12,
      inStock: true,
    });

    // --- Tenant OFF: a selected row under a tenant whose flag is never enabled.
    ids.offSelected = await seedCatalog(TENANT_OFF, 'ALTTEST OffBrand 625', {
      compositionId: comboId,
      strength: '625 mg',
      strengthKey: '625mg',
      strengthComponents: combo625,
      form: 'tablet',
      formKey: 'tablet',
      confidence: 'high',
      stockQuantity: 10,
      inStock: true,
    });

    // Enable the flag for tenant A only (tenant OFF deliberately left disabled).
    await setCompositionSearchEnabled(TENANT_A, true, {
      actorUid: SA_UID,
      snapshot: { accepted: true },
    });
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  it('returns grouped, substitutability-tagged, tenant-scoped alternatives (flag ON)', async () => {
    const res = await clientFor(tokenA).get(
      `/api/v1/pharmacy-orders/catalog/${ids.selected}/alternatives`,
    );
    expect(res.statusCode).toBe(200);
    const { selected, groups, alternatives } = res.body.data;

    // Selected subset is server-derived from the catalog id.
    expect(selected).toBeTruthy();
    expect(Number(selected.catalog_id)).toBe(ids.selected);
    expect(Number(selected.composition_id)).toBe(comboId);
    expect(selected.strength_key).toBe('625mg');
    expect(selected.form_key).toBe('tablet');

    const byId = new Map(alternatives.map((a) => [Number(a.catalog_id), a]));

    // The selected brand is excluded from its own alternatives.
    expect(byId.has(ids.selected)).toBe(false);
    // Tenant-B brand is absent (tenant scoping).
    expect(byId.has(ids.tenantB)).toBe(false);
    // The low-confidence tenant-A brand is a sibling of the same composition and
    // DOES appear in the list (it is only the SELECTED-row confidence that gates
    // whether alternatives surface at all).
    // All the seeded tenant-A combo siblings appear.
    expect(byId.has(ids.subOk)).toBe(true);
    expect(byId.has(ids.diffStrength)).toBe(true);
    expect(byId.has(ids.diffForm)).toBe(true);
    expect(byId.has(ids.comboSplit)).toBe(true);
    expect(byId.has(ids.outOfStock)).toBe(true);

    // Substitutability.
    expect(byId.get(ids.subOk).substitutable).toBe(true);
    expect(byId.get(ids.diffStrength).substitutable).toBe(false);
    expect(byId.get(ids.diffForm).substitutable).toBe(false);
    expect(byId.get(ids.comboSplit).substitutable).toBe(false);

    // Availability status.
    expect(byId.get(ids.subOk).availability_status).toBe('in_stock');
    expect(byId.get(ids.outOfStock).availability_status).toBe('out_of_stock');

    // In-stock siblings precede out-of-stock in the flat list.
    const flatIds = alternatives.map((a) => Number(a.catalog_id));
    const idxSubOk = flatIds.indexOf(ids.subOk);
    const idxOut = flatIds.indexOf(ids.outOfStock);
    expect(idxSubOk).toBeGreaterThanOrEqual(0);
    expect(idxOut).toBeGreaterThanOrEqual(0);
    expect(idxSubOk).toBeLessThan(idxOut);

    // Grouping: the matched group (625mg + tablet) is first and matched:true.
    expect(Array.isArray(groups)).toBe(true);
    expect(groups.length).toBeGreaterThanOrEqual(2);
    expect(groups[0].matched).toBe(true);
    expect(groups[0].strength_key).toBe('625mg');
    expect(groups[0].form_key).toBe('tablet');

    // The matched group holds the 625mg tablet siblings (sub_ok, combo_split,
    // out_of_stock), NOT the selected row itself, NOT diff_strength/diff_form.
    const matchedItemIds = groups[0].items.map((i) => Number(i.catalog_id));
    expect(matchedItemIds).toContain(ids.subOk);
    expect(matchedItemIds).toContain(ids.comboSplit);
    expect(matchedItemIds).toContain(ids.outOfStock);
    expect(matchedItemIds).not.toContain(ids.selected);
    expect(matchedItemIds).not.toContain(ids.diffStrength);
    expect(matchedItemIds).not.toContain(ids.diffForm);

    // DIFF_STRENGTH (375mg+tablet) and DIFF_FORM (625mg+injection) live in their
    // own non-matched groups.
    const nonMatched = groups.filter((g) => !g.matched);
    const diffStrengthGroup = nonMatched.find(
      (g) => g.strength_key === '375mg' && g.form_key === 'tablet',
    );
    const diffFormGroup = nonMatched.find(
      (g) => g.strength_key === '625mg' && g.form_key === 'injection',
    );
    expect(diffStrengthGroup).toBeDefined();
    expect(diffStrengthGroup.matched).toBe(false);
    expect(diffStrengthGroup.items.map((i) => Number(i.catalog_id))).toContain(ids.diffStrength);
    expect(diffFormGroup).toBeDefined();
    expect(diffFormGroup.matched).toBe(false);
    expect(diffFormGroup.items.map((i) => Number(i.catalog_id))).toContain(ids.diffForm);
  });

  it('returns 200 with empty groups/alternatives when the flag is OFF', async () => {
    const res = await clientFor(tokenOff).get(
      `/api/v1/pharmacy-orders/catalog/${ids.offSelected}/alternatives`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.data.selected).toBeNull();
    expect(res.body.data.groups).toEqual([]);
    expect(res.body.data.alternatives).toEqual([]);
  });

  it('returns 404 for a nonexistent catalog id (flag ON)', async () => {
    const res = await clientFor(tokenA).get(
      `/api/v1/pharmacy-orders/catalog/2000000001/alternatives`,
    );
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for a wrong-tenant catalog id (flag ON) — tenant scoping', async () => {
    // The tenant-B brand id does not resolve under tenant A → not found.
    const res = await clientFor(tokenA).get(
      `/api/v1/pharmacy-orders/catalog/${ids.tenantB}/alternatives`,
    );
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 for a non-integer catalog id', async () => {
    const res = await clientFor(tokenA).get(
      `/api/v1/pharmacy-orders/catalog/not-a-number/alternatives`,
    );
    expect(res.statusCode).toBe(400);
  });

  it('returns 200 with empty groups/alternatives for a low-confidence selected row', async () => {
    const res = await clientFor(tokenA).get(
      `/api/v1/pharmacy-orders/catalog/${ids.lowConfidence}/alternatives`,
    );
    expect(res.statusCode).toBe(200);
    expect(Number(res.body.data.selected.catalog_id)).toBe(ids.lowConfidence);
    expect(res.body.data.groups).toEqual([]);
    expect(res.body.data.alternatives).toEqual([]);
  });
});
