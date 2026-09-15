-- Restore the three pregnancy domains declared by 155 but absent after the
-- baseline's CREATE TABLE made that migration's IF NOT EXISTS a no-op.
-- Fresh PG17 catalog at bd519ae1: only maternity_pregnancies_pkey exists.
-- Seeded pre-check (2026-09-08, one row; each result was zero):
-- SELECT
--   count(*) FILTER (WHERE (edd_method IS NULL OR edd_method IN ('lmp', 'usg', 'mixed')) IS FALSE),
--   count(*) FILTER (WHERE (booking_status IN ('booked', 'unbooked', 'transferred_in', 'transferred_out')) IS FALSE),
--   count(*) FILTER (WHERE (status IN ('ongoing', 'delivered', 'aborted', 'still_birth', 'transferred')) IS FALSE)
-- FROM public.maternity_pregnancies;
-- Production may contain historical values outside these domains. Do not
-- relabel clinical records: new CHECKs remain NOT VALID if any domain fails
-- the production pre-check, pending clinical-records and operator review.
-- Domain membership does not authorize a clinical lifecycle transition.

BEGIN;

DO $$
DECLARE
  invalid_edd BIGINT;
  invalid_booking BIGINT;
  invalid_status BIGINT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.maternity_pregnancies'::regclass
       AND conname = 'maternity_pregnancies_edd_method_check'
  ) THEN
    ALTER TABLE public.maternity_pregnancies
      ADD CONSTRAINT maternity_pregnancies_edd_method_check
      CHECK (edd_method IS NULL OR edd_method IN ('lmp', 'usg', 'mixed')) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.maternity_pregnancies'::regclass
       AND conname = 'maternity_pregnancies_booking_status_check'
  ) THEN
    ALTER TABLE public.maternity_pregnancies
      ADD CONSTRAINT maternity_pregnancies_booking_status_check
      CHECK (booking_status IN ('booked', 'unbooked', 'transferred_in', 'transferred_out')) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.maternity_pregnancies'::regclass
       AND conname = 'maternity_pregnancies_status_check'
  ) THEN
    ALTER TABLE public.maternity_pregnancies
      ADD CONSTRAINT maternity_pregnancies_status_check
      CHECK (status IN ('ongoing', 'delivered', 'aborted', 'still_birth', 'transferred')) NOT VALID;
  END IF;

  SELECT
    count(*) FILTER (WHERE (edd_method IS NULL OR edd_method IN ('lmp', 'usg', 'mixed')) IS FALSE),
    count(*) FILTER (WHERE (booking_status IN ('booked', 'unbooked', 'transferred_in', 'transferred_out')) IS FALSE),
    count(*) FILTER (WHERE (status IN ('ongoing', 'delivered', 'aborted', 'still_birth', 'transferred')) IS FALSE)
    INTO invalid_edd, invalid_booking, invalid_status
    FROM public.maternity_pregnancies;

  IF invalid_edd = 0 AND invalid_booking = 0 AND invalid_status = 0 THEN
    ALTER TABLE public.maternity_pregnancies
      VALIDATE CONSTRAINT maternity_pregnancies_edd_method_check;
    ALTER TABLE public.maternity_pregnancies
      VALIDATE CONSTRAINT maternity_pregnancies_booking_status_check;
    ALTER TABLE public.maternity_pregnancies
      VALIDATE CONSTRAINT maternity_pregnancies_status_check;
  ELSE
    RAISE WARNING 'Migration 800: historical pregnancy domain violations (edd_method=%, booking_status=%, status=%). New CHECKs remain NOT VALID; no records changed. Clinical-records and operator review required.',
      invalid_edd, invalid_booking, invalid_status;
  END IF;
END
$$;

COMMIT;
