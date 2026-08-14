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
    // 668 is @no-transaction (see the deploy-safety contract in
    // audit3MigrationSafety.test.js), so every statement is written to be a
    // no-op on replay — hence IF NOT EXISTS on the table creates.
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.scheduled_job_runs/i);
    expect(sql).toMatch(/lock_key VARCHAR\(160\) NOT NULL/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.scheduled_job_tenant_runs/i);
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
    const anchorAt = sql.indexOf(
      'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ux_users_tenant_id_id',
    );
    const backfillAt = sql.indexOf('UPDATE public.scheduled_notifications AS scheduled');
    const addFkAt = sql.indexOf('ADD CONSTRAINT scheduled_notifications_tenant_user_fk');
    const validateAt = sql.indexOf('VALIDATE CONSTRAINT scheduled_notifications_tenant_user_fk');
    const dropLegacyAt = sql.indexOf(
      'DROP CONSTRAINT IF EXISTS scheduled_notifications_user_fk',
    );

    // The load-bearing invariant is unchanged: the tenant drift repair must
    // land BEFORE the constraint is validated, or VALIDATE fails on drifted
    // rows.
    expect(backfillAt).toBeGreaterThan(0);
    expect(validateAt).toBeGreaterThan(backfillAt);

    // The FK is now added NOT VALID *before* the repair rather than after it.
    // NOT VALID performs no scan, so it cannot fail on the drifted rows it
    // precedes, and from the moment it commits every NEW write is
    // tenant-checked. That matters here specifically because @no-transaction
    // makes the repair commit in chunks over time, so without this ordering the
    // application could keep writing fresh drift for the whole repair window.
    // Same rationale as migration 598.
    expect(anchorAt).toBeGreaterThan(0);
    expect(addFkAt).toBeGreaterThan(anchorAt);
    expect(backfillAt).toBeGreaterThan(addFkAt);

    // The superseded single-column FK is dropped last, so a failure anywhere
    // above leaves the table still guarded by the original constraint.
    expect(dropLegacyAt).toBeGreaterThan(validateAt);

    expect(sql).toMatch(/FOREIGN KEY \(tenant_id, user_id\)[\s\S]*REFERENCES public\.users \(tenant_id, id\)/i);
    expect(sql).toMatch(/ADD CONSTRAINT scheduled_notifications_tenant_user_fk[\s\S]*NOT VALID/i);
  });

  it('bounds the scheduled-notification tenant repair instead of one unbounded UPDATE', () => {
    // @statement_timeout: 0 removes the backstop a single large UPDATE would
    // otherwise have had, so the repair chunks itself and commits per batch.
    expect(sql).toMatch(/LIMIT batch_size/);
    expect(sql).toMatch(/GET DIAGNOSTICS moved = ROW_COUNT/);
    expect(sql).toMatch(/EXIT WHEN moved = 0/);
    expect(sql).toMatch(/COMMIT;/);
    // The iteration cap is a safety stop, not the termination condition.
    expect(sql).toMatch(/did not converge after % batches/);
  });
});
