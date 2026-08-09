-- 644_payroll_run_failure_accounting.sql
--
-- Audit F2 (money path): a payroll run recorded status='completed' with
-- total_staff set to the number of payslips it *managed* to write, and stored
-- nothing at all about the staff it failed on. An operator reading the run had
-- no way to tell "everyone was paid" from "eleven people are missing a payslip".
-- The admin-triggered run counted failures in memory and returned them in the
-- HTTP response, but never persisted them; the monthly cron did not count them
-- at all.
--
-- Two changes:
--
--   1. status widens VARCHAR(20) -> VARCHAR(32). The new terminal state
--      'completed_with_errors' is 21 characters and does NOT fit the original
--      column — without this widening the finalizing UPDATE would fail with
--      22001 and strand the run in 'processing'. No CHECK constraint exists on
--      this column (verified against 000_baseline.sql and 079), so widening is
--      the only schema change the new value needs.
--
--   2. failed_staff_count / failed_staff record the failures. The count is
--      operator-facing and is surfaced in the admin payroll runs list;
--      failed_staff holds [{staff_uid, reason}] where reason is an internal
--      error string, so the runs-list endpoint deliberately does not select it.
--
-- Existing rows keep failed_staff_count = 0: they predate failure tracking, and
-- 0 is the honest reading of "this run recorded no failures", not a claim that
-- none occurred. Runs written before this migration remain 'completed'.

ALTER TABLE payroll_runs
  ALTER COLUMN status TYPE VARCHAR(32);

ALTER TABLE payroll_runs
  ADD COLUMN IF NOT EXISTS failed_staff_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failed_staff JSONB;

COMMENT ON COLUMN payroll_runs.failed_staff_count IS
  'Number of staff whose payslip calculation failed during this run. status is completed_with_errors whenever this is > 0.';

COMMENT ON COLUMN payroll_runs.failed_staff IS
  'Per-staff failure detail for this run: [{staff_uid, reason}]. Internal error text — not returned by the payroll runs list endpoint.';
