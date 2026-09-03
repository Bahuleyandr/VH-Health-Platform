import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const seederPath = path.resolve(__dirname, '../../../scripts/seed-comprehensive-test-data.mjs');

describe('clinical import comprehensive seed closure', () => {
  const source = readFileSync(seederPath, 'utf8');
  const manualTables = source.match(
    /const MANUAL_SEED_TABLES = new Set\(\[[\s\S]*?\]\);/,
  )?.[0];
  const seedFunction = source.slice(
    source.indexOf('async function seedClinicalImportReceiptGraph()'),
    source.indexOf('\ntry {', source.indexOf('async function seedClinicalImportReceiptGraph()')),
  );

  test('keeps the append-only authority journey out of the generic walker', () => {
    for (const table of [
      'clinical_import_authority_events',
      'clinical_import_raw_artifacts',
      'clinical_import_document_receipts',
      'clinical_import_resource_receipts',
      'clinical_import_reconciliation_items',
      'clinical_import_reconciliation_events',
    ]) {
      expect(manualTables).toContain(`'${table}'`);
    }
  });

  test('seeds one exact synthetic authority, custody, receipt, and owned hold graph', () => {
    expect(seedFunction).toContain("ARRAY['fhir_bundle']::text[]");
    expect(seedFunction).toContain("'MEDICAL_RECORDS'");
    expect(seedFunction).toContain("'manual_medical_records'");
    expect(seedFunction).toContain("'asserted_unverified'");
    expect(seedFunction).toContain("'failed'");
    expect(seedFunction).toContain("'OPENED'");
    expect(seedFunction).toContain("'CLINICAL_IMPORT_ASSERTION_PROMOTION_OWNER'");
    expect(seedFunction).toContain("'HELD_EXTERNAL_AUTHORITY'");
    expect(seedFunction).toContain('ARRAY[]::integer[]');
    expect(seedFunction).toContain("set_config('app.current_tenant_id'");
    expect(seedFunction).toContain("clock_timestamp() - INTERVAL '5 minutes'");
    expect(seedFunction).toContain("clock_timestamp() + INTERVAL '1 day'");
    expect(seedFunction).not.toContain("'2026-09-03T00:00:00.000Z'::timestamptz");
    expect(seedFunction).not.toContain("'2099-01-01T00:00:00.000Z'::timestamptz");
    expect(seedFunction).not.toMatch(/event_type[^\n]*'REVOKED'/);
  });

  test('runs the coherent graph only after generic dependency discovery', () => {
    const firstGenericSweep = source.indexOf(
      'const { seeded, failed: initialSeedFailures } = await seedRemainingTables();',
    );
    const clinicalImportSeed = source.indexOf('await seedClinicalImportReceiptGraph();');

    expect(firstGenericSweep).toBeGreaterThan(0);
    expect(clinicalImportSeed).toBeGreaterThan(firstGenericSweep);
    expect(clinicalImportSeed).toBeLessThan(source.indexOf('const finalSweep = await seedRemainingTables();'));
  });
});
