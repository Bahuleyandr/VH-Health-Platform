-- 642_mar_scheduled_dose_guard.sql
--
-- C-L2: scheduleMedications' duplicate guard is a check-then-insert on plain
-- prisma (TOCTOU) and migration 327's uniq_mar_administered_dose is partial on
-- status = 'administered' only — two concurrent schedule calls for the same
-- dose slot could both pass the pre-check and insert duplicate SCHEDULED rows,
-- double-populating due-lists and inviting double administration attempts.
-- Mirror 327 for scheduled rows: the application pre-check stays the friendly
-- idempotent-return path and this partial unique index is the hard backstop
-- (the service catches 23505 and returns the winner row).
--
-- 'held' rows are deliberately NOT covered: held is only reachable by
-- transitioning an existing scheduled row (holdMedication), never by insert,
-- so duplicate held rows cannot be created by the racing-insert path this
-- index closes.
--
-- PRN / unscheduled rows (scheduled_time IS NULL) are EXEMPT, as in 327.
--
-- Safe-on-existing-data: if duplicate scheduled doses already exist the index
-- creation would fail cryptically, so detect them first and RAISE a clear
-- dedupe instruction instead (327's form).

BEGIN;

DO $$
DECLARE
  dup_groups integer;
BEGIN
  IF to_regclass('public.medication_administrations') IS NULL THEN
    RAISE NOTICE 'migration 642: medication_administrations table missing — skipped';
    RETURN;
  END IF;

  SELECT COUNT(*) INTO dup_groups FROM (
    SELECT 1
      FROM medication_administrations
     WHERE status = 'scheduled' AND scheduled_time IS NOT NULL
     GROUP BY patient_uid, medication_name, scheduled_time
    HAVING COUNT(*) > 1
  ) d;

  IF dup_groups > 0 THEN
    RAISE EXCEPTION
      'migration 642: % duplicate scheduled MAR dose group(s) exist (same patient_uid + medication_name + scheduled_time). Dedupe before applying the guard: keep exactly one scheduled row per dose slot and cancel the rest.',
      dup_groups;
  END IF;

  CREATE UNIQUE INDEX IF NOT EXISTS uniq_mar_scheduled_dose
    ON medication_administrations (patient_uid, medication_name, scheduled_time)
    WHERE status = 'scheduled' AND scheduled_time IS NOT NULL;

  RAISE NOTICE 'migration 642: uniq_mar_scheduled_dose created (MAR duplicate-schedule guard)';
END
$$;

COMMIT;
