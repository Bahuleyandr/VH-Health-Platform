-- 188_radiology_workflow_polish.sql
--
-- E-8 — radiology workflow polish.
--
-- Adds the operational fields the radiology tech + radiologist need
-- but the schema didn't carry:
--
--   acquired_at / acquired_by / acquired_by_name / tech_uid / tech_name
--     Tech identity collapses into the radiologist field today.
--     Tech and radiologist are distinct roles — the tech acquires
--     images, the radiologist reads them. Without separate columns
--     the workflow can't credit/route-back to the right person.
--
--   report_signed_off_at / report_signed_off_by
--     Signoff lock — once the radiologist signs off, PUT /report
--     refuses further overwrites. Compliance + medico-legal record.
--
-- Plus adds 'acquired' / 'in_progress' to the status lifecycle.
--
-- Closes:
--   2026-05-08-dynamic-acute-abdomen-radiology-tech-no-acquisition-state-no-tech-attribution
--   2026-05-08-dynamic-acute-abdomen-radiology-tech-report-overwrite-after-signoff

BEGIN;

ALTER TABLE radiology_orders
  ADD COLUMN IF NOT EXISTS acquired_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS acquired_by         UUID,
  ADD COLUMN IF NOT EXISTS acquired_by_name    VARCHAR(160),
  ADD COLUMN IF NOT EXISTS tech_uid            UUID,
  ADD COLUMN IF NOT EXISTS tech_name           VARCHAR(160),
  ADD COLUMN IF NOT EXISTS report_signed_off_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS report_signed_off_by UUID;

CREATE INDEX IF NOT EXISTS idx_radiology_orders_pending_acquisition
  ON radiology_orders(status, created_at)
  WHERE status IN ('ordered', 'acquired', 'in_progress');

CREATE INDEX IF NOT EXISTS idx_radiology_orders_signoff_pending
  ON radiology_orders(report_completed_at)
  WHERE report_completed_at IS NOT NULL AND report_signed_off_at IS NULL;

COMMIT;
