export const INTENTIONALLY_EMPTY_SEED_TABLES = Object.freeze([
  'clinical_continuity_edge_access_grants',
  'clinical_continuity_edge_access_revocations',
  'clinical_continuity_edge_log_receipts',
  'clinical_continuity_replay_attempts',
  'clinical_continuity_replay_effect_evidence',
  'clinical_continuity_replay_receipts',
]);

const intentionallyEmptySeedTableSet = new Set(INTENTIONALLY_EMPTY_SEED_TABLES);

export function partitionSeedCoverageEmptyTables(emptyTables) {
  const intentionallyEmptyAppTables = [];
  const unexpectedEmptyAppTables = [];

  for (const table of emptyTables) {
    if (intentionallyEmptySeedTableSet.has(table)) {
      intentionallyEmptyAppTables.push(table);
    } else {
      unexpectedEmptyAppTables.push(table);
    }
  }

  return { intentionallyEmptyAppTables, unexpectedEmptyAppTables };
}
