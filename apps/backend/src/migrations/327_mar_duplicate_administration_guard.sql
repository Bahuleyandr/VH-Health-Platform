-- 327_mar_duplicate_administration_guard.sql
--
-- Audit 2026-06-18 §3 (Clinical core & safety): the MAR cross-row duplicate
-- guard in recordAdministration is a check-then-act SELECT with no lock (TOCTOU).
-- Two concurrent administrations of sibling rows for the same patient +
-- medication + scheduled slot can both pass the check and double-chart the dose
-- (findings 2026-05-09-inpatient-admission-nurse-mar-no-duplicate-guard,
-- 2026-05-20-emergency-walk-in-nurse). Add a DB-level partial unique index so a
-- second 'administered' row for the same (patient_uid, medication_name,
-- scheduled_time) is impossible regardless of concurrency — the application
-- guard becomes a friendly pre-check and this is the hard backstop.
--
-- PRN / unscheduled rows (scheduled_time IS NULL) are EXEMPT: they are
-- legitimately administered more than once.
--
-- Safe-on-existing-data: if duplicate administered doses already exist the index
-- creation would fail cryptically, so detect them first and RAISE a clear
-- dedupe instruction instead.

BEGIN;

DO $$
DECLARE
  dup_groups integer;
BEGIN
  IF to_regclass('public.medication_administrations') IS NULL THEN
    RAISE NOTICE 'migration 327: medication_administrations table missing — skipped';
    RETURN;
  END IF;

  SELECT COUNT(*) INTO dup_groups FROM (
    SELECT 1
      FROM medication_administrations
     WHERE status = 'administered' AND scheduled_time IS NOT NULL
     GROUP BY patient_uid, medication_name, scheduled_time
    HAVING COUNT(*) > 1
  ) d;

  IF dup_groups > 0 THEN
    RAISE EXCEPTION
      'migration 327: % duplicate administered MAR dose group(s) exist (same patient_uid + medication_name + scheduled_time). Dedupe before applying the guard: keep exactly one administered row per scheduled dose and void/correct the rest.',
      dup_groups;
  END IF;

  CREATE UNIQUE INDEX IF NOT EXISTS uniq_mar_administered_dose
    ON medication_administrations (patient_uid, medication_name, scheduled_time)
    WHERE status = 'administered' AND scheduled_time IS NOT NULL;

  RAISE NOTICE 'migration 327: uniq_mar_administered_dose created (MAR double-charting guard)';
END
$$;

COMMIT;
