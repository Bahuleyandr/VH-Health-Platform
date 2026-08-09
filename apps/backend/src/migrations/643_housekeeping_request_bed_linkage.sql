-- Migration 643: housekeeping_requests — structured bed + patient linkage.
--
-- Bed-cleaning tickets were linked to their bed only through free text: the
-- dispatcher appended "bed_id=N." to `description` and every consumer (the
-- dedupe probe, the missing-dispatch sweep, the dirty-bed flip on assignment,
-- and markBedReady's proof-of-cleaning gate) re-parsed it with a regex. The
-- description is user-suppliable on the manual request endpoints, so a typed
-- "bed_id=N." could suppress a real re-dispatch or serve as cleaning proof for
-- a bed the ticket never covered (findings B-L4 / B-M2, Phase-3 review).
--
-- Adds:
--   * bed_id       — real FK to beds. ON DELETE SET NULL: deleting a bed must
--                    not delete its cleaning evidence trail.
--   * patient_uid  — the patient whose stay triggered the turnover (nullable;
--                    manual zone/location requests have none). Lets the
--                    canonical emit layer attribute bed-cleaning events to the
--                    patient timeline (docs/CANONICAL_CLINICAL_TIMELINE.md).
--                    Plain uuid, no FK — mirrors beds.patient_uid.
--
-- Backfill: parse the legacy "bed_id=N." marker once, only for bed_cleaning
-- dispatch rows, and only where the referenced bed exists in the SAME tenant —
-- a spoofed marker on a manual request (request_type != 'bed_cleaning') or a
-- cross-tenant id stays NULL. patient_uid is not backfillable.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '180s';

ALTER TABLE housekeeping_requests
  ADD COLUMN IF NOT EXISTS bed_id integer,
  ADD COLUMN IF NOT EXISTS patient_uid uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_housekeeping_requests_bed'
  ) THEN
    ALTER TABLE housekeeping_requests
      ADD CONSTRAINT fk_housekeeping_requests_bed
      FOREIGN KEY (bed_id) REFERENCES beds(id) ON DELETE SET NULL;
  END IF;
END $$;

UPDATE housekeeping_requests hr
   SET bed_id = b.id
  FROM beds b
 WHERE hr.bed_id IS NULL
   AND hr.request_type = 'bed_cleaning'
   AND hr.description ~ 'bed_id=[0-9]+\.'
   AND b.id = (substring(hr.description FROM 'bed_id=([0-9]+)\.'))::int
   AND b.tenant_id = hr.tenant_id;

-- Serves the dedupe probe / sweep NOT EXISTS ("active ticket for this bed in
-- this tenant") and the FK's delete-side lookup.
CREATE INDEX IF NOT EXISTS idx_housekeeping_requests_bed
  ON housekeeping_requests (tenant_id, bed_id)
  WHERE bed_id IS NOT NULL;

COMMIT;
