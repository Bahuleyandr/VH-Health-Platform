import { readFileSync, readdirSync } from 'node:fs';

const migrationUrl = new URL(
  '../../migrations/629_clinical_continuity_held_webhook_disposition.sql',
  import.meta.url,
);
const migrationSql = readFileSync(migrationUrl, 'utf8');

describe('migration 629 C5.2 held-webhook disposition', () => {
  test('occupies the fresh slot after migration 628 while leaving 626 vacant', () => {
    const migrationNames = readdirSync(new URL('../../migrations/', import.meta.url)).sort();
    const migration629 = migrationNames.filter(name => name.startsWith('629_'));
    expect(migration629).toEqual(['629_clinical_continuity_held_webhook_disposition.sql']);
    expect(migrationNames[migrationNames.indexOf(migration629[0]) - 1])
      .toBe('628_external_recovery_operability.sql');
    expect(migrationNames.filter(name => name.startsWith('626_'))).toEqual([]);
    expect(migrationSql).toContain('629_clinical_continuity_held_webhook_disposition.sql');
  });

  test('binds the non-inbox late outbox branch to exact paper fact and effect evidence', () => {
    expect(migrationSql).toContain('chk_event_outbox_recovery_contract');
    expect(migrationSql).toContain('chk_cc_paper_outbox_binding');
    expect(migrationSql).toContain('clinical_continuity.paper_fact.recorded');
    expect(migrationSql).toContain('clinical_continuity_retrospective_fact');
    expect(migrationSql).toContain('clinical_continuity_replay_effect_evidence');
    expect(migrationSql).toContain('retrospective_event_outbox_id = NEW.id');
    expect(migrationSql).toContain("receipt.source_kind = 'paper_back_entry'");
    expect(migrationSql).toContain('DEFERRABLE INITIALLY DEFERRED');
  });

  test('admits a source-held delivery but rejects authority drift at the database boundary', () => {
    expect(migrationSql).toContain('chk_webhook_deliveries_i18_recovery_shape');
    expect(migrationSql).toContain('chk_webhook_i18_source_disposition_binding');
    expect(migrationSql).toContain("send_authority = 'held_owner_reconciliation'");
    expect(migrationSql).toContain("effect_disposition = 'late_pending_only'");
    expect(migrationSql).toContain('next_retry_at IS NULL');
    expect(migrationSql).toContain('attempt_number = 0');
    expect(migrationSql).toContain('source_disposition IS DISTINCT FROM');
    expect(migrationSql).toContain('cannot create or regain live webhook authority');
  });

  test('keeps FORCE RLS and denies held evidence to unset, bypass, or wrong-tenant context', () => {
    expect(migrationSql).toContain('ALTER TABLE public.event_outbox FORCE ROW LEVEL SECURITY');
    expect(migrationSql).toContain('ALTER TABLE public.webhook_deliveries FORCE ROW LEVEL SECURITY');
    expect(migrationSql).toContain('cc_paper_outbox_insert_explicit_context');
    expect(migrationSql).toContain('webhook_i18_recovery_explicit_context');
    expect(migrationSql.match(/current_setting\('app\.current_tenant_id', true\) <> 'bypass'/g)).toHaveLength(3);
    expect(migrationSql).toContain('REVOKE ALL ON FUNCTION public.assert_cc_paper_outbox_binding() FROM PUBLIC');
    expect(migrationSql).toContain('REVOKE ALL ON FUNCTION public.assert_webhook_i18_source_disposition() FROM PUBLIC');
  });
});
