-- Restore the five labour, partograph and delivery domains declared in 155
-- but discarded by CREATE TABLE IF NOT EXISTS over the baseline's tables.
-- Seeded PG17 pre-check at 9810080c3 (2026-09-16, one row per table):
-- SELECT count(*) FILTER (WHERE (admission_reason IS NULL OR admission_reason IN
--   ('spontaneous_labour','induction','elective_lscs','pprom','reduced_fm','postdated','other')) IS FALSE),
--   count(*) FILTER (WHERE (status IN ('active','delivered','transferred','discharged_undelivered')) IS FALSE)
-- FROM public.maternity_labor_admissions; -- 0, 0
-- SELECT count(*) FILTER (WHERE (descent_fifths_above_brim BETWEEN 0 AND 5) IS FALSE),
--   count(*) FILTER (WHERE (contractions_intensity IS NULL OR contractions_intensity IN ('weak','moderate','strong')) IS FALSE)
-- FROM public.maternity_partograph_entries; -- 0, 0
-- SELECT count(*) FILTER (WHERE (delivery_mode IN ('nvd','lscs_emergency','lscs_elective',
--   'instrumental_forceps','instrumental_vacuum','breech','destructive','other')) IS FALSE)
-- FROM public.maternity_deliveries; -- 1 (synthetic generic-walker placeholder)
-- Production may hold historical out-of-domain values. Never relabel them.
-- Delivery validation is deferred; the other checks validate only when their
-- own live pre-check is clean. NOT VALID still rejects new invalid writes.
-- Clinical-records and operator review is required for historical violations.
-- Domain membership is not authority for a clinical lifecycle transition.

BEGIN;

DO $$
DECLARE
  invalid_reason BIGINT;
  invalid_status BIGINT;
  invalid_descent BIGINT;
  invalid_intensity BIGINT;
  invalid_delivery BIGINT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.maternity_labor_admissions'::regclass
       AND conname = 'maternity_labor_admissions_admission_reason_check'
  ) THEN
    ALTER TABLE public.maternity_labor_admissions
      ADD CONSTRAINT maternity_labor_admissions_admission_reason_check
      CHECK (admission_reason IS NULL OR admission_reason IN (
        'spontaneous_labour', 'induction', 'elective_lscs', 'pprom',
        'reduced_fm', 'postdated', 'other'
      )) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.maternity_labor_admissions'::regclass
       AND conname = 'maternity_labor_admissions_status_check'
  ) THEN
    ALTER TABLE public.maternity_labor_admissions
      ADD CONSTRAINT maternity_labor_admissions_status_check
      CHECK (status IN ('active', 'delivered', 'transferred', 'discharged_undelivered')) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.maternity_partograph_entries'::regclass
       AND conname = 'maternity_partograph_entries_descent_fifths_above_brim_check'
  ) THEN
    ALTER TABLE public.maternity_partograph_entries
      ADD CONSTRAINT maternity_partograph_entries_descent_fifths_above_brim_check
      CHECK (descent_fifths_above_brim BETWEEN 0 AND 5) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.maternity_partograph_entries'::regclass
       AND conname = 'maternity_partograph_entries_contractions_intensity_check'
  ) THEN
    ALTER TABLE public.maternity_partograph_entries
      ADD CONSTRAINT maternity_partograph_entries_contractions_intensity_check
      CHECK (contractions_intensity IS NULL OR contractions_intensity IN ('weak', 'moderate', 'strong')) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.maternity_deliveries'::regclass
       AND conname = 'maternity_deliveries_delivery_mode_check'
  ) THEN
    ALTER TABLE public.maternity_deliveries
      ADD CONSTRAINT maternity_deliveries_delivery_mode_check
      CHECK (delivery_mode IN (
        'nvd', 'lscs_emergency', 'lscs_elective', 'instrumental_forceps',
        'instrumental_vacuum', 'breech', 'destructive', 'other'
      )) NOT VALID;
  END IF;

  SELECT
    count(*) FILTER (WHERE (admission_reason IS NULL OR admission_reason IN (
      'spontaneous_labour', 'induction', 'elective_lscs', 'pprom',
      'reduced_fm', 'postdated', 'other'
    )) IS FALSE),
    count(*) FILTER (WHERE (status IN ('active', 'delivered', 'transferred', 'discharged_undelivered')) IS FALSE)
    INTO invalid_reason, invalid_status FROM public.maternity_labor_admissions;
  SELECT
    count(*) FILTER (WHERE (descent_fifths_above_brim BETWEEN 0 AND 5) IS FALSE),
    count(*) FILTER (WHERE (contractions_intensity IS NULL OR contractions_intensity IN ('weak', 'moderate', 'strong')) IS FALSE)
    INTO invalid_descent, invalid_intensity FROM public.maternity_partograph_entries;
  SELECT count(*) FILTER (WHERE (delivery_mode IN (
    'nvd', 'lscs_emergency', 'lscs_elective', 'instrumental_forceps',
    'instrumental_vacuum', 'breech', 'destructive', 'other'
  )) IS FALSE) INTO invalid_delivery FROM public.maternity_deliveries;

  IF invalid_reason = 0 THEN
    ALTER TABLE public.maternity_labor_admissions VALIDATE CONSTRAINT maternity_labor_admissions_admission_reason_check;
  END IF;
  IF invalid_status = 0 THEN
    ALTER TABLE public.maternity_labor_admissions VALIDATE CONSTRAINT maternity_labor_admissions_status_check;
  END IF;
  IF invalid_descent = 0 THEN
    ALTER TABLE public.maternity_partograph_entries VALIDATE CONSTRAINT maternity_partograph_entries_descent_fifths_above_brim_check;
  END IF;
  IF invalid_intensity = 0 THEN
    ALTER TABLE public.maternity_partograph_entries VALIDATE CONSTRAINT maternity_partograph_entries_contractions_intensity_check;
  END IF;

  IF invalid_reason + invalid_status + invalid_descent + invalid_intensity > 0 THEN
    RAISE WARNING 'Migration 801: historical domain violations (admission_reason=%, status=%, descent=%, contractions_intensity=%). Affected new CHECKs remain NOT VALID; no records changed. Clinical-records and operator review required.',
      invalid_reason, invalid_status, invalid_descent, invalid_intensity;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.maternity_deliveries'::regclass
       AND conname = 'maternity_deliveries_delivery_mode_check' AND NOT convalidated
  ) THEN
    RAISE WARNING 'Migration 801: delivery_mode CHECK remains NOT VALID (historical violations=%); new writes are enforced, no records changed. Validation requires a clean pre-check and clinical-records/operator review.', invalid_delivery;
  END IF;
END
$$;

COMMIT;
