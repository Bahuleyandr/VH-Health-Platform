import { readFileSync } from 'node:fs';

const migration = readFileSync(
  new URL(
    '../../migrations/597_care_pathways_ed_closure_recovery.sql',
    import.meta.url,
  ),
  'utf8',
).replaceAll('\r', '');
const comprehensiveSeeder = readFileSync(
  new URL(
    '../../../scripts/seed-comprehensive-test-data.mjs',
    import.meta.url,
  ),
  'utf8',
).replaceAll('\r', '');

describe('migration 597 ED closure and recovery evidence', () => {
  test('keeps the comprehensive CI seed on an exact canonical ED evidence graph', () => {
    expect(comprehensiveSeeder).toContain("'ed_closure_evidence'");
    expect(comprehensiveSeeder).toContain("'ed_recovery_contact_events'");
    expect(comprehensiveSeeder).toContain(
      'async function seedEdClosureRecoveryEvidence()',
    );
    expect(comprehensiveSeeder).toContain(
      'await seedEdClosureRecoveryEvidence();',
    );
    expect(comprehensiveSeeder).toContain(
      "'emergency.closure_evidence_recorded'",
    );
    expect(comprehensiveSeeder).toContain(
      "'emergency.recovery_contact_recorded'",
    );
  });

  test('creates append-only tenant-isolated closure and recovery evidence', () => {
    for (const table of [
      'ed_closure_evidence',
      'ed_recovery_contact_events',
    ]) {
      expect(migration).toContain(`CREATE TABLE ${table}`);
      expect(migration).toContain(`'${table}'`);
    }
    expect(migration).toContain(
      "EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name)",
    );
    expect(migration).toContain(
      "EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name)",
    );
    expect(migration).toContain('s4_care_pathway_evidence_block_mutation()');
    expect(migration).toContain(
      'CREATE TRIGGER trg_ed_closure_evidence_append_only',
    );
    expect(migration).toContain(
      'CREATE TRIGGER trg_ed_recovery_contact_events_append_only',
    );
  });

  test('requires exact visit, patient, encounter, owner, and canonical evidence', () => {
    for (const contract of [
      'visit_record.patient_uid IS DISTINCT FROM NEW.patient_uid',
      'visit_record.encounter_id IS DISTINCT FROM NEW.encounter_id',
      'visit_record.attending_doctor_uid IS DISTINCT FROM NEW.clinician_uid',
      'care_pathway_named_clinician_is_viable(',
      "timeline_record.event_type <> 'emergency.closure_evidence_recorded'",
      "timeline_record.source_table <> 'ed_closure_evidence'",
      "audit_record.action <> 'emergency.closure_evidence_recorded'",
      "audit_record.resource_table <> 'ed_closure_evidence'",
    ]) {
      expect(migration).toContain(contract);
    }
  });

  test('binds follow-up, medication, external transfer, death, MLC, and identity sources', () => {
    for (const contract of [
      "follow_up_record.origin_kind IS DISTINCT FROM 'er_visit'",
      "follow_up_record.origin_resource_type IS DISTINCT FROM",
      'NEW.emergency_visit_id::text',
      "medication_record.rec_type IS DISTINCT FROM 'discharge'",
      "medication_record.status IS DISTINCT FROM 'completed'",
      "handoff_record.destination IS DISTINCT FROM 'external_transfer'",
      'death_record.tenant_id IS DISTINCT FROM NEW.tenant_id',
      'mlc_record.emergency_visit_id IS DISTINCT FROM',
      'merge_record.primary_uid',
      'merge_record.secondary_uid',
    ]) {
      expect(migration).toContain(contract);
    }
  });

  test('keeps death and medicolegal evidence outside the patient release surface', () => {
    expect(migration).toMatch(
      /patient_visibility_status IN \('hidden', 'released'\)[\s\S]*?closure_kind IN \('discharge', 'left_against_medical_advice', 'lwbs'\)[\s\S]*?OR patient_visibility_status = 'hidden'/s,
    );
    expect(migration).toMatch(
      /closure_kind = 'death'[\s\S]*?death_record_id IS NOT NULL/s,
    );
    expect(migration).toContain(
      "'Append-only policy-neutral LAMA/LWBS contact attempt and clinician outcome evidence; no embedded timer or attempt threshold.'",
    );
  });

  test('active mode gates planned terminal transitions on the latest exact revision', () => {
    expect(migration).toContain(
      'CREATE CONSTRAINT TRIGGER trg_emergency_visits_s5_closure_evidence',
    );
    expect(migration).toMatch(
      /NEW\.status = 'discharged'[\s\S]*?required_kind := 'discharge'/s,
    );
    expect(migration).toMatch(
      /NEW\.status = 'left_against_advice'[\s\S]*?required_kind := 'left_against_medical_advice'/s,
    );
    expect(migration).toMatch(
      /accepted_destination = 'external_transfer'[\s\S]*?required_kind := 'external_transfer'/s,
    );
    expect(migration).toContain(
      'evidence.evidence_revision = (',
    );
  });

  test('adds one human closure task without inventing an SLA or escalation policy', () => {
    expect(migration).toContain("'ed_closure_review'");
    expect(migration).toContain(
      'CREATE CONSTRAINT TRIGGER trg_tasks_s5_ed_closure_reserved_domain_binding',
    );
    for (const contract of [
      "NEW.related_resource_type IS DISTINCT FROM 'emergency_visit_closure'",
      "binding.pathway_key <> 'emergency_arrival_to_aftercare'",
      'binding.pathway_version <> 2',
      'NEW.assigned_to_uid IS DISTINCT FROM binding.attending_doctor_uid',
      'NEW.due_at IS NOT NULL',
      'NEW.sla_definition_id IS NOT NULL',
      'NEW.workflow_sla_instance_id IS NOT NULL',
      "NEW.sla_completion_semantics <> 'none'",
      "NEW.metadata ->> 'task_contract' IS DISTINCT FROM",
    ]) {
      expect(migration).toContain(contract);
    }
    expect(migration).not.toMatch(/INSERT\s+INTO\s+workflow_sla_rules/i);
    expect(migration).not.toMatch(/INSERT\s+INTO\s+escalation_rules/i);
    expect(migration).not.toMatch(/due_at\s*=\s*(NOW|CURRENT_TIMESTAMP)/i);
  });

  test('freezes version-1 destination handoffs and dispatches version 2 explicitly', () => {
    expect(migration).toContain(
      'ALTER FUNCTION s5_assert_ed_destination_handoff(UUID, UUID)',
    );
    expect(migration).toContain(
      'RENAME TO s5_assert_ed_destination_handoff_v1',
    );
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION s5_assert_ed_destination_handoff_v2',
    );
    expect(migration).toContain('ELSIF runtime_version = 1 THEN');
    expect(migration).toContain('ELSIF runtime_version = 2 THEN');
    expect(migration).toContain(
      "metadata ->> 'registry_version' IN ('5', '6')",
    );
  });
});
