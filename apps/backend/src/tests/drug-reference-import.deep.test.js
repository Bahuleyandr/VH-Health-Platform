/**
 * Deep test: scripts/import-drug-reference.mjs against the QA DB.
 * Covers: composition upsert precedence (curated protected, parsed upgraded),
 * idempotency, allopathy filter, exact-brand catalog matching, ambiguity ->
 * curation queue with explicit tenant_id, and protected catalog rows.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import pg from 'pg';
import { importCompositions, matchCatalog, coverageStats } from '../../scripts/import-drug-reference.mjs';

// CI provides DATABASE_URL (postgres service); local QA runs export TEST_DATABASE_URL.
// The bare-port fallback only serves ad-hoc local runs against the QA cluster.
const CONN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgresql://postgres:postgres@127.0.0.1:55432/vhhealth_test';
const TENANT = '00000000-0000-0000-0000-00000000d16e';
const MARK = 'drugref-test';

const ROWS = [
  { // single molecule, matches catalog row exactly
    brand_name: `Azithral 500 Tablet (${MARK})`, manufacturer: 'Alembic Pharmaceuticals Ltd',
    pack_label: 'strip of 5 tablets', form_raw: null, price_inr: 132, is_discontinued: false,
    ingredients: [{ molecule: 'azithromycin', strength_value: 500, strength_unit: 'mg', strength_raw: '500mg' }],
    composition_raw: 'Azithromycin (500mg)', composition_status: 'complete', substitutes_raw: [],
    type: 'allopathy', sources: [{ source: 'github-jr', source_id: '2', seen_at: '2026-07-07' }],
    first_seen: '2026-07-07', last_seen: '2026-07-07',
  },
  { // combo
    brand_name: `Augmentin 625 Duo Tablet (${MARK})`, manufacturer: 'GlaxoSmithKline',
    pack_label: 'strip of 10 tablets', form_raw: null, price_inr: 223, is_discontinued: false,
    ingredients: [
      { molecule: 'amoxycillin', strength_value: 500, strength_unit: 'mg', strength_raw: '500mg' },
      { molecule: 'clavulanic acid', strength_value: 125, strength_unit: 'mg', strength_raw: '125mg' }],
    composition_raw: 'Amoxycillin (500mg) + Clavulanic Acid (125mg)', composition_status: 'complete',
    substitutes_raw: [], type: 'allopathy', sources: [{ source: 'github-jr', source_id: '1', seen_at: '2026-07-07' }],
    first_seen: '2026-07-07', last_seen: '2026-07-07',
  },
  { // non-allopathy -> must be skipped
    brand_name: `Herbal Tonic (${MARK})`, manufacturer: 'X', pack_label: 'bottle',
    form_raw: null, price_inr: 10, is_discontinued: false,
    ingredients: [{ molecule: 'ashwagandha', strength_value: null, strength_unit: null, strength_raw: null }],
    composition_raw: 'Ashwagandha', composition_status: 'complete', substitutes_raw: [],
    type: 'ayurvedic', sources: [{ source: 'github-jr', source_id: '3', seen_at: '2026-07-07' }],
    first_seen: '2026-07-07', last_seen: '2026-07-07',
  },
  { // ambiguous pair: same brand name, two manufacturers, DIFFERENT compositions
    brand_name: `Ambiguo Tablet (${MARK})`, manufacturer: 'Maker A', pack_label: 'strip of 10',
    form_raw: null, price_inr: 10, is_discontinued: false,
    ingredients: [{ molecule: 'paracetamol', strength_value: 500, strength_unit: 'mg', strength_raw: '500mg' }],
    composition_raw: 'Paracetamol (500mg)', composition_status: 'complete', substitutes_raw: [],
    type: 'allopathy', sources: [{ source: 'github-jr', source_id: '4', seen_at: '2026-07-07' }],
    first_seen: '2026-07-07', last_seen: '2026-07-07',
  },
  {
    brand_name: `Ambiguo Tablet (${MARK})`, manufacturer: 'Maker B', pack_label: 'strip of 10',
    form_raw: null, price_inr: 12, is_discontinued: false,
    ingredients: [{ molecule: 'ibuprofen', strength_value: 400, strength_unit: 'mg', strength_raw: '400mg' }],
    composition_raw: 'Ibuprofen (400mg)', composition_status: 'complete', substitutes_raw: [],
    type: 'allopathy', sources: [{ source: 'github-jr', source_id: '5', seen_at: '2026-07-07' }],
    first_seen: '2026-07-07', last_seen: '2026-07-07',
  },
];

let client;
let artifactDir;
const catalogIds = [];

async function seedCatalogRow(name, over = {}) {
  const res = await client.query(
    `INSERT INTO pharmacy_catalog (tenant_id, name, generic_name, is_active, composition_source, composition_confidence)
     VALUES ($1::uuid, $2, $3, TRUE, $4, $5)
     RETURNING id`,
    [TENANT, name, over.generic_name ?? null, over.composition_source ?? null, over.composition_confidence ?? null],
  );
  catalogIds.push(res.rows[0].id);
  return res.rows[0].id;
}

beforeAll(async () => {
  client = new pg.Client({ connectionString: CONN });
  await client.connect();
  await client.query(
    `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, 'drugref-test-tenant', 'DrugRef Test Tenant')
     ON CONFLICT (id) DO NOTHING`,
    [TENANT],
  );
  artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drugref-artifact-'));
  fs.writeFileSync(path.join(artifactDir, 'drugs.jsonl'), ROWS.map((r) => JSON.stringify(r)).join('\n') + '\n');
});

afterAll(async () => {
  if (catalogIds.length) {
    await client.query('DELETE FROM drug_composition_curation_queue WHERE catalog_id = ANY($1::int[])', [catalogIds]);
    await client.query('DELETE FROM pharmacy_catalog WHERE id = ANY($1::int[])', [catalogIds]);
  }
  await client.query("DELETE FROM drug_compositions WHERE composition_key IN ('azithromycin','amoxycillin+clavulanic_acid','paracetamol','ibuprofen','curatedmark-test')");
  await client.query('DELETE FROM tenants WHERE id=$1::uuid', [TENANT]);
  fs.rmSync(artifactDir, { recursive: true, force: true });
  await client.end();
});

describe('importCompositions', () => {
  test('imports allopathy compositions as source=imported, skips non-allopathy, idempotent', async () => {
    // pre-seed one key as 'parsed' (should upgrade) and one as 'curated' (must survive)
    await client.query(
      `INSERT INTO drug_compositions (composition_key, display_label, active_ingredients, source)
       VALUES ('azithromycin','azithromycin','{azithromycin}','parsed')
       ON CONFLICT (composition_key) DO UPDATE SET source='parsed'`,
    );
    await client.query(
      `INSERT INTO drug_compositions (composition_key, display_label, active_ingredients, source)
       VALUES ('paracetamol','CURATED LABEL','{paracetamol}','curated')
       ON CONFLICT (composition_key) DO UPDATE SET source='curated', display_label='CURATED LABEL'`,
    );

    const s1 = await importCompositions(artifactDir, { connectionString: CONN });
    expect(s1.rows).toBe(5);
    expect(s1.eligible).toBe(4);
    expect(s1.errors).toBe(0);

    const az = (await client.query("SELECT source FROM drug_compositions WHERE composition_key='azithromycin'")).rows[0];
    expect(az.source).toBe('imported'); // parsed upgraded

    const cur = (await client.query("SELECT source, display_label FROM drug_compositions WHERE composition_key='paracetamol'")).rows[0];
    expect(cur.source).toBe('curated'); // curated never overwritten
    expect(cur.display_label).toBe('CURATED LABEL');

    const combo = (await client.query("SELECT source, active_ingredients FROM drug_compositions WHERE composition_key='amoxycillin+clavulanic_acid'")).rows[0];
    expect(combo).toBeDefined();
    expect(combo.active_ingredients).toEqual(['amoxycillin', 'clavulanic_acid']);

    const herbal = (await client.query("SELECT 1 FROM drug_compositions WHERE composition_key='ashwagandha'")).rows;
    expect(herbal.length).toBe(0); // non-allopathy skipped

    // idempotent
    const s2 = await importCompositions(artifactDir, { connectionString: CONN });
    expect(s2.errors).toBe(0);
    const count = (await client.query("SELECT COUNT(*)::int AS n FROM drug_compositions WHERE composition_key='azithromycin'")).rows[0];
    expect(count.n).toBe(1);
  });
});

describe('matchCatalog', () => {
  test('exact match sets composition, ambiguous queues with tenant_id, protected untouched', async () => {
    const exactId = await seedCatalogRow(`Azithral 500 Tablet (${MARK})`);
    const ambiguousId = await seedCatalogRow(`Ambiguo Tablet (${MARK})`);
    const noMatchId = await seedCatalogRow(`Nonexistent Brand (${MARK})`);
    const curatedId = await seedCatalogRow(`Azithral 500 Tablet (${MARK})`, { composition_source: 'curated' });

    const s = await matchCatalog(artifactDir, { tenantId: TENANT, connectionString: CONN });
    expect(s.matched).toBe(1);
    expect(s.ambiguous).toBe(1);
    expect(s.skippedProtected).toBe(1);
    expect(s.unmatched).toBe(1);

    const exact = (await client.query('SELECT composition_id, composition_source, composition_confidence FROM pharmacy_catalog WHERE id=$1', [exactId])).rows[0];
    expect(exact.composition_id).not.toBeNull();
    expect(exact.composition_source).toBe('imported');
    expect(exact.composition_confidence).toBe('high');

    const amb = (await client.query('SELECT composition_id FROM pharmacy_catalog WHERE id=$1', [ambiguousId])).rows[0];
    expect(amb.composition_id).toBeNull();
    const queue = (await client.query('SELECT tenant_id, reason, status FROM drug_composition_curation_queue WHERE catalog_id=$1', [ambiguousId])).rows;
    expect(queue.length).toBe(1);
    expect(queue[0].tenant_id).toBe(TENANT);
    expect(queue[0].reason).toBe('reference_ambiguous');
    expect(queue[0].status).toBe('open');

    const untouched = (await client.query('SELECT composition_id FROM pharmacy_catalog WHERE id=$1', [noMatchId])).rows[0];
    expect(untouched.composition_id).toBeNull();

    const curated = (await client.query('SELECT composition_id, composition_source FROM pharmacy_catalog WHERE id=$1', [curatedId])).rows[0];
    expect(curated.composition_id).toBeNull();
    expect(curated.composition_source).toBe('curated');

    // idempotent re-run: no double queue rows, matched row stays matched
    const s2 = await matchCatalog(artifactDir, { tenantId: TENANT, connectionString: CONN });
    expect(s2.skippedProtected).toBe(2); // curated + now-high-confidence imported row
    const queue2 = (await client.query('SELECT COUNT(*)::int AS n FROM drug_composition_curation_queue WHERE catalog_id=$1', [ambiguousId])).rows[0];
    expect(queue2.n).toBe(1);
  });

  test('coverageStats reports tenant coverage', async () => {
    const s = await coverageStats({ tenantId: TENANT, connectionString: CONN });
    expect(s.total).toBeGreaterThanOrEqual(4);
    expect(typeof s.row_coverage_pct).toBe('number');
    expect(typeof s.row_gate_90).toBe('boolean');
  });
});
