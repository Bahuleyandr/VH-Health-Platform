import prisma from '../lib/prisma.js';
import {
  COMPOSITION_IDENTITY_FIELDS,
  resolveCompositionIdentitiesByCatalogIds,
  enrichMedicationsWithComposition,
} from '../services/pharmacy/compositionIdentityService.js';

// Two distinct tenants. Server-authoritative identity must be scoped to the
// tenant that owns the pharmacy_catalog row keyed by catalog_id — a client
// cannot borrow another tenant's row nor smuggle a composition_id.
const TENANT_A = '00000000-0000-4000-8000-00000c1d0a0a';
const TENANT_B = '00000000-0000-4000-8000-00000c1d0b0b';

describe('compositionIdentityService — server-authoritative resolver', () => {
  let a1Id; // tenant A, composition set, high confidence
  let a2Id; // tenant A, composition_id NULL
  let b1Id; // tenant B, composition set (must NOT leak into a tenant-A resolve)
  let compositionId;

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid,'cid-tenant-a','CID Tenant A') ON CONFLICT (id) DO NOTHING`,
      TENANT_A,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid,'cid-tenant-b','CID Tenant B') ON CONFLICT (id) DO NOTHING`,
      TENANT_B,
    );

    // Clean any prior run.
    await prisma.$executeRawUnsafe(`DELETE FROM pharmacy_catalog WHERE name LIKE 'CIDTEST %'`);

    // Global composition row (amoxicillin + clavulanic acid).
    const comp = await prisma.$queryRawUnsafe(
      `INSERT INTO drug_compositions (composition_key, display_label, active_ingredients, source)
       VALUES ('amoxicillin+clavulanic_acid', 'Amoxicillin + Clavulanic Acid',
               ARRAY['amoxicillin','clavulanic_acid']::text[], 'parsed')
       ON CONFLICT (composition_key) DO UPDATE SET display_label = EXCLUDED.display_label
       RETURNING id`,
    );
    compositionId = Number(comp[0].id);

    // Tenant A, A1 — full composition identity populated.
    const a1 = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (name, generic_name, is_active, tenant_id, composition_id, strength, strength_key,
          strength_components, form, form_key, release_key, route, composition_confidence,
          composition_source, updated_at)
       VALUES ('CIDTEST Augmentin 625', 'Amoxicillin+Clav', TRUE, $1::uuid, $2::int,
               '500mg+125mg', '625mg', '[{"ingredient":"amoxicillin","amount":500,"unit":"mg"}]'::jsonb,
               'Tablet', 'tablet', NULL, 'oral', 'high', 'parsed', NOW())
       RETURNING id`,
      TENANT_A, compositionId,
    );
    a1Id = Number(a1[0].id);

    // Tenant A, A2 — no composition resolved (composition_id NULL).
    const a2 = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog (name, generic_name, is_active, tenant_id, updated_at)
       VALUES ('CIDTEST Freeform Syrup', 'Something', TRUE, $1::uuid, NOW())
       RETURNING id`,
      TENANT_A,
    );
    a2Id = Number(a2[0].id);

    // Tenant B, B1 — composition set, belongs to a DIFFERENT tenant.
    const b1 = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (name, generic_name, is_active, tenant_id, composition_id, strength_key, form_key, updated_at)
       VALUES ('CIDTEST TenantB Augmentin', 'Amoxicillin+Clav', TRUE, $1::uuid, $2::int, '625mg', 'tablet', NOW())
       RETURNING id`,
      TENANT_B, compositionId,
    );
    b1Id = Number(b1[0].id);
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM pharmacy_catalog WHERE name LIKE 'CIDTEST %'`).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  it('exports the canonical server-derived identity field list', () => {
    expect(COMPOSITION_IDENTITY_FIELDS).toEqual([
      'composition_id', 'composition_key', 'active_ingredients', 'composition_label',
      'strength', 'strength_key', 'strength_components', 'form', 'form_key',
      'release_key', 'route', 'composition_confidence', 'generic_name',
    ]);
  });

  it('resolves tenant-A catalog ids and does NOT leak tenant-B rows', async () => {
    const map = await resolveCompositionIdentitiesByCatalogIds(TENANT_A, [a1Id, a2Id, b1Id]);
    expect(map).toBeInstanceOf(Map);
    expect(map.has(a1Id)).toBe(true);
    expect(map.has(a2Id)).toBe(true);
    expect(map.has(b1Id)).toBe(false); // tenant scoping — B1 belongs to tenant B

    const a1 = map.get(a1Id);
    expect(a1.composition_id).toBe(compositionId);
    expect(a1.composition_key).toBe('amoxicillin+clavulanic_acid');
    expect(Array.isArray(a1.active_ingredients)).toBe(true);
    expect(a1.active_ingredients).toContain('amoxicillin');
    expect(a1.composition_label).toBe('Amoxicillin + Clavulanic Acid');
    expect(a1.strength_key).toBe('625mg');
    expect(a1.form_key).toBe('tablet');
    expect(a1.composition_confidence).toBe('high');
    expect(typeof a1.strength_components).toBe('object');
    expect(a1.name).toBe('CIDTEST Augmentin 625');

    const a2 = map.get(a2Id);
    expect(a2.composition_id).toBeNull();
    expect(a2.composition_key).toBeNull();
    expect(a2.active_ingredients).toBeNull();
    expect(a2.composition_label).toBeNull();
    expect(a2.strength_key).toBeNull();
  });

  // Note on "no query" guards: `prisma` is a Proxy whose get-trap returns a
  // freshly bound wrapped function on every access, so jest.spyOn cannot install
  // a spy on `$queryRawUnsafe`. We instead assert the observable contract (empty
  // Map) for each early-return guard, and separately prove tenant-scoping runs a
  // real scoped query below.
  it('returns an empty Map for empty ids (early-return guard, no throw)', async () => {
    const map = await resolveCompositionIdentitiesByCatalogIds(TENANT_A, []);
    expect(map).toBeInstanceOf(Map);
    expect(map.size).toBe(0);
  });

  it('returns an empty Map for a null tenant (early-return guard, no throw)', async () => {
    const map = await resolveCompositionIdentitiesByCatalogIds(null, [a1Id]);
    expect(map).toBeInstanceOf(Map);
    expect(map.size).toBe(0);
  });

  it('drops non-numeric ids and returns an empty Map when none are numeric', async () => {
    const map = await resolveCompositionIdentitiesByCatalogIds(TENANT_A, ['abc', NaN, null, -1, 0]);
    expect(map).toBeInstanceOf(Map);
    expect(map.size).toBe(0);
  });

  it('enrich overwrites a client-sent composition_id with the SERVER value', async () => {
    const meds = await enrichMedicationsWithComposition(TENANT_A, [
      { catalog_id: a1Id, name: 'Augmentin', composition_id: 999999, active_ingredients: ['LIES'] },
    ]);
    const med = meds[0];
    expect(med.composition_id).toBe(compositionId);
    expect(med.composition_id).not.toBe(999999);
    expect(med.active_ingredients).toContain('amoxicillin');
    expect(med.active_ingredients).not.toContain('LIES');
    // The fabricated client value never survives.
    expect(JSON.stringify(meds)).not.toContain('999999');
    expect(JSON.stringify(meds)).not.toContain('LIES');
  });

  it('enrich accepts catalogId (camelCase) as well as catalog_id', async () => {
    const meds = await enrichMedicationsWithComposition(TENANT_A, [
      { catalogId: a1Id, name: 'Augmentin' },
    ]);
    expect(meds[0].composition_key).toBe('amoxicillin+clavulanic_acid');
  });

  it('enrich passes free-text meds (no catalog_id) through unchanged, no fabricated identity', async () => {
    const input = [{ name: 'SomeFreeText', dose: '1 tab' }];
    const meds = await enrichMedicationsWithComposition(TENANT_A, input);
    expect(meds[0].name).toBe('SomeFreeText');
    expect(meds[0].dose).toBe('1 tab');
    expect(meds[0]).not.toHaveProperty('composition_id');
    expect(meds[0]).not.toHaveProperty('composition_key');
    expect(meds[0]).not.toHaveProperty('active_ingredients');
    // Input must not be mutated.
    expect(input[0]).not.toHaveProperty('composition_id');
  });

  it('enrich strips client identity for a catalog_id that does NOT resolve (wrong tenant)', async () => {
    // b1Id belongs to tenant B; resolving under tenant A yields nothing.
    const meds = await enrichMedicationsWithComposition(TENANT_A, [
      { catalog_id: b1Id, name: 'Borrowed', composition_id: 12345, composition_key: 'forged' },
    ]);
    const med = meds[0];
    expect(med.name).toBe('Borrowed');
    expect(med.composition_id).toBeUndefined();
    expect(med.composition_key).toBeUndefined();
    expect(JSON.stringify(meds)).not.toContain('12345');
    expect(JSON.stringify(meds)).not.toContain('forged');
  });

  // Real DB-error path: a non-UUID string is truthy (passes the `!tenantId`
  // guard) but makes `$1::uuid` throw 22P02 at execution — exercising the
  // try/catch that logs logger.warn and returns an empty Map. This proves the
  // guarded path against a genuine driver error (no mocking of the Proxy).
  const BAD_TENANT = 'not-a-valid-uuid';

  it('is guarded: a DB error yields an empty Map and no throw', async () => {
    const map = await resolveCompositionIdentitiesByCatalogIds(BAD_TENANT, [a1Id]);
    expect(map).toBeInstanceOf(Map);
    expect(map.size).toBe(0);
  });

  it('is guarded: on DB error enrich strips client identity but does not fabricate, no throw', async () => {
    const meds = await enrichMedicationsWithComposition(BAD_TENANT, [
      { catalog_id: a1Id, name: 'Augmentin', composition_id: 999999 },
    ]);
    const med = meds[0];
    expect(med.name).toBe('Augmentin');
    expect(med.composition_id).toBeUndefined(); // stripped, not fabricated
    expect(JSON.stringify(meds)).not.toContain('999999');
  });
});
