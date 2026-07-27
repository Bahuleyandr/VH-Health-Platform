import { readFileSync } from 'node:fs';

const migration = readFileSync(
  new URL(
    '../../migrations/596_care_pathways_ed_destination_handoff.sql',
    import.meta.url,
  ),
  'utf8',
).replaceAll('\r', '');

describe('migration 596 ED destination handoff', () => {
  test('reserves one exact role task without inventing an SLA or urgency policy', () => {
    for (const contract of [
      "'ed_destination_handoff_review'",
      "'ed_destination_handoff_review_v1'",
      "transfer.task_resource_type IS DISTINCT FROM\n          'care_handoff_instance'",
      "transfer.task_priority <> 'high'",
      'transfer.task_owner_uid IS NOT NULL',
      'transfer.task_owner_role IS DISTINCT FROM',
      'transfer.task_due_at IS NOT NULL',
      'transfer.task_sla_instance_id IS NOT NULL',
      "transfer.task_sla_completion_semantics <> 'none'",
      "urgency_code = 'not_applicable'",
    ]) {
      expect(migration).toContain(contract);
    }
    expect(migration).not.toMatch(/INSERT\s+INTO\s+workflow_sla_rules/i);
    expect(migration).not.toMatch(/policy_due_at\s*=\s*(NOW|CURRENT_TIMESTAMP)/i);
    expect(migration).toContain(
      'CREATE UNIQUE INDEX ux_care_handoff_s5_ed_reserved_task',
    );
  });

  test('binds request identity to the exact ED owner, pathway, step, and destination', () => {
    for (const contract of [
      "'ed_destination_handoff_request_v1'",
      "'supersedes_handoff_id='",
      "sending_step_key = 'await_destination_acceptance'",
      "source_resource_type = 'emergency_visit'",
      "transfer.pathway_key <> 'emergency_arrival_to_aftercare'",
      "transfer.source_episode_type <> 'emergency_visit'",
      'transfer.attending_doctor_uid IS DISTINCT FROM transfer.sender_uid',
      "metadata ->> 'destination' IN (",
      "metadata ->> 'registry_version' = '5'",
    ]) {
      expect(migration).toContain(contract);
    }
    expect(migration).toContain(
      'CREATE UNIQUE INDEX ux_care_handoff_one_live_ed_destination',
    );
    expect(migration).toContain(
      'CREATE CONSTRAINT TRIGGER trg_care_handoff_s5_ed_validate',
    );
    expect(migration).toContain(
      'CREATE CONSTRAINT TRIGGER trg_tasks_s5_ed_reserved_domain_binding',
    );
  });

  test('requires exact active-role acceptance and a completed role task at closure', () => {
    for (const contract of [
      "handoff.status = 'accepted'",
      'handoff.accepted_at IS NOT NULL',
      'handoff.accepted_by_uid IS NOT NULL',
      "handoff.recipient_kind = 'role'",
      'handoff.intended_recipient_uid IS NULL',
      'handoff.intended_recipient_role = UPPER(BTRIM(accepter.role))',
      "task.status = 'completed'",
      'accepter.is_active',
      "accepter.status = 'active'",
      'NOT accepter.is_deleted',
      'accepter.deleted_at IS NULL',
    ]) {
      expect(migration).toContain(contract);
    }
    expect(migration).toContain(
      'CREATE CONSTRAINT TRIGGER trg_emergency_visits_s5_destination_acceptance',
    );
    expect(migration).toMatch(
      /NEW\.status = 'admitted'[\s\S]*?admission\.source_pathway_instance_id =[\s\S]*?accepted_handoff\.pathway_id[\s\S]*?admission\.source_handoff_id = accepted_handoff\.id/s,
    );
  });

  test('extends admission lineage to one exact OP or ED source without mixed episodes', () => {
    expect(migration).toContain(
      'DROP CONSTRAINT chk_admissions_source_op_shape',
    );
    expect(migration).toContain(
      'ADD CONSTRAINT chk_admissions_source_pathway_shape',
    );
    expect(migration).toMatch(
      /source_appointment_id IS NOT NULL\s+AND from_er_visit_id IS NULL[\s\S]*source_appointment_id IS NULL\s+AND from_er_visit_id IS NOT NULL/s,
    );
    expect(migration).toMatch(
      /source_pathway_instance_id IS NOT NULL\s+AND source_handoff_id IS NOT NULL/s,
    );
  });

  test('keeps reroute lineage closed over one declined predecessor and one successor', () => {
    for (const contract of [
      "transfer.metadata ? 'supersedes_handoff_id'",
      "successor.status <> 'declined'",
      'successor.sender_uid IS DISTINCT FROM transfer.sender_uid',
      'successor.source_resource_id IS DISTINCT FROM',
      'successor.successor_id IS DISTINCT FROM transfer.id::text',
      "metadata ? 'rerouted_to_handoff_id'",
    ]) {
      expect(migration).toContain(contract);
    }
  });
});
