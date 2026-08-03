import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INTENTIONALLY_EMPTY_SEED_TABLES,
  partitionSeedCoverageEmptyTables,
} from '../../db/seedCoveragePolicy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const seederPath = path.resolve(__dirname, '../../../scripts/seed-comprehensive-test-data.mjs');
const contractsPath = path.resolve(__dirname, '../../db/schemaContracts.js');

describe('clinical continuity comprehensive seed boundary', () => {
  test('keeps every intentionally-empty table policy-listed and vice versa', () => {
    const partition = partitionSeedCoverageEmptyTables(INTENTIONALLY_EMPTY_SEED_TABLES);

    expect(new Set(INTENTIONALLY_EMPTY_SEED_TABLES).size)
      .toBe(INTENTIONALLY_EMPTY_SEED_TABLES.length);
    expect(partition.intentionallyEmptyAppTables).toEqual(INTENTIONALLY_EMPTY_SEED_TABLES);
    expect(partition.unexpectedEmptyAppTables).toEqual([]);
  });

  test('shares the allowlist between the seeder and seeded DB contract gate', () => {
    const source = fs.readFileSync(seederPath, 'utf8');
    const contractsSource = fs.readFileSync(contractsPath, 'utf8');

    expect(source).toContain(
      'const INTENTIONALLY_EMPTY_TABLES = new Set(INTENTIONALLY_EMPTY_SEED_TABLES);',
    );
    expect(source).toContain('!INTENTIONALLY_EMPTY_TABLES.has(table)');
    expect(source).toContain('intentionallyEmptyAppTables: intentionallyEmpty');
    expect(contractsSource).toContain('partitionSeedCoverageEmptyTables(emptyTables)');
    expect(contractsSource).toContain('ok: unexpectedEmptyAppTables.length === 0');
  });

  test('allows only the explicit gated tables and still reports any other empty table', () => {
    expect(partitionSeedCoverageEmptyTables([
      'clinical_continuity_edge_access_grants',
      'clinical_continuity_replay_receipts',
      'unexpected_table',
      'clinical_continuity_edge_log_receipts',
    ])).toEqual({
      intentionallyEmptyAppTables: [
        'clinical_continuity_edge_access_grants',
        'clinical_continuity_replay_receipts',
        'clinical_continuity_edge_log_receipts',
      ],
      unexpectedEmptyAppTables: ['unexpected_table'],
    });
  });
});
