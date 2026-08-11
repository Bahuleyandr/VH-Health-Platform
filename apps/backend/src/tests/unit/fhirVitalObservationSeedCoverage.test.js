import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const seederPath = path.resolve(__dirname, '../../../scripts/seed-comprehensive-test-data.mjs');

describe('FHIR vital observation comprehensive seed coverage', () => {
  const source = readFileSync(seederPath, 'utf8');

  test('keeps immutable receipt tables out of the generic coverage walker', () => {
    const manualTables = source.match(
      /const MANUAL_SEED_TABLES = new Set\(\[[\s\S]*?\]\);/,
    )?.[0];

    expect(manualTables).toContain("'fhir_vital_observation_receipts'");
    expect(manualTables).toContain("'fhir_vital_observation_sets'");
    expect(manualTables).toContain("'fhir_vital_observation_set_resources'");
  });

  test('seeds one valid linked and completed provenance graph after generic coverage', () => {
    const seedFunction = source.match(
      /async function seedFhirVitalObservationReceiptGraph\(\)[\s\S]*?(?=\ntry \{)/,
    )?.[0];

    expect(seedFunction).toMatch(/fhir:\$\{createHash|FHIR_VITAL_SEED_RESOURCE_FINGERPRINT/);
    expect(seedFunction).toContain("['8867-4']");
    expect(seedFunction).toMatch(/INSERT INTO vitals_chart[\s\S]*?'fhir'/);
    expect(seedFunction).toMatch(/INSERT INTO fhir_vital_observation_receipts/);
    expect(seedFunction).toMatch(/INSERT INTO fhir_vital_observation_sets/);
    expect(seedFunction).toMatch(/news2_effects_completed_at, anomaly_effects_completed_at/);
    expect(seedFunction).toMatch(/INSERT INTO fhir_vital_observation_set_resources/);
    expect(source.indexOf('await seedFhirVitalObservationReceiptGraph();'))
      .toBeGreaterThan(source.indexOf('const { seeded, failed } = await seedRemainingTables();'));
  });
});
