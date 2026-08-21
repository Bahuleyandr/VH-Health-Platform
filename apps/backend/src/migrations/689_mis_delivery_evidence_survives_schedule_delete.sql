-- 689_mis_delivery_evidence_survives_schedule_delete.sql
--
-- Adversarial-review fix (PR #875, fix group 5): `mis_report_deliveries` is
-- the only durable record of which EXTERNAL email addresses received hospital
-- operational/revenue data, yet migration 679 gave its schedule_id FK
-- ON DELETE CASCADE — deleting a schedule (a routine admin action exposed by
-- deleteMisReportSchedule) silently erased the entire delivery evidence trail
-- for that schedule. Evidence must survive its parent (migration 686
-- audit-survival idiom: soft references + snapshot columns, never
-- cascade-erasure).
--
-- New shape:
--   1. schedule_id becomes nullable ON DELETE SET NULL — delivery rows outlive
--      the schedule row.
--   2. schedule_name snapshot column, stamped at insert time by the service
--      and backfilled here for existing rows, keeps orphaned evidence legible
--      (the row already snapshots recipient_email, report_keys,
--      occurrence_key, outcome, and tenant).
--
-- The tenant_id CASCADE is left as-is: tenant deletion is the platform-wide
-- offboarding path, not a routine admin action.

BEGIN;

ALTER TABLE mis_report_deliveries
  ALTER COLUMN schedule_id DROP NOT NULL;

ALTER TABLE mis_report_deliveries
  DROP CONSTRAINT mis_report_deliveries_schedule_id_fkey,
  ADD CONSTRAINT mis_report_deliveries_schedule_id_fkey
    FOREIGN KEY (schedule_id)
    REFERENCES mis_report_schedules(id) ON DELETE SET NULL;

ALTER TABLE mis_report_deliveries
  ADD COLUMN IF NOT EXISTS schedule_name VARCHAR(160);

UPDATE mis_report_deliveries d
   SET schedule_name = s.name
  FROM mis_report_schedules s
 WHERE s.id = d.schedule_id
   AND d.schedule_name IS NULL;

COMMENT ON COLUMN mis_report_deliveries.schedule_id IS
  'Owning schedule while it exists; NULL after the schedule is deleted — the delivery row is append-only evidence and survives (migration 689).';
COMMENT ON COLUMN mis_report_deliveries.schedule_name IS
  'Insert-time snapshot of the schedule name, so delivery evidence stays legible after the schedule row is gone (migration 689).';

COMMIT;
