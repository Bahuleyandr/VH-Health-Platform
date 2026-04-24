-- 081_payslip_manual_edit_columns.sql
--
-- Adds the manual-edit audit columns that payrollController.manualEditPayslip
-- and issuePayslips both write/read but which were missing from the DB — they
-- were present in code but never captured in a migration. Writes against these
-- columns currently 500 with "column does not exist" (surfaced by the batch 24
-- schema-drift CI on first run of this batch).
--
-- Columns:
--   manually_edited  BOOLEAN  — true once an HR/Admin has overridden any of
--                                the computed payslip components
--   edit_reason      TEXT     — required justification the editor supplied
--   edited_by        UUID     — users.uid of the editor (not FK-checked so
--                                legacy edits from deleted admins survive)
--   edited_at        TIMESTAMPTZ — NOW() at edit time
--
-- Idempotent: uses IF NOT EXISTS so re-running against a DB that already has
-- the columns is safe. No data backfill needed — defaults cover the existing
-- rows correctly (none have been manually edited).

ALTER TABLE payslips
  ADD COLUMN IF NOT EXISTS manually_edited BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS edit_reason TEXT,
  ADD COLUMN IF NOT EXISTS edited_by UUID,
  ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_payslips_manually_edited
  ON payslips (manually_edited)
  WHERE manually_edited = true;
