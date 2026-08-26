export const INTENTIONALLY_EMPTY_SEED_TABLES = Object.freeze([
  // Scheduler receipts are operational facts. A seed must not fabricate a
  // discovery attempt, successful tick, or tenant failure merely to increase
  // a table-coverage count.
  'scheduled_job_runs',
  'scheduled_job_tenant_runs',
  // Activation authority ships inert. Seed coverage must not invent signing
  // identities, weaken a cohort evidence floor, or fabricate a transition.
  'clinical_continuity_activation_evidence_gate_configs',
  'clinical_continuity_activation_key_roster',
  'clinical_continuity_activation_transition_events',
  'clinical_continuity_edge_access_grants',
  'clinical_continuity_edge_access_revocations',
  'clinical_continuity_edge_log_receipts',
  'clinical_continuity_replay_attempts',
  'clinical_continuity_replay_effect_evidence',
  'clinical_continuity_replay_receipts',
  'clinical_continuity_device_journal_offsets',
  // External-recovery rows are immutable operator and human-awareness
  // evidence. Seed coverage must not register or resume a source partition,
  // invent a late critical result, or fabricate a clinician acknowledgement.
  'external_recovery_operability_actions',
  'external_recovery_critical_review_obligations',
  'external_recovery_critical_review_acknowledgements',
  // Laboratory threshold rows are clinical policy and its operational
  // evidence. Generic seed coverage must not invent a facility catalogue,
  // pathologist approval, activation, or unmatched-result exception.
  'lab_threshold_catalog_entries',
  'lab_threshold_catalog_states',
  'lab_threshold_policy_bundles',
  'lab_threshold_policy_rules',
  'lab_threshold_unmatched_exceptions',
  // Inbound ADT/ORM recovery receipts require exact encrypted HL7 and ACK
  // bytes, signed cursor/retention evidence, and a real no-SLA owner task.
  // Seeds must not fabricate a sender outage or activate an I03 partition.
  'hl7_inbound_recovery_receipts',
  // Device-loss rows are incident evidence and standing containment routes.
  // Test seeds must not invent a lost device, affected identity, or C-D6 owner.
  'clinical_continuity_device_loss_operations',
  'clinical_continuity_device_loss_routes',
  'clinical_continuity_device_loss_subjects',
  'clinical_continuity_incident_aliases',
  'clinical_continuity_incident_attestations',
  // Incident-packet provisioning is dormant until a tenant registers its
  // countersigned phone tree and signing authority. Seed coverage must not
  // invent either authority, reserve paper serials, or fabricate custody.
  'clinical_continuity_incident_contact_sheet_approvals',
  'clinical_continuity_incident_contact_sheets',
  'clinical_continuity_incident_declarations',
  'clinical_continuity_incident_interfaces',
  'clinical_continuity_incident_packet_allocations',
  'clinical_continuity_incident_packet_artifacts',
  'clinical_continuity_incident_packet_custody_events',
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
  // Owner evidence is required to create I06 late study-link receipts. Seed
  // coverage must not invent a PACS outage, owner decision, or recovery cursor.
  'imaging_study_link_recovery_receipts',
  'patient_merge_requests',
  // Owner reconciliation is required because SCIM exposes no provider-side
  // sequence. Seed coverage must not invent identity commands or C-D15 effects.
  'scim_provisioning_commands',
  // Recipient priority is tenant policy. Seed coverage must not invent a
  // hospital hierarchy or silently activate ranking for any tenant.
  'escalation_recipient_rank_mappings',
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
