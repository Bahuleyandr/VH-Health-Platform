import { readFileSync } from 'node:fs';

describe('migration 594 referral closed loop', () => {
  const source = readFileSync(
    new URL('../../migrations/594_referral_closed_loop.sql', import.meta.url),
    'utf8',
  );

  test('pins tenant-safe ownership, append-only evidence, and exact task/SLA binding', () => {
    expect(source).toContain('CREATE TABLE referral_transition_events');
    expect(source).toContain('CREATE TABLE referral_responses');
    expect(source).toContain('CREATE TABLE referral_patient_notifications');
    expect(source).toContain('UNIQUE (tenant_id, referral_id, sequence_number)');
    expect(source).toContain('FOREIGN KEY (tenant_id, current_owner_uid)');
    expect(source).toContain('FOREIGN KEY (tenant_id, notification_outbox_id)');
    expect(source).toContain(
      "'critical_result_ack', 'cold_chain_excursion_ack', 'referral_response'",
    );
    expect(source).toContain('care_pathway_assert_actionable_task_owner(uuid,integer)');
    expect(source).toContain('chk_tasks_referral_response_resource');
    expect(source).not.toContain('REPLACE(function_definition, prior_rule');
    expect(source).toContain('ENABLE ROW LEVEL SECURITY');
    expect(source).toContain('FORCE ROW LEVEL SECURITY');
    expect(source).toContain('referral_evidence_block_mutation()');
    expect(source).not.toMatch(/INSERT INTO referral_patient_notifications/i);
  });
});
