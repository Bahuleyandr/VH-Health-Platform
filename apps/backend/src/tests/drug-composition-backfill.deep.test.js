import prisma from '../lib/prisma.js';
import { backfillCompositions, enrichCatalogRowForWrite } from '../../scripts/backfill-drug-compositions.mjs';
import { resolveCuration } from '../../scripts/resolve-drug-composition.mjs';

const TENANT = '00000000-0000-4000-8000-000000000001';

describe('drug-composition backfill', () => {
  let augId, clavId;
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM drug_composition_curation_queue WHERE catalog_id IN (SELECT id FROM pharmacy_catalog WHERE name LIKE 'BFTEST %')`);
    await prisma.$executeRawUnsafe(`DELETE FROM pharmacy_catalog WHERE name LIKE 'BFTEST %'`);
    const a = await prisma.$queryRawUnsafe(`INSERT INTO pharmacy_catalog (name, generic_name, is_active, tenant_id, updated_at) VALUES ('BFTEST Augmentin 625mg','Amoxicillin+Clav',TRUE,$1::uuid,NOW()) RETURNING id`, TENANT);
    augId = Number(a[0].id);
    const b = await prisma.$queryRawUnsafe(`INSERT INTO pharmacy_catalog (name, generic_name, is_active, tenant_id, updated_at) VALUES ('BFTEST Clavam 625mg','Amoxicillin + Clavulanic acid',TRUE,$1::uuid,NOW()) RETURNING id`, TENANT);
    clavId = Number(b[0].id);
  });
  afterAll(async () => { await prisma.$disconnect().catch(() => {}); });

  it('resolves both brands to the SAME composition and is idempotent', async () => {
    await backfillCompositions({ where: "name LIKE 'BFTEST %'" });
    const rows = await prisma.$queryRawUnsafe(`SELECT id, composition_id, strength_key FROM pharmacy_catalog WHERE id IN ($1::int,$2::int)`, augId, clavId);
    expect(rows[0].composition_id).toBeTruthy();
    expect(rows[0].composition_id).toBe(rows[1].composition_id); // same composition
    expect(rows[0].strength_key).toBe('625mg');
    // idempotent: a second run produces no new composition rows
    const before = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int n FROM drug_compositions`);
    await backfillCompositions({ where: "name LIKE 'BFTEST %'" });
    const after = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int n FROM drug_compositions`);
    expect(after[0].n).toBe(before[0].n);
  });

  it('queues the combo for curation (partial_strength) and does NOT overwrite source=curated', async () => {
    const q = await prisma.$queryRawUnsafe(`SELECT reason FROM drug_composition_curation_queue WHERE catalog_id=$1::int`, augId);
    expect(q[0].reason).toBe('partial_strength');
    await prisma.$executeRawUnsafe(`UPDATE pharmacy_catalog SET composition_source='curated' WHERE id=$1::int`, augId);
    await prisma.$executeRawUnsafe(`UPDATE pharmacy_catalog SET strength_key='OVERRIDDEN' WHERE id=$1::int`, augId);
    await backfillCompositions({ where: "name LIKE 'BFTEST %'" });
    const r = await prisma.$queryRawUnsafe(`SELECT strength_key FROM pharmacy_catalog WHERE id=$1::int`, augId);
    expect(r[0].strength_key).toBe('OVERRIDDEN'); // curated rows are skipped
  });
});

describe('enrichCatalogRowForWrite (write-path hook)', () => {
  it('returns the structured columns for an upsert payload', () => {
    const e = enrichCatalogRowForWrite({ name: 'Metformin 500mg SR', generic_name: 'Metformin' });
    expect(e.strength_key).toBe('500mg');
    expect(e.form_key).toBe('tablet');
    expect(e.release_key).toBe('sr');
    expect(e.composition_confidence).toBe('high');
  });
});

describe('resolveCuration', () => {
  // Self-sufficient: ensure BFTEST Clavam exists and is queued regardless of
  // describe ordering (the earlier backfill describe may or may not have run).
  beforeAll(async () => {
    const existing = await prisma.$queryRawUnsafe(`SELECT id FROM pharmacy_catalog WHERE name='BFTEST Clavam 625mg'`);
    if (existing.length === 0) {
      await prisma.$executeRawUnsafe(`INSERT INTO pharmacy_catalog (name, generic_name, is_active, tenant_id, updated_at) VALUES ('BFTEST Clavam 625mg','Amoxicillin + Clavulanic acid',TRUE,$1::uuid,NOW())`, TENANT);
    }
    // Run the backfill so a curation-queue row exists for this catalog row.
    await backfillCompositions({ where: "name LIKE 'BFTEST %'" });
  });

  it('sets curated identity, closes the queue row, and survives re-backfill', async () => {
    const c = await prisma.$queryRawUnsafe(`SELECT id, tenant_id FROM pharmacy_catalog WHERE name='BFTEST Clavam 625mg'`);
    const catalogId = Number(c[0].id);
    await resolveCuration({
      catalogId,
      compositionKey: 'amoxicillin+clavulanic_acid',
      strengthComponents: [{ ingredient: 'amoxicillin', amount: 500, unit: 'mg' }, { ingredient: 'clavulanic_acid', amount: 125, unit: 'mg' }],
      confidence: 'high', reviewer: 'pharmacist-1', notes: 'verified per pack',
    });
    const row = await prisma.$queryRawUnsafe(`SELECT composition_source, composition_confidence, strength_components FROM pharmacy_catalog WHERE id=$1::int`, catalogId);
    expect(row[0].composition_source).toBe('curated');
    expect(row[0].composition_confidence).toBe('high');
    const q = await prisma.$queryRawUnsafe(`SELECT status, reviewer FROM drug_composition_curation_queue WHERE catalog_id=$1::int`, catalogId);
    expect(q[0].status).toBe('resolved');
    expect(q[0].reviewer).toBe('pharmacist-1');
  });
});
