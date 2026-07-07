// Roadmap B8 — terminology service deep round-trip.
//
// Seeds concepts/maps/catalog rows with a distinctive B8TEST prefix and
// exercises the full HTTP surface: code-systems list, ranked search, catalog
// + structural validation, forward/reverse mapping, catalog bindings,
// suggestions, coverage, and curator RBAC.

import prisma from '../lib/prisma.js';
import { authClient } from './testClient.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

let catalogIdA;
let catalogIdB;

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM terminology_catalog_bindings WHERE code LIKE 'B8%' OR display LIKE 'B8TEST%'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM terminology_concept_maps WHERE source_code LIKE 'B8%' OR target_code LIKE 'B8%'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM terminology_concepts WHERE code LIKE 'B8%' OR display LIKE 'B8TEST%' OR code = 'BA00'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM investigation_test_catalog WHERE name LIKE 'B8TEST%'`,
  ).catch(() => {});
}

d('Terminology service — deep round-trip (roadmap B8)', () => {
  beforeAll(async () => {
    process.env.WHO_ICD_DISABLE_AUTH = 'false';
    process.env.WHO_ICD_CLIENT_ID = '';
    process.env.WHO_ICD_CLIENT_SECRET = '';
    await cleanup();

    // Concepts: two ICD10 displays for ranking, one SNOMED target, two LOINC
    // rows that exactly match catalog names (binding + suggestion paths).
    await prisma.$executeRawUnsafe(
      `INSERT INTO terminology_concepts (system_key, code, display, category, status) VALUES
         ('ICD10', 'B8T.0', 'B8TEST Fever', 'B8TEST', 'active'),
         ('ICD10', 'B8T.1', 'B8TEST Fever with chills', 'B8TEST', 'active'),
         ('ICD10', 'B8T.9', 'B8TEST Retired concept', 'B8TEST', 'inactive'),
         ('ICD11', 'BA00', 'B8TEST Essential hypertension', 'B8TEST', 'active'),
         ('SNOMED_CT', 'B8386661000', 'B8TEST Fever (finding)', 'finding', 'active'),
         ('LOINC', 'B8888-8', 'B8TEST Glucose Panel', 'CHEM', 'active'),
         ('LOINC', 'B8999-9', 'B8TEST Sodium Serum', 'CHEM', 'active')
       ON CONFLICT (system_key, code) DO NOTHING`,
    );
    // Deterministic validate() paths: ICD10 counts as imported; LOINC stays
    // "not imported" so the structural fallback branch is exercised even
    // though individual B8 LOINC rows exist for exact lookup.
    await prisma.$executeRawUnsafe(
      `UPDATE terminology_code_systems
          SET concept_count = (SELECT COUNT(*) FROM terminology_concepts WHERE system_key = 'ICD10')
        WHERE system_key = 'ICD10'`,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE terminology_code_systems SET concept_count = 0 WHERE system_key = 'LOINC'`,
    );

    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO investigation_test_catalog (name, code, category, is_active)
       VALUES ('B8TEST Glucose Panel', 'B8TEST-GLU', 'B8TEST', true),
              ('B8TEST Sodium Serum', 'B8TEST-NA', 'B8TEST', true)
       RETURNING id, name`,
    );
    // Raw queries surface int8 ids as BigInt — normalize before they reach
    // request bodies (JSON.stringify rejects BigInt) and === comparisons.
    catalogIdA = Number(rows.find((r) => r.name === 'B8TEST Glucose Panel').id);
    catalogIdB = Number(rows.find((r) => r.name === 'B8TEST Sodium Serum').id);
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('lists registered code systems', async () => {
    const res = await authClient('DOCTOR').get('/api/v1/terminology/code-systems');
    expect(res.status).toBe(200);
    const keys = res.body.data.systems.map((s) => s.system_key);
    for (const expected of ['ICD10', 'ICD11', 'SNOMED_CT', 'LOINC', 'ATC']) {
      expect(keys).toContain(expected);
    }
  });

  test('ranked search: exact code first, then prefix, shorter displays first', async () => {
    const byText = await authClient('DOCTOR')
      .get('/api/v1/terminology/search')
      .query({ system: 'icd-10', q: 'B8TEST Fever' });
    expect(byText.status).toBe(200);
    const displays = byText.body.data.concepts.map((c) => c.display);
    expect(displays[0]).toBe('B8TEST Fever');
    expect(displays).toContain('B8TEST Fever with chills');
    expect(displays).not.toContain('B8TEST Retired concept'); // inactive filtered

    const byCode = await authClient('DOCTOR')
      .get('/api/v1/terminology/search')
      .query({ system: 'ICD10', q: 'B8T.1' });
    expect(byCode.status).toBe(200);
    expect(byCode.body.data.concepts[0].code).toBe('B8T.1');
  });

  test('ICD-11 search and validate fall back to local terminology cache without WHO credentials', async () => {
    const search = await authClient('DOCTOR')
      .get('/api/v1/terminology/search')
      .query({ system: 'ICD11', q: 'B8TEST Essential' });
    expect(search.status).toBe(200);
    expect(search.body.data.concepts[0]).toMatchObject({
      system_key: 'ICD11',
      code: 'BA00',
      display: 'B8TEST Essential hypertension',
    });

    const concept = await authClient('DOCTOR')
      .get('/api/v1/terminology/concepts/ICD11/BA00');
    expect(concept.status).toBe(200);
    expect(concept.body.data.concept).toMatchObject({ code: 'BA00' });

    const validate = await authClient('DOCTOR')
      .get('/api/v1/terminology/validate')
      .query({ system: 'ICD11', code: 'BA00' });
    expect(validate.status).toBe(200);
    expect(validate.body.data).toMatchObject({ valid: true, mode: 'catalog' });
  });

  test('search rejects unknown system and short query', async () => {
    const bad = await authClient('DOCTOR')
      .get('/api/v1/terminology/search')
      .query({ system: 'CPT4', q: 'fever' });
    expect(bad.status).toBe(400);

    const short = await authClient('DOCTOR')
      .get('/api/v1/terminology/search')
      .query({ system: 'ICD10', q: 'f' });
    expect(short.status).toBe(400);
  });

  test('validate: catalog hit, catalog miss, inactive concept', async () => {
    const hit = await authClient('DOCTOR')
      .get('/api/v1/terminology/validate')
      .query({ system: 'ICD10', code: 'B8T.0' });
    expect(hit.status).toBe(200);
    expect(hit.body.data).toMatchObject({ valid: true, mode: 'catalog' });

    const miss = await authClient('DOCTOR')
      .get('/api/v1/terminology/validate')
      .query({ system: 'ICD10', code: 'B8T.NOPE' });
    expect(miss.status).toBe(200);
    expect(miss.body.data).toMatchObject({ valid: false, mode: 'catalog', reason: 'code_not_found' });

    const inactive = await authClient('DOCTOR')
      .get('/api/v1/terminology/validate')
      .query({ system: 'ICD10', code: 'B8T.9' });
    expect(inactive.status).toBe(200);
    expect(inactive.body.data.valid).toBe(false);
    expect(inactive.body.data.reason).toBe('concept_inactive');
  });

  test('validate: LOINC structural fallback while catalogue not imported', async () => {
    const structural = await authClient('DOCTOR')
      .get('/api/v1/terminology/validate')
      .query({ system: 'LOINC', code: '2160-0' });
    expect(structural.status).toBe(200);
    expect(structural.body.data).toMatchObject({ valid: true, mode: 'structural' });

    const garbage = await authClient('DOCTOR')
      .get('/api/v1/terminology/validate')
      .query({ system: 'LOINC', code: 'not-a-loinc' });
    expect(garbage.status).toBe(200);
    expect(garbage.body.data).toMatchObject({ valid: false, reason: 'invalid_structure' });
  });

  test('concept maps: curator writes, forward + reverse reads', async () => {
    const write = await authClient('ADMIN')
      .post('/api/v1/terminology/map')
      .send({
        from_system: 'ICD10',
        from_code: 'B8T.0',
        to_system: 'SNOMED_CT',
        to_code: 'B8386661000',
        relationship: 'broader',
      });
    expect(write.status).toBe(201);

    const forward = await authClient('DOCTOR')
      .get('/api/v1/terminology/map')
      .query({ from: 'ICD10', code: 'B8T.0', to: 'SNOMED_CT' });
    expect(forward.status).toBe(200);
    expect(forward.body.data.mappings).toHaveLength(1);
    expect(forward.body.data.mappings[0]).toMatchObject({ code: 'B8386661000', relationship: 'broader' });

    // Reverse lookup inverts the relationship (stored broader → narrower).
    const reverse = await authClient('DOCTOR')
      .get('/api/v1/terminology/map')
      .query({ from: 'SNOMED_CT', code: 'B8386661000', to: 'ICD10' });
    expect(reverse.status).toBe(200);
    expect(reverse.body.data.mappings).toHaveLength(1);
    expect(reverse.body.data.mappings[0]).toMatchObject({ code: 'B8T.0', relationship: 'narrower' });
  });

  test('map write rejected for non-curator clinical role', async () => {
    const res = await authClient('NURSING_STAFF')
      .post('/api/v1/terminology/map')
      .send({
        from_system: 'ICD10', from_code: 'B8T.0',
        to_system: 'SNOMED_CT', to_code: 'B8386661000',
      });
    expect(res.status).toBe(403);
  });

  test('catalog binding: confirm, list, reject unknown code', async () => {
    const bind = await authClient('ADMIN')
      .post('/api/v1/terminology/bindings')
      .send({
        catalog_type: 'investigation_test',
        catalog_id: catalogIdA,
        system: 'LOINC',
        code: 'B8888-8',
      });
    expect(bind.status).toBe(201);
    expect(bind.body.data.binding).toMatchObject({
      binding_status: 'confirmed',
      code: 'B8888-8',
      display: 'B8TEST Glucose Panel',
    });

    const list = await authClient('DOCTOR')
      .get(`/api/v1/terminology/bindings/investigation_test/${catalogIdA}`);
    expect(list.status).toBe(200);
    expect(list.body.data.bindings).toHaveLength(1);

    // SNOMED_CT counts as unimported (concept_count 0) and 'B8-bogus' is not
    // a known concept → 400 without allow_unknown_code.
    const unknown = await authClient('ADMIN')
      .post('/api/v1/terminology/bindings')
      .send({
        catalog_type: 'investigation_test',
        catalog_id: catalogIdA,
        system: 'SNOMED_CT',
        code: 'B8-bogus',
      });
    expect(unknown.status).toBe(400);
  });

  test('binding suggestions match unbound catalog rows by name', async () => {
    const res = await authClient('ADMIN')
      .post('/api/v1/terminology/bindings/suggest')
      .send({ catalog_type: 'investigation_test', system: 'LOINC', persist: false });
    expect(res.status).toBe(200);
    const forB = res.body.data.suggestions.find((s) => s.catalog_id === catalogIdB);
    expect(forB).toBeDefined();
    expect(forB).toMatchObject({ code: 'B8999-9', confidence: 1 });
    // catalogIdA is already bound for LOINC → must not be re-suggested.
    expect(res.body.data.suggestions.some((s) => s.catalog_id === catalogIdA)).toBe(false);
  });

  test('coverage report counts the confirmed binding', async () => {
    const res = await authClient('DOCTOR').get('/api/v1/terminology/coverage');
    expect(res.status).toBe(200);
    const inv = res.body.data.coverage.catalog_bindings.find((c) => c.catalog_type === 'investigation_test');
    expect(inv).toBeDefined();
    expect(inv.confirmed).toBeGreaterThanOrEqual(1);
    expect(inv.catalog_rows).toBeGreaterThanOrEqual(2);
    const mapCoverage = res.body.data.coverage.concept_maps.find(
      (c) => c.source_system === 'ICD10' && c.target_system === 'SNOMED_CT',
    );
    expect(mapCoverage).toBeDefined();
    expect(mapCoverage.relationships.broader).toBeGreaterThanOrEqual(1);
  });

  test('binding write rejected for non-curator; patient blocked at mount', async () => {
    const nurse = await authClient('NURSING_STAFF')
      .post('/api/v1/terminology/bindings')
      .send({
        catalog_type: 'investigation_test',
        catalog_id: catalogIdB,
        system: 'LOINC',
        code: 'B8999-9',
      });
    expect(nurse.status).toBe(403);

    const patient = await authClient('PATIENT').get('/api/v1/terminology/code-systems');
    expect(patient.status).toBe(403);
  });
});
