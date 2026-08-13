import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.resolve(
  __dirname,
  '../../migrations/668_scheduler_truth_and_notification_tenant_integrity.sql',
);

describe('migration 668 scheduler and notification integrity', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');

  it('creates durable aggregate and tenant outcome receipts with explicit-context RLS', () => {
    expect(sql).toMatch(/CREATE TABLE public\.scheduled_job_runs/i);
    expect(sql).toMatch(/lock_key VARCHAR\(160\) NOT NULL/i);
    expect(sql).toMatch(/CREATE TABLE public\.scheduled_job_tenant_runs/i);
    expect(sql).toMatch(/FOREIGN KEY \(run_id\)[\s\S]*REFERENCES public\.scheduled_job_runs\(id\)/i);
    expect(sql).toMatch(/ALTER TABLE public\.scheduled_job_tenant_runs FORCE ROW LEVEL SECURITY/i);
    expect(sql).toMatch(/CREATE POLICY tenant_isolation/i);
    expect(sql).toMatch(/CREATE POLICY scheduled_job_tenant_runs_explicit_context/i);
    expect(sql).toMatch(/current_setting\('app\.current_tenant_id', true\) <> 'bypass'/i);
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON public\.scheduled_job_runs/i);
    expect(sql).toMatch(/BEFORE INSERT OR UPDATE OR DELETE ON public\.scheduled_job_tenant_runs/i);
    expect(sql).toMatch(/scheduled job run evidence is append-only/i);
    expect(sql).toMatch(/aggregate_status = 'evidence_failure'/i);
    expect(sql).toMatch(/aggregate_status = 'reconciliation_failed'/i);
    expect(sql).toMatch(/aggregate_status = 'abandoned'/i);
    expect(sql).toMatch(/idx_scheduled_job_runs_running_started/i);
    expect(sql).toMatch(/WHERE aggregate_status = 'running'/i);
    expect(sql).toMatch(/status = 'indeterminate'/i);
    expect(sql).toMatch(/scheduled_job_tenant_run_parent_running/i);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.scheduled_job_run_finalization_guard\(\)/i);
    expect(sql).toMatch(/scheduled_job_run_child_truth_guard/i);
    expect(sql).toMatch(/FROM public\.scheduled_job_tenant_runs[\s\S]*WHERE run_id = NEW\.id/i);
    expect(sql).toMatch(/owner must be superuser or BYPASSRLS/i);
    expect(sql).toMatch(/role\.rolsuper OR role\.rolbypassrls/i);
    expect(sql).toMatch(/FOR UPDATE/i);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.prune_scheduled_job_run_evidence\(\)/i);
    expect(sql).toMatch(/finished_at < clock_timestamp\(\) - INTERVAL '400 days'/i);
    expect(sql).toMatch(/LIMIT 1000[\s\S]*FOR UPDATE SKIP LOCKED/i);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.prune_scheduled_job_run_evidence\(\) TO %I/i);
    expect(sql).toMatch(/GRANT SELECT, INSERT, UPDATE ON public\.scheduled_job_runs TO %I/i);
    expect(sql).toMatch(/GRANT USAGE, SELECT ON SEQUENCE public\.scheduled_job_runs_id_seq TO %I/i);
    expect(sql).toMatch(/REVOKE DELETE, TRUNCATE ON public\.scheduled_job_tenant_runs FROM %I/i);
  });

  it('backfills before validating the scheduled-notification composite tenant owner', () => {
    const backfillAt = sql.indexOf('UPDATE public.scheduled_notifications AS scheduled');
    const addFkAt = sql.indexOf('ADD CONSTRAINT scheduled_notifications_tenant_user_fk');
    const validateAt = sql.indexOf('VALIDATE CONSTRAINT scheduled_notifications_tenant_user_fk');

    expect(backfillAt).toBeGreaterThan(0);
    expect(addFkAt).toBeGreaterThan(backfillAt);
    expect(validateAt).toBeGreaterThan(addFkAt);
    expect(sql).toMatch(/ADD CONSTRAINT ux_users_tenant_id_id UNIQUE \(tenant_id, id\)/i);
    expect(sql).toMatch(/FOREIGN KEY \(tenant_id, user_id\)[\s\S]*REFERENCES public\.users \(tenant_id, id\)/i);
    expect(sql).toMatch(/ADD CONSTRAINT scheduled_notifications_tenant_user_fk[\s\S]*NOT VALID/i);
  });
});
