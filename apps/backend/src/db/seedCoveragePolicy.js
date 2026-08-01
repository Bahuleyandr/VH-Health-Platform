export const INTENTIONALLY_EMPTY_SEED_TABLES = Object.freeze([
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
