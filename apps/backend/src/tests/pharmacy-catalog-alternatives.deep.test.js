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
//
// The endpoint also resolves pharmacy FACILITY CUSTODY before it reads anything
// (resolvePharmacyFacility → assertPharmacyFacilityGrant, which has no admin
// bypass), and availability is summed over batches scoped to that facility. So
// every tenant a request is made under carries the full chain — one active
// default facility, an active storage location, a staff identity for the caller,
// and one ACTIVE pharmacy_staff_facility_grants row issued through the real
// grant command. See seedFacilityAuthority below.

import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken, ensureTestIdentity } from './testClient.js';
import { setCompositionSearchEnabled } from '../services/pharmacy/compositionFeatureService.js';
import { grantPharmacyFacilityAuthority } from '../services/pharmacy/pharmacyFacilityAuthorityService.js';

const TENANT_A = '00000000-0000-4000-8000-0000cfa10001';
const TENANT_B = '00000000-0000-4000-8000-0000cfa10002';
const TENANT_OFF = '00000000-0000-4000-8000-0000cfa10003';

// One actor identity PER TENANT. users.uid carries a global unique index
// (users_uid_key), so a single uid cannot exist in both tenants, and
// assertPharmacyFacilityGrant looks the actor up by (tenant_id, uid) — a shared
// uid would resolve in exactly one tenant and 403 in the other.
const ACTOR_UID_A = 'a7777777-7777-4777-8777-77777777aa01';
const ACTOR_UID_OFF = 'a7777777-7777-4777-8777-77777777aa03';
// The admin that ISSUES a facility grant is a separate identity from the staff
// member that holds it, which is how grantPharmacyFacilityAuthority is called in
// production (it authorises the actor as a tenant admin, then locks the target).
const GRANT_ADMIN_A = 'a7777777-7777-4777-8777-77777777ab01';
const GRANT_ADMIN_OFF = 'a7777777-7777-4777-8777-77777777ab03';
const FIXTURE_UIDS = [ACTOR_UID_A, ACTOR_UID_OFF, GRANT_ADMIN_A, GRANT_ADMIN_OFF];

// Facility custody, one per tenant. Migration 753 fails closed on stock rows
// without it, and the endpoint resolves the tenant's single ACTIVE DEFAULT
// facility before it reads anything:
//   chk_pharmacy_inventory_items_active_authority_753   (active item ⇒ facility + catalog)
//   chk_pharmacy_batches_usable_authority_753           (in_stock batch ⇒ facility)
//   chk_pharmacy_batches_usable_storage_supply_753      (in_stock batch ⇒ storage location)
//   enforce_pharmacy_batch_storage_authority_supply_753 (that location must be ACTIVE, same facility)
const FACILITY_CODE = {
  [TENANT_A]: 'ALTTEST-FAC-A',
  [TENANT_B]: 'ALTTEST-FAC-B',
  [TENANT_OFF]: 'ALTTEST-FAC-OFF',
};
const FACILITY_CODES = Object.values(FACILITY_CODE);
// tenantId -> { facilityId, storageLocationId }, filled in beforeAll.
const custody = new Map();

const COMBO_KEY = 'alttest+amoxicillin+clavulanic_acid';
const MONO_KEY = 'alttest+paracetamol';

