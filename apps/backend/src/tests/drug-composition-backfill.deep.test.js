import prisma from '../lib/prisma.js';
import { backfillCompositions } from '../../scripts/backfill-drug-compositions.mjs';

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
