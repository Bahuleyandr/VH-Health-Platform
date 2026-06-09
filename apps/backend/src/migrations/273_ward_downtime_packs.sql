-- 273_ward_downtime_packs.sql
--
-- Roadmap A3 (docs/EPIC_LEVEL_ROADMAP.md) — downtime mode, Epic-BCA
-- equivalent. downtime_snapshots was built per-PATIENT (scope
-- 'patient_chart', generated on demand via /api/v1/emr/downtime-snapshot).
-- On-demand is useless during an actual outage: the packs must already
-- exist when the backend goes dark.
--
-- This migration generalizes the table so the scheduled generator can
-- persist WARD-level packs (census + allergies + code status + MAR due
-- list + latest vitals for every occupied bed of a ward, plus a printable
-- self-contained HTML rendering inside the payload):
--   * patient_uid becomes nullable (ward packs are not per-patient)
--   * ward_id + label identify the pack target
--   * a CHECK keeps every row anchored to either a patient or a ward
--   * partial index for the hot lookup: latest pack per ward+scope

BEGIN;

ALTER TABLE downtime_snapshots
  ALTER COLUMN patient_uid DROP NOT NULL;

ALTER TABLE downtime_snapshots
  ADD COLUMN IF NOT EXISTS ward_id integer REFERENCES wards(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS label character varying(160);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'downtime_snapshots_target_check'
  ) THEN
    ALTER TABLE downtime_snapshots
      ADD CONSTRAINT downtime_snapshots_target_check
      CHECK (patient_uid IS NOT NULL OR ward_id IS NOT NULL);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_downtime_snapshots_ward_latest
  ON downtime_snapshots (ward_id, scope, created_at DESC)
  WHERE ward_id IS NOT NULL;

COMMIT;
