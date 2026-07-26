import { readFileSync } from 'node:fs';

const migration = readFileSync(
  new URL('../../migrations/595_care_pathways_op_inpatient.sql', import.meta.url),
  'utf8',
).replaceAll('\r', '');
const prismaSchema = readFileSync(
  new URL('../../../prisma/schema.prisma', import.meta.url),
  'utf8',
).replaceAll('\r', '');

describe('migration 595 OP and inpatient care pathways', () => {
  test('creates the closed, append-only, tenant-isolated evidence substrate', () => {
    for (const table of [
      'care_pathway_resource_references',
      'op_visit_closure_evidence',
      'inpatient_primary_physician_assignments',
      'discharge_pending_result_handoffs',
      'discharge_pending_result_owner_actions',
      'post_discharge_contact_events',
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
    expect(migration).toContain('CREATE TRIGGER trg_care_pathway_resource_references_append_only');
    expect(migration).not.toMatch(/INSERT\s+INTO\s+care_pathway_resource_references/i);
  });

  test('binds supersession to the exact resource identity and relationship', () => {
    expect(migration).toMatch(
      /FOREIGN KEY \(\s*tenant_id,\s*superseded_reference_id,\s*pathway_instance_id,\s*patient_uid,\s*resource_type,\s*resource_id,\s*relationship_kind\s*\)\s*REFERENCES care_pathway_resource_references \(\s*tenant_id,\s*id,\s*pathway_instance_id,\s*patient_uid,\s*resource_type,\s*resource_id,\s*relationship_kind\s*\)/s,
    );
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX ux_care_pathway_resource_references_successor\s*ON care_pathway_resource_references \(\s*tenant_id,\s*superseded_reference_id,\s*pathway_instance_id,\s*patient_uid,\s*resource_type,\s*resource_id,\s*relationship_kind\s*\)/s,
    );
  });

  test('rejects unrelated task and handoff evidence for accepted ownership', () => {
    expect(migration).toContain(
      'CREATE TRIGGER trg_care_pathway_resource_references_ownership',
    );
    for (const condition of [
      'pathway.workflow_run_id = task.workflow_run_id',
      'task.patient_uid = NEW.patient_uid',
      'task.related_resource_type = NEW.resource_type',
      'task.related_resource_id = NEW.resource_id',
      'task.assigned_to_uid = NEW.accepted_owner_uid',
      'task.assigned_to_role IS NULL',
      "task.status = 'completed'",
      'task.completed_at IS NOT NULL',
      'handoff.patient_uid = NEW.patient_uid',
      'handoff.sending_pathway_instance_id = NEW.pathway_instance_id',
      'handoff.source_resource_type = NEW.resource_type',
      'handoff.source_resource_id = NEW.resource_id',
      "handoff.recipient_kind = 'user'",
      'handoff.intended_recipient_uid = NEW.accepted_owner_uid',
      'handoff.accepted_by_uid = NEW.accepted_owner_uid',
      "handoff.status IN ('accepted', 'completed', 'closed_loop')",
      'handoff.accepted_at IS NOT NULL',
      'OR handoff.task_id = NEW.task_id',
    ]) {
      expect(migration).toContain(condition);
    }
    expect(migration).not.toContain(
      "task.status IN ('in_progress', 'blocked', 'overdue', 'completed')",
    );
  });

  test('seals OP-to-inpatient transfer requests to the current OP step and exact external review task', () => {
    for (const contract of [
      "handoff_type <> 'op_to_inpatient_transfer'",
      "'op_to_inpatient_transfer_request_v1'",
      "'op_to_inpatient_transfer_review'",
      "'op_to_inpatient_transfer_review_v1'",
      "'source_appointment_id'",
      "'request_fingerprint'",
      "pathway.pathway_key = 'op_contact_to_recovery'",
      "pathway.source_episode_type = 'appointment'",
      'current_run.current_step_key = handoff.sending_step_key',
      "transfer.step_status NOT IN ('pending', 'in_progress', 'blocked')",
      "transfer.task_resource_type IS DISTINCT FROM\n          'care_handoff_instance'",
      'transfer.task_workflow_run_id IS NOT NULL',
      'transfer.task_workflow_step_id IS NOT NULL',
      'transfer.task_due_at IS NOT NULL',
      'transfer.task_sla_definition_id IS NOT NULL',
      'transfer.task_sla_instance_id IS NOT NULL',
      'transfer.pathway_owner_uid IS DISTINCT FROM transfer.sender_uid',
    ]) {
      expect(migration).toContain(contract);
    }
    expect(migration).toContain(
      'CREATE TRIGGER trg_care_handoff_op_to_ip_immutable',
    );
    expect(migration).toContain(
      'CREATE CONSTRAINT TRIGGER trg_care_handoff_op_to_ip_invariant',
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX ux_care_handoff_one_requested_op_to_ip_transfer',
    );
    expect(migration).toMatch(
      /ADD CONSTRAINT tasks_task_kind_check[\s\S]*?'pathway_owner_transfer_review',[\s\S]*?'op_to_inpatient_transfer_review'/s,
    );
    expect(migration).not.toContain(
      "task_metadata ->> 'appointment_id'",
    );
  });

  test('requires a plan whenever OP follow-up is clinically required', () => {
    expect(migration).toMatch(
      /chk_op_visit_closure_evidence_follow_up CHECK \(\s*NOT follow_up_required\s*OR follow_up_plan_id IS NOT NULL\s*\)/s,
    );
    for (const exactPlanContract of [
      "follow_up_record.origin_kind IS DISTINCT FROM 'consultation'",
      "follow_up_record.origin_resource_type IS DISTINCT FROM\n            'appointment'",
      'follow_up_record.origin_resource_id IS DISTINCT FROM\n            NEW.appointment_id::text',
      "follow_up_record.status NOT IN ('open', 'scheduled')",
      'CREATE CONSTRAINT TRIGGER trg_follow_up_plans_op_closure_dependency',
      "NEW.origin_kind IS DISTINCT FROM 'consultation'",
      "NEW.origin_resource_type IS DISTINCT FROM 'appointment'",
    ]) {
      expect(migration).toContain(exactPlanContract);
    }
  });

  test('binds accepted OP transfer to the author, distinct recipient, appointment, and pathway', () => {
    expect(migration).toContain('handoff_record.sender_uid IS DISTINCT FROM NEW.clinician_uid');
    expect(migration).toContain('handoff_record.intended_recipient_uid IS NULL');
    expect(migration).toMatch(
      /handoff_record\.intended_recipient_uid\s*=\s*handoff_record\.sender_uid/s,
    );
    expect(migration).toMatch(
      /handoff_record\.accepted_by_uid IS DISTINCT FROM\s*handoff_record\.intended_recipient_uid/s,
    );
    expect(migration).toContain(
      "handoff_record.source_resource_id <> NEW.appointment_id::text",
    );
    expect(migration).toContain(
      "handoff_record.pathway_key <> 'op_contact_to_recovery'",
    );
    expect(migration).toContain(
      "handoff_record.source_episode_id <> NEW.appointment_id::text",
    );
  });

  test('binds covering assignment to the exact admission pathway and handoff', () => {
    expect(migration).toContain(
      "handoff_record.handoff_type IS DISTINCT FROM\n            'covering_clinician_reassignment'",
    );
    expect(migration).toContain(
      "handoff_record.source_resource_type IS DISTINCT FROM\n            'care_pathway_instance'",
    );
    expect(migration).toMatch(
      /handoff_record\.source_resource_id IS DISTINCT FROM\s*handoff_record\.sending_pathway_instance_id::text/s,
    );
    expect(migration).toMatch(
      /handoff_record\.pathway_key IS DISTINCT FROM\s*'inpatient_admission_to_recovery'/s,
    );
    expect(migration).toContain(
      "handoff_record.source_episode_type IS DISTINCT FROM 'admission'",
    );
    expect(migration).toMatch(
      /handoff_record\.source_episode_id IS DISTINCT FROM\s*NEW\.admission_id::text/s,
    );
  });

  test('validates canonical evidence by exact patient, source, id, and event kind', () => {
    for (const eventType of [
      'appointment.closure_evidence_recorded',
      'admission.primary_physician.assigned',
      'admission.primary_physician.reassigned',
      'discharge_summary.signed',
      'post_discharge.contact_recorded',
    ]) {
      expect(migration).toContain(`'${eventType}'`);
    }
    expect(migration).toContain(
      "timeline_record.source_table <> 'op_visit_closure_evidence'",
    );
    expect(migration).toMatch(
      /timeline_record\.source_table IS DISTINCT FROM\s*'inpatient_primary_physician_assignments'/s,
    );
    expect(migration).toContain(
      "timeline_record.source_table <> 'post_discharge_contact_events'",
    );
    expect(migration).toContain('timeline_record.patient_uid IS DISTINCT FROM NEW.patient_uid');
    expect(migration).toContain('audit_record.patient_uid IS DISTINCT FROM NEW.patient_uid');
  });

  test('adds exact admission lineage to every pending-result source', () => {
    for (const [table, constraint] of [
      ['investigations', 'fk_investigations_admission'],
      ['lab_results', 'fk_lab_results_admission'],
      ['radiology_orders', 'fk_radiology_orders_admission'],
      ['ap_cases', 'fk_ap_cases_admission'],
      ['diagnostic_result_generations', 'fk_diagnostic_result_generations_admission'],
    ]) {
      expect(migration).toMatch(
        new RegExp(
          `ALTER TABLE ${table}[\\s\\S]*?ADD COLUMN admission_id INTEGER[\\s\\S]*?CONSTRAINT ${constraint}[\\s\\S]*?FOREIGN KEY \\(tenant_id, admission_id, patient_uid\\)[\\s\\S]*?REFERENCES admissions \\(tenant_id, id, patient_uid\\)`,
        ),
      );
    }
    expect(migration).toMatch(
      /chk_investigations_admission_patient CHECK \(\s*admission_id IS NULL OR patient_uid IS NOT NULL\s*\)/s,
    );
  });

  test('binds pending-result resolution to the exact admission and typed source with fill-once evidence', () => {
    expect(migration).toMatch(
      /FOREIGN KEY \(\s*tenant_id,\s*resolution_generation_id,\s*patient_uid,\s*admission_id\s*\)\s*REFERENCES diagnostic_result_generations \(\s*tenant_id,\s*id,\s*patient_uid,\s*admission_id\s*\)/s,
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX ux_diagnostic_result_generations_admission_context',
    );
    for (const sourceContract of [
      "NEW.source_type = 'diagnostic_result_generation'",
      'generation_record.id::text = NEW.source_id',
      "NEW.source_type = 'investigation'",
      'generation_record.investigation_id::text = NEW.source_id',
      "NEW.source_type = 'lab_result'",
      'generation_record.matches_lab_result',
      "NEW.source_type = 'radiology_order'",
      'generation_record.radiology_order_id::text = NEW.source_id',
      "NEW.source_type = 'anatomical_pathology_case'",
      'generation_record.matches_ap_case',
      'generation.admission_id = NEW.admission_id',
      'generation.patient_uid = NEW.patient_uid',
      'pending-result signed-summary inclusion evidence is fill-once',
      'pending-result resolution generation evidence is fill-once',
    ]) {
      expect(migration).toContain(sourceContract);
    }
    expect(migration).toMatch(
      /NEW\.handoff_state IN \('pending', 'result_available'\)[\s\S]*?task_record\.status IS NULL[\s\S]*?task_record\.status NOT IN \(\s*'open',\s*'in_progress',\s*'blocked',\s*'overdue'\s*\)/s,
    );
    expect(migration).toMatch(
      /NEW\.handoff_state = 'resolved'[\s\S]*?task_record\.status IS DISTINCT FROM 'completed'/s,
    );
    expect(migration).toMatch(
      /NEW\.handoff_state = 'superseded'[\s\S]*?task_record\.status IS NULL[\s\S]*?task_record\.status NOT IN \('completed', 'cancelled'\)/s,
    );
    expect(migration).toContain(
      "task_record.task_kind IS DISTINCT FROM 'follow_up'",
    );
    expect(migration).toContain(
      'task_record.parent_task_id IS NOT NULL',
    );
  });

  test('appends corrected-generation owner actions without rewriting the handoff anchor', () => {
    expect(migration).toContain(
      'CREATE TABLE discharge_pending_result_owner_actions',
    );
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX ux_discharge_pending_result_owner_actions_successor\s+ON discharge_pending_result_owner_actions \(\s*tenant_id,\s*predecessor_owner_action_id,\s*handoff_id,\s*admission_id,\s*patient_uid\s*\);/s,
    );
    expect(migration).not.toMatch(
      /ux_discharge_pending_result_owner_actions_successor[\s\S]*?WHERE predecessor_owner_action_id IS NOT NULL/s,
    );
    for (const contract of [
      'predecessor_generation_id UUID',
      'predecessor_owner_action_id UUID',
      'predecessor_resolution_action_id UUID',
      'rearm_source_action_id UUID',
      'source_outbox_event_id BIGINT NOT NULL',
      'CREATE CONSTRAINT TRIGGER trg_discharge_pending_result_owner_actions_validate',
      'CREATE TRIGGER trg_discharge_pending_result_owner_actions_append_only',
      'first pending-result owner action must attest the handoff generation anchor',
      'pending-result owner action must extend the exact current owner-action leaf',
      'same-generation pending-result owner action requires the exact completed predecessor and normal resolution receipt',
      'same-generation pending-result owner action requires the exact doctor reopen action',
      'corrected pending-result owner action must extend the exact prior owner action and its settlement state',
      'pending-result owner action generation must be the current signed leaf',
      "timeline_record.event_status IS DISTINCT FROM\n                'result_available'",
      "timeline_record.event_status IS DISTINCT FROM\n                'result_rearmed'",
      "outbox_record.payload ->> 'predecessor_generation_id'",
      "task_record.related_resource_type IS DISTINCT FROM\n          'discharge_pending_result_action'",
      "outbox_record.event_type IS DISTINCT FROM\n          'discharge.pending_result_available'",
      "timeline_record.payload ->> 'admission_id' IS DISTINCT FROM",
      "timeline_record.payload ->> 'handoff_id' IS DISTINCT FROM",
      "timeline_record.payload ->> 'generation_id' IS DISTINCT FROM",
      "timeline_record.payload ->> 'action_task_id' IS DISTINCT FROM",
      'timeline_record.payload ?& ARRAY[',
      'outbox_record.payload ?& ARRAY[',
      'CREATE TRIGGER trg_s4_pending_result_owner_task_dependency',
      'CREATE CONSTRAINT TRIGGER trg_tasks_pending_result_owner_state_dependency',
      'CREATE TRIGGER trg_s4_pending_result_tracking_task_dependency',
      'CREATE CONSTRAINT TRIGGER trg_tasks_pending_result_tracking_state_dependency',
      'CREATE TRIGGER trg_s4_pending_result_owner_timeline_dependency',
      'CREATE TRIGGER trg_s4_pending_result_owner_outbox_dependency',
      'CREATE TRIGGER trg_s4_pending_result_owner_audit_dependency',
      'pending-result owner-action task correlation evidence is immutable',
      'pending-result tracking task correlation evidence is immutable',
      'pending-result tracking task must match the final handoff binding, owner, and lifecycle state',
      'pending-result owner-action task reassignment requires the exact accepted primary-physician transfer',
      'pending-result owner-action task cancellation requires its exact successor action',
      'pending-result owner-action timeline correlation evidence is immutable',
      'pending-result owner-action outbox correlation evidence is immutable',
      'pending-result owner-action audit correlation evidence is immutable',
    ]) {
      expect(migration).toContain(contract);
    }
    expect(migration.match(/payload \?& ARRAY\[/g)).toHaveLength(2);
    expect(migration).toMatch(
      /FOREIGN KEY \(\s*tenant_id,\s*handoff_id,\s*admission_id,\s*patient_uid\s*\)\s*REFERENCES discharge_pending_result_handoffs \(\s*tenant_id,\s*id,\s*admission_id,\s*patient_uid\s*\)/s,
    );
    expect(migration).toMatch(
      /FOREIGN KEY \(\s*tenant_id,\s*generation_id,\s*patient_uid,\s*admission_id\s*\)\s*REFERENCES diagnostic_result_generations \(\s*tenant_id,\s*id,\s*patient_uid,\s*admission_id\s*\)/s,
    );
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION s4_governed_primary_transfer_exists',
    );
    expect(migration).toMatch(
      /JOIN admissions AS admission[\s\S]*?admission\.tenant_id = current_assignment\.tenant_id[\s\S]*?admission\.id = current_assignment\.admission_id[\s\S]*?admission\.patient_uid = current_assignment\.patient_uid/s,
    );
    expect(migration).toContain(
      'admission.attending_doctor IS NOT DISTINCT FROM',
    );
    expect(migration).toContain(
      'primary physician reassignment must update every current pending-result owner-action task in the same transaction',
    );
    expect(migration).toContain(
      'primary physician reassignment must wait for every signed successor generation to acquire its owner action',
    );
    expect(migration).toMatch(
      /JOIN diagnostic_result_generations AS successor_generation[\s\S]*?successor_action\.generation_id =\s*successor_generation\.id[\s\S]*?successor_action\.predecessor_generation_id =\s*action\.generation_id/s,
    );
  });

  test('provisions typed closure sections in shadow and active without touching off', () => {
    for (const sectionKey of [
      'patient_guardian_instructions',
      'escalation_contact',
      'required_equipment_home_care',
      'discharge_destination',
      'transport_plan',
    ]) {
      expect(migration).toContain(`('${sectionKey}')`);
    }
    expect(migration).toContain(
      'AND jsonb_typeof(template.sections) <> \'array\'',
    );
    expect(
      migration.match(
        /tenant\.settings #>>\s*'\{care_pathways,inpatient_admission_to_recovery\}'\s*IN \('shadow', 'active'\)/g,
      ),
    ).toHaveLength(5);
    expect(migration).toContain(
      'Provision only shadow/active tenants. OFF is behaviorally unchanged.',
    );
    expect(migration).toContain(
      'Rollout must pass through shadow before active',
    );
    expect(migration).toMatch(
      /UPDATE discharge_summary_templates AS template[\s\S]*?SET sections = template\.sections \|\| addition\.definitions,[\s\S]*?WHERE template\.id = addition\.template_id/s,
    );
    expect(migration).toContain("'default_body',\n             ''");
    expect(migration).toMatch(
      /MAX\([\s\S]*?definition\.value ->> 'display_order'[\s\S]*?ROW_NUMBER\(\) OVER \([\s\S]*?PARTITION BY template\.id/s,
    );
    expect(migration).toMatch(
      /INSERT INTO discharge_summary_sections \([\s\S]*?missing\.max_display_order \+ missing\.append_offset,[\s\S]*?NULL,[\s\S]*?missing\.tenant_id/s,
    );
    expect(migration).toContain(
      "header.status IN ('draft', 'ready_for_signoff')",
    );
    for (const signatureField of [
      'signed_at',
      'signed_by',
      'signed_by_name',
      'signed_by_reg',
    ]) {
      expect(migration).toContain(`header.${signatureField} IS NULL`);
    }
    expect(migration).toContain('$s4_discharge_section_assertions$');
    expect(migration).not.toMatch(
      /UPDATE\s+discharge_summary_sections/i,
    );
  });

  test('reflects every new table and exact-lineage column in Prisma without db-pull churn', () => {
    for (const model of [
      'care_pathway_resource_references',
      'op_visit_closure_evidence',
      'inpatient_primary_physician_assignments',
      'discharge_pending_result_handoffs',
      'discharge_pending_result_owner_actions',
      'post_discharge_contact_events',
    ]) {
      expect(prismaSchema).toContain(`model ${model} {`);
    }
    expect(prismaSchema).toMatch(/source_appointment_id\s+Int\?/);
    expect(prismaSchema).toMatch(/source_pathway_instance_id\s+String\?/);
    expect(prismaSchema).toMatch(/source_handoff_id\s+String\?/);
    for (const model of [
      'investigations',
      'lab_results',
      'radiology_orders',
      'ap_cases',
      'diagnostic_result_generations',
    ]) {
      const block = prismaSchema.match(
        new RegExp(`model ${model} \\{[\\s\\S]*?\\n\\}`),
      )?.[0];
      expect(block).toContain('admission_id');
    }
    expect(prismaSchema).toContain(
      '@@unique([tenant_id, id, patient_uid, admission_id], map: "ux_diagnostic_result_generations_admission_context")',
    );
    expect(prismaSchema).toContain(
      '@@unique([tenant_id, task_id], map: "ux_care_handoff_s4_reserved_task"',
    );
    expect(prismaSchema).toContain(
      '@@unique([tenant_id, downstream_resource_id, predecessor_action_id], map: "ux_diagnostic_action_discharge_owner_cross_sign"',
    );
  });
});
