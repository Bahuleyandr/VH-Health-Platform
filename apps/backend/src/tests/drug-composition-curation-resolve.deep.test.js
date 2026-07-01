import prisma from '../lib/prisma.js';
import { resolveCuration } from '../../scripts/resolve-drug-composition.mjs';

// Guards the WRITE-SIDE combo substitutability safety gate at the point of
// manual curation. A curator must not be able to mark a COMBINATION drug (a
// composition with >=2 active ingredients) as `high` confidence without
// supplying a valid per-ingredient strength_components split. When they try,
// resolveCuration DOWNGRADES the persisted confidence to `medium` and keeps
// the curation-queue row actionable (status stays `open`), so the combo
// returns to the worklist for a proper split. This mirrors the parser
// invariant in compositionParser.parseCatalogRow (a combo with no usable
// per-ingredient components is forced to confidence='medium'/'partial_strength')
// and the fail-safe /alternatives endpoint (is-combo is derived from the
// molecule set, not from whether components happened to parse).

const TENANT = '00000000-0000-4000-8000-000000000001';

async function seedRow(name, genericName) {
  const r = await prisma.$queryRawUnsafe(
    `INSERT INTO pharmacy_catalog (name, generic_name, is_active, tenant_id, composition_source, composition_confidence, updated_at)
     VALUES ($1,$2,TRUE,$3::uuid,'parsed','medium',NOW()) RETURNING id`,
    name, genericName, TENANT,
  );
  const catalogId = Number(r[0].id);
  await prisma.$executeRawUnsafe(
    `INSERT INTO drug_composition_curation_queue (tenant_id, catalog_id, reason, status)
     VALUES ($1::uuid,$2::int,'partial_strength','open')
     ON CONFLICT (tenant_id, catalog_id) DO UPDATE SET status='open', reason='partial_strength', updated_at=NOW()`,
    TENANT, catalogId,
  );
  return catalogId;
}

describe('resolveCuration — combo high-confidence requires a valid per-ingredient split', () => {
  let comboMissingId, comboValidId, monoId;
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM drug_composition_curation_queue WHERE catalog_id IN (SELECT id FROM pharmacy_catalog WHERE name LIKE 'CRTEST %')`);
    await prisma.$executeRawUnsafe(`DELETE FROM pharmacy_catalog WHERE name LIKE 'CRTEST %'`);
    comboMissingId = await seedRow('CRTEST Augmentin 625mg', 'Amoxicillin + Clavulanic acid');
    comboValidId = await seedRow('CRTEST Clavam 625mg', 'Amoxicillin + Clavulanic acid');
    monoId = await seedRow('CRTEST Metformin 500mg', 'Metformin');
  });
  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM drug_composition_curation_queue WHERE catalog_id IN (SELECT id FROM pharmacy_catalog WHERE name LIKE 'CRTEST %')`);
    await prisma.$executeRawUnsafe(`DELETE FROM pharmacy_catalog WHERE name LIKE 'CRTEST %'`);
    await prisma.$disconnect().catch(() => {});
  });

  it('combo + high + MISSING strength_components → downgrades to medium and keeps the queue row actionable', async () => {
    await resolveCuration({
      catalogId: comboMissingId,
      compositionKey: 'amoxicillin+clavulanic_acid',
      // strengthComponents intentionally omitted
      confidence: 'high', reviewer: 'pharmacist-1', notes: 'no split supplied',
    });
    const row = await prisma.$queryRawUnsafe(
      `SELECT composition_source, composition_confidence FROM pharmacy_catalog WHERE id=$1::int`, comboMissingId);
    expect(row[0].composition_confidence).toBe('medium'); // NOT high — downgraded
    expect(row[0].composition_source).toBe('curated'); // still records the curated identity
    const q = await prisma.$queryRawUnsafe(
      `SELECT status FROM drug_composition_curation_queue WHERE catalog_id=$1::int`, comboMissingId);
    expect(q[0].status).toBe('open'); // stays on the worklist, not resolved
  });

  it('combo + high + INVALID (single-element) strength_components → downgrades to medium', async () => {
    await resolveCuration({
      catalogId: comboMissingId,
      compositionKey: 'amoxicillin+clavulanic_acid',
      strengthComponents: [{ ingredient: 'amoxicillin', amount: 500, unit: 'mg' }], // only 1 element
      confidence: 'high', reviewer: 'pharmacist-1', notes: 'incomplete split',
    });
    const row = await prisma.$queryRawUnsafe(
      `SELECT composition_confidence FROM pharmacy_catalog WHERE id=$1::int`, comboMissingId);
    expect(row[0].composition_confidence).toBe('medium');
    const q = await prisma.$queryRawUnsafe(
      `SELECT status FROM drug_composition_curation_queue WHERE catalog_id=$1::int`, comboMissingId);
    expect(q[0].status).toBe('open');
  });

  it('combo + high + VALID >=2-element strength_components → accepted as high and resolves the queue row', async () => {
    await resolveCuration({
      catalogId: comboValidId,
      compositionKey: 'amoxicillin+clavulanic_acid',
      strengthComponents: [
        { ingredient: 'amoxicillin', amount: 500, unit: 'mg' },
        { ingredient: 'clavulanic_acid', amount: 125, unit: 'mg' },
      ],
      confidence: 'high', reviewer: 'pharmacist-1', notes: 'verified per pack',
    });
    const row = await prisma.$queryRawUnsafe(
      `SELECT composition_source, composition_confidence FROM pharmacy_catalog WHERE id=$1::int`, comboValidId);
    expect(row[0].composition_confidence).toBe('high');
    expect(row[0].composition_source).toBe('curated');
    const q = await prisma.$queryRawUnsafe(
      `SELECT status FROM drug_composition_curation_queue WHERE catalog_id=$1::int`, comboValidId);
    expect(q[0].status).toBe('resolved');
  });

  it('mono + high + no strength_components → accepted as high (unchanged)', async () => {
    await resolveCuration({
      catalogId: monoId,
      compositionKey: 'metformin',
      // mono drug — no per-ingredient split exists, so high is fine
      confidence: 'high', reviewer: 'pharmacist-1', notes: 'single molecule',
    });
    const row = await prisma.$queryRawUnsafe(
      `SELECT composition_confidence FROM pharmacy_catalog WHERE id=$1::int`, monoId);
    expect(row[0].composition_confidence).toBe('high');
    const q = await prisma.$queryRawUnsafe(
      `SELECT status FROM drug_composition_curation_queue WHERE catalog_id=$1::int`, monoId);
    expect(q[0].status).toBe('resolved');
  });
});
