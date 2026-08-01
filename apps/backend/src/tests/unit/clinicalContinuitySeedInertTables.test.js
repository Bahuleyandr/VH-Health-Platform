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
  test('keeps the exact gated credential, receipt, and reconciliation tables intentionally empty', () => {
    expect(INTENTIONALLY_EMPTY_SEED_TABLES).toEqual([
      'clinical_continuity_edge_access_grants',
      'clinical_continuity_edge_access_revocations',
      'clinical_continuity_edge_log_receipts',
      'clinical_continuity_replay_attempts',
      'clinical_continuity_replay_effect_evidence',
      'clinical_continuity_replay_receipts',
      'clinical_continuity_device_journal_offsets',
      'clinical_continuity_incident_aliases',
      'clinical_continuity_incident_attestations',
      'clinical_continuity_incident_declarations',
      'clinical_continuity_incident_interfaces',
      'clinical_continuity_incident_packets',
      'clinical_continuity_incidents',
      'clinical_continuity_paper_items',
      'clinical_continuity_paper_range_decisions',
      'clinical_continuity_paper_ranges',
      'clinical_continuity_patient_merge_decisions',
      'clinical_continuity_reconciliation_config',
      'clinical_continuity_reconciliation_decisions',
      'clinical_continuity_reconciliation_items',
      'clinical_continuity_retrospective_facts',
      'clinical_continuity_temporary_identities',
      'patient_merge_requests',
    ]);
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
