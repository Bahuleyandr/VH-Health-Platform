-- 207_admission_package_link.sql
--
-- Wave-4B-1 — link admission rows to the selected surgical / day-care package.
--
-- Closes finding:
--   2026-05-10-surgical-day-care-admission-package-not-linked
--
-- Background: surgical day-care admissions select a package from the `packages`
-- master (seeded in migration 195) but the admission row had no structured FK
-- to record the choice. Counter staff entered package info as free-text in
-- `admissions.discharge_summary` notes / `advance_deposits.notes`; downstream
-- billing/OT/discharge/refund flows had to parse that text — error-prone and
-- audit-hostile.
--
-- We add three columns:
--
--   * package_id INT          — FK to packages(id), nullable (most admissions
--                               are not package-bundled). ON DELETE SET NULL
--                               so package master tuning doesn't trash audit
--                               trails.
--   * package_code VARCHAR(40) — denormalised package_code at admission time,
--                                preserved even if the master row is later
--                                renamed. Pattern matches the package_code
--                                snapshot in advance_deposits.notes.
--   * package_estimated_cost_minor BIGINT — estimate snapshot at admit, so
--                                billing reconciliation can flag mid-stay
--                                upgrades vs the originally-agreed amount.
--
-- All columns nullable / default-null so backfill is a no-op.

BEGIN;

ALTER TABLE admissions
  ADD COLUMN IF NOT EXISTS package_id                     INTEGER,
  ADD COLUMN IF NOT EXISTS package_code                   VARCHAR(40),
  ADD COLUMN IF NOT EXISTS package_estimated_cost_minor   BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'admissions_package_id_fkey'
  ) THEN
    ALTER TABLE admissions
      ADD CONSTRAINT admissions_package_id_fkey
      FOREIGN KEY (package_id) REFERENCES packages(id)
      ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_admissions_package_id
  ON admissions(package_id)
  WHERE package_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_admissions_package_code
  ON admissions(package_code)
  WHERE package_code IS NOT NULL;

COMMIT;