// SUPER_ADMIN tokens minted per-tenant so req.tenantId resolves deterministically.
const tokenA = generateTestToken('SUPER_ADMIN', { uid: ACTOR_UID_A, tenant_id: TENANT_A });
const tokenOff = generateTestToken('SUPER_ADMIN', { uid: ACTOR_UID_OFF, tenant_id: TENANT_OFF });

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
  // Authentication fails closed when a token's subject has no live identity
  // row, so an invented uid 401s before this suite's authz gate is reached.
  beforeAll(async () => {
    await ensureTestIdentity(ACTOR_UID_A, { tenantId: TENANT_A });
    await ensureTestIdentity(ACTOR_UID_OFF, { tenantId: TENANT_OFF });
  });
  let comboId;
  let monoId;
  const ids = {};

  async function cleanup() {
    await prisma
      .$executeRawUnsafe(`DELETE FROM pharmacy_inventory_batches WHERE batch_number LIKE 'ALTTEST-B-%'`)
      .catch(() => {});
    await prisma
      .$executeRawUnsafe(`DELETE FROM pharmacy_inventory_items WHERE sku_code LIKE 'ALTTEST-SKU-%'`)
      .catch(() => {});
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
    custody.clear();
    // Custody teardown, after every row that references a facility is gone.
    // pharmacy_staff_facility_grant_events is append-only (migration 753's
    // trg_pharmacy_staff_facility_grant_events_append_only_753), so the fixture
    // drops its own rows under session_replication_role='replica' exactly the way
    // pharmacy-dispensable-context.deep.test.js does — the guard stays live
    // everywhere else, this only exempts the fixture's own teardown.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_staff_facility_grant_events
          WHERE grant_id IN (SELECT id FROM pharmacy_staff_facility_grants WHERE staff_uid = ANY($1::uuid[]))`,
        FIXTURE_UIDS,
      );
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'origin'");
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_staff_facility_grants WHERE staff_uid = ANY($1::uuid[])`,
        FIXTURE_UIDS,
      );
      await tx.$executeRawUnsafe(`DELETE FROM staff WHERE user_id = ANY($1::uuid[])`, FIXTURE_UIDS);
      await tx.$executeRawUnsafe(
        `DELETE FROM facility_locations
          WHERE facility_id IN (SELECT id FROM facilities WHERE facility_code = ANY($1::text[]))`,
        FACILITY_CODES,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM facilities WHERE facility_code = ANY($1::text[])`,
        FACILITY_CODES,
      );
      await tx.$executeRawUnsafe(`DELETE FROM users WHERE uid = ANY($1::uuid[])`, FIXTURE_UIDS);
    }).catch(() => {});
  }

  // One tenant's complete pharmacy custody chain. resolvePharmacyFacility demands
  // exactly ONE active default facility, and assertPharmacyFacilityGrant has no
  // admin bypass — the caller needs a users row in a FACILITY_OPERATION_ROLES
  // role, an active staff row, and exactly one ACTIVE grant. The grant is issued
  // through the real service command rather than a direct INSERT so the fixture
  // earns the authority the same way an operator does.
  async function seedFacilityAuthority(tenantId, label, { actorUid = null, adminUid = null } = {}) {
    const facilityId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO facilities (tenant_id, facility_code, display_name, status, is_default)
       VALUES ($1::uuid, $2, $3, 'active', TRUE) RETURNING id`,
      tenantId, FACILITY_CODE[tenantId], `ALTTEST ${label} facility`,
    ))[0].id);
    const storageLocationId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO facility_locations
         (tenant_id, facility_id, location_code, display_name, location_kind, status)
       VALUES ($1::uuid, $2::int, $3, $4, 'pharmacy', 'active') RETURNING id`,
      tenantId, facilityId, `ALTTEST-STORE-${label}`, `ALTTEST ${label} pharmacy store`,
    ))[0].id);
    custody.set(tenantId, { facilityId, storageLocationId });

    // Tenant B is only ever a foreign-tenant row in someone else's result set —
    // no request is ever made under it, so it needs stock custody but no actor.
    if (!actorUid) return;

    await prisma.$executeRawUnsafe(
      `INSERT INTO staff
         (tenant_id, user_id, employee_id, name, designation, skills, certifications,
          is_active, archived, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, 'Pharmacist', '{}'::text[], '{}'::text[],
               TRUE, FALSE, NOW(), NOW())`,
      tenantId, actorUid, `ALTTEST-STAFF-${label}`, `ALTTEST ${label} pharmacist`,
    );
    await grantPharmacyFacilityAuthority({
      tenantId,
      facilityId,
      staffUid: actorUid,
      actorUid: adminUid,
      actorRole: 'ADMIN',
      reason: 'Catalog-alternatives deep test pharmacy facility custody',
      commandKey: `alttest-facility-grant-${label}`,
    });
  }

  async function seedUser(tenantId, uid, role, name, phone) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, status, is_deleted, tenant_id, updated_at)
       VALUES ($1::uuid, $2, $3, $4, TRUE, 'active', FALSE, $5::uuid, NOW())`,
      uid, phone, name, role, tenantId,
    );
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
    const catalogId = Number(rows[0].id);
    // Availability is now sourced from real batch stock (mig 586 catalog_id link), not
    // catalog flags — so mirror stockQuantity into a linked in-stock batch. Both the
    // item and the batch carry the tenant's facility (and the batch its active
    // storage location), because migration 753 refuses active stock without them,
    // and because the endpoint sums stock scoped to the resolved facility.
    if (stockQuantity > 0 && inStock) {
      const { facilityId, storageLocationId } = custody.get(tenantId);
      const it = await prisma.$queryRawUnsafe(
        `INSERT INTO pharmacy_inventory_items
           (tenant_id, facility_id, sku_code, display_name, catalog_id, composition_id)
         VALUES ($1::uuid, $2::int, $3, $4, $5, $6) RETURNING id`,
        tenantId, facilityId, `ALTTEST-SKU-${catalogId}`, name, catalogId, compositionId,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO pharmacy_inventory_batches
           (tenant_id, inventory_item_id, facility_id, storage_location_id, batch_number,
            expiry_date, received_quantity, remaining_quantity, status)
         VALUES ($1::uuid, $2, $3::int, $4::int, $5,
                 (NOW() + INTERVAL '365 days')::date, $6, $6, 'in_stock')`,
        tenantId, Number(it[0].id), facilityId, storageLocationId,
        `ALTTEST-B-${catalogId}`, stockQuantity,
      );
    }
    return catalogId;
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

    // Actors + the full facility custody chain. The alternatives endpoint
    // resolves pharmacy facility custody BEFORE it reads the flag or the catalog
    // row, so tenant OFF needs the chain too — otherwise the flag-OFF case would
    // be answered by a custody refusal instead of the empty answer it asserts.
    // The caller's DB role is ADMIN, not SUPER_ADMIN. jwtMiddleware canonicalizes
    // the presented role through canonicalizeRequestRole (roles.js:223-226), which
    // maps SUPER_ADMIN → ADMIN, and pharmacyFacilityActorFromRequest reads
    // req.user.role — so the role assertPharmacyFacilityGrant compares the users
    // row against is the CANONICAL one the request carries, never the raw claim.
    // Seeding SUPER_ADMIN here would 403 on the role-parity check.
    await seedUser(TENANT_A, GRANT_ADMIN_A, 'ADMIN', 'ALTTEST A grant admin', '9000000031');
    await seedUser(TENANT_A, ACTOR_UID_A, 'ADMIN', 'ALTTEST A pharmacy actor', '9000000032');
    await seedUser(TENANT_OFF, GRANT_ADMIN_OFF, 'ADMIN', 'ALTTEST OFF grant admin', '9000000033');
    await seedUser(TENANT_OFF, ACTOR_UID_OFF, 'ADMIN', 'ALTTEST OFF pharmacy actor', '9000000034');
    await seedFacilityAuthority(TENANT_A, 'a', { actorUid: ACTOR_UID_A, adminUid: GRANT_ADMIN_A });
    await seedFacilityAuthority(TENANT_B, 'b');
    await seedFacilityAuthority(TENANT_OFF, 'off', { actorUid: ACTOR_UID_OFF, adminUid: GRANT_ADMIN_OFF });

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

    // COMBO_NULL_SPLIT (SELECTED, fail-safe path) — a genuine combination
    // (active_ingredients has 2 molecules) marked high confidence but whose
    // strength_components is NULL (models the manual-curation "high + omitted
    // split" garbage path that the automated parser cannot produce). When THIS
    // row is the selected brand, no sibling may be substitutable because the
    // selected drug's own per-ingredient split is unconfirmable.
    ids.comboNullSplitSelected = await seedCatalog(TENANT_A, 'ALTTEST Curated 625', {
      compositionId: comboId,
      strength: '625 mg',
      strengthKey: '625mg',
      strengthComponents: null,
      form: 'tablet',
      formKey: 'tablet',
      confidence: 'high',
      stockQuantity: 15,
      inStock: true,
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
      actorUid: ACTOR_UID_A,
      snapshot: { accepted: true },
    });
    // cleanup() sweeps this fixture out of a shared database, and the custody
    // chain above issues a real grant command. On an isolated clone that is
    // fast, but a whole shard runs sequentially against ONE database. CI
    // survives that only because run-ci-jest passes --testTimeout=60000, which
    // jest applies to hooks too; a plain local `jest` gets the 5s default and
    // fails the suite with every test still passing. Budget the hook explicitly
    // so it does not depend on the runner.
  }, 120_000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
    // Budgeted for the same reason as beforeAll.
  }, 120_000);

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

  it('fail-safe: a selected combo with an unconfirmable split (2 molecules, high, NULL strength_components) tags NO sibling substitutable', async () => {
    // The selected drug is a genuine combination (active_ingredients has amox +
    // clavulanic_acid) but its per-ingredient split is unknown. Even a sibling
    // with an identical strength_key/form_key/release/route + a proper 2-element
    // split MUST come back substitutable:false — we cannot confirm the selected
    // drug's own split, so no swap is safe. "Combo" is derived from the molecule
    // count, not from whether strength_components happened to parse.
    const res = await clientFor(tokenA).get(
      `/api/v1/pharmacy-orders/catalog/${ids.comboNullSplitSelected}/alternatives`,
    );
    expect(res.statusCode).toBe(200);

    const { selected, alternatives } = res.body.data;
    expect(Number(selected.catalog_id)).toBe(ids.comboNullSplitSelected);

    // Siblings still surface (informational) — the same-composition brands are
    // returned, just never tagged substitutable.
    expect(alternatives.length).toBeGreaterThan(0);
    for (const alt of alternatives) {
      expect(alt.substitutable).toBe(false);
    }

    // In particular SUB_OK — which HAS a proper 2-element split identical to the
    // canonical selected brand — is NOT substitutable here, because THIS
    // selected row's split is unconfirmable.
    const subOk = alternatives.find((a) => Number(a.catalog_id) === ids.subOk);
    expect(subOk).toBeDefined();
    expect(subOk.substitutable).toBe(false);
  });

  it('positive control: a selected combo WITH a proper 2-element split still yields substitutable:true for a matching sibling', async () => {
    // Guards against over-correction: the fail-safe must not neuter the gate
    // when the selected combo's split IS known. (Mirrors the main case but
    // asserted here alongside the fail-safe case for a tight before/after pair.)
    const res = await clientFor(tokenA).get(
      `/api/v1/pharmacy-orders/catalog/${ids.selected}/alternatives`,
    );
    expect(res.statusCode).toBe(200);
    const subOk = res.body.data.alternatives.find(
      (a) => Number(a.catalog_id) === ids.subOk,
    );
    expect(subOk).toBeDefined();
    expect(subOk.substitutable).toBe(true);
  });
});
