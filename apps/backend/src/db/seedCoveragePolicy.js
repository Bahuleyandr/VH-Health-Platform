export const INTENTIONALLY_EMPTY_SEED_TABLES = Object.freeze([
  // Scheduler receipts are operational facts. A seed must not fabricate a
  // discovery attempt, successful tick, or tenant failure merely to increase
  // a table-coverage count.
  'scheduled_job_runs',
  'scheduled_job_tenant_runs',
  // Clinical-alert obligations exist only after an exact delivery failure.
  // A healthy seed must not fabricate a missing roster or failed alert; the
  // pending-to-completed recovery path is covered by its database test.
  'clinical_alert_delivery_obligations',
  'clinical_alert_delivery_recovery_cases',
  'clinical_alert_delivery_recovery_actions',
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
  // A pharmacy staff facility grant is an authority an operator issues to a
  // named person for a named facility. Seed coverage must not issue one: a
  // standing synthetic grant would also silently satisfy the cross-facility
  // denial the counter-sale path exists to enforce. The suites that test that
  // enforcement seed their own scoped grant and revoke it.
  'pharmacy_staff_facility_grants',
  'pharmacy_staff_facility_grant_events',
  // An authority-recovery worklist row asserts that a real entity's facility or
  // inventory authority could NOT be established, and migration 753 raises them
  // only for rows that predate it. The seed builds fully authorised orders,
  // ward indents, items and batches, so a healthy seed has nothing to recover;
  // fabricating a row would assert an unresolved authority that does not exist.
  'pharmacy_inventory_authority_recovery_worklist',
  'pharmacy_inventory_authority_recovery_events',
  'pharmacy_ward_allocation_authority_recovery',
  'pharmacy_ward_allocation_authority_recovery_events',
  // Delivery custody events are custody provenance: each one is a signed claim
  // that a named person held named stock at a named time, carrying handoff and
  // inventory evidence hashes. Seed coverage must not manufacture a chain of
  // custody that nobody performed.
  'pharmacy_delivery_custody_events',
  // A payroll reconciliation resolution records an HR attestation by a named
  // SUPER_ADMIN over evidence hashes. It is historical payroll evidence, and a
  // seed must not attest on a human's behalf to make a table non-empty.
  'payroll_reconciliation_resolutions',
  // Salary arrears are a financial claim about months already paid. Every line
  // of the breakdown must name the payslip it corrects and carry that payslip's
  // evidence digest (salary_arrears_breakdown_valid). Seed coverage must not
  // invent a payslip evidence hash, nor assert that a past month was underpaid.
  'salary_arrears',
  // A pharmacy funding command and its reconciliation case exist only when a
  // payer decision or a posted payment leaves an order's funding unsettled, and
  // migration 753 anchors each to the EXACT owner task that governs it
  // (task_resource_type/task_resource_id must equal the order). Seed coverage
  // must not invent an unsettled funding position, nor the owner task that
  // would have to exist for one.
  'pharmacy_funding_commands',
  'pharmacy_funding_reconciliation_cases',
  'pharmacy_funding_reconciliation_events',
  // Pharmacy advance allocations and their reversals are funding-family
  // evidence ledgers: every row must anchor to an accepted funding-command
  // receipt (NOT NULL composite FKs into pharmacy_funding_commands, which is
  // itself intentionally empty above). A seed row would need a fabricated
  // funding receipt to exist at all, so the same principle applies.
  'pharmacy_advance_allocations',
  'pharmacy_advance_allocation_reversals',
  // Written only by the governed advance-funding flow, never by fixtures —
  // same as the two sibling allocation tables above it.
  'pharmacy_advance_allocation_consumptions',
  // Migration 753 makes every cath consumable usage that touches real stock
  // entail a governed reconciliation obligation: cath_inventory_authority_
  // assert_contract_753 requires a 'cath_inventory_shortfall_v1' owner task, a
  // 'cath_consumable_inventory_reconciliation' SLA instance and a
  // 'cath_inventory_shortfall' outbox entry whose recipient is backed by a
  // pharmacy facility grant — on top of an exact case/catalog/batch authority
  // and canonical timeline + audit provenance that reference the usage by its
  // own id. A seed cannot assemble that without inventing an owner, an SLA
  // obligation and a facility grant, so it must not create usage rows at all.
  // NOTE: this is a COVERAGE REGRESSION against main, where the generic walker
  // still seeds this table. It is recorded here rather than worked around.
  'cath_case_consumable_usage',
  // Migration 765's device register is minted FROM a cath usage row:
  // origin_usage_id is NOT NULL and tenant-pinned into
  // cath_case_consumable_usage, which is intentionally empty directly above.
  // A seeded device would therefore have to invent the very usage row (and its
  // governed shortfall obligation) that entry refuses to fabricate. Restoring
  // usage coverage restores this table's too.
  'cath_reprocessable_devices',
  // A salary revision activation event asserts that a SIGNED revision was
  // applied, and carries the terms manifest plus both signature digests. The
  // seeded revision is deliberately unsigned (pending_hr), so no activation has
  // happened and inventing one would fabricate the very signatures the
  // lifecycle contract exists to require.
  'salary_revision_activation_events',
  // An NHCX projection command exists only for an ACCEPTED transport receipt.
  // The seeded envelope has not been sent (its whole transport/projection group
  // is NULL), so there is no accepted receipt or task for a command to bind to.
  'nhcx_projection_commands'
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
