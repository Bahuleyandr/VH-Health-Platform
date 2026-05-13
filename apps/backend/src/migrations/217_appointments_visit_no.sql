-- 217_appointments_visit_no.sql
--
-- Persist the human-readable visit number on appointments. The walk-in
-- handler already composes `${PREFIX}-YYYYMMDD-NNN` and returns it to the
-- caller, but until now the value was only in the response body — searching
-- by the printed slip's visit_no (which the patient hands to the next
-- counter) returned zero rows. Finding:
--   2026-05-10-inpatient-admission-receptionist-visit-no-not-persisted
--
-- Column is nullable + additive; existing rows backfill to NULL and the
-- walk-in flow starts writing the value going forward. Unique partial
-- index on the non-null values protects against accidental duplicates
-- without blocking pre-217 rows.

ALTER TABLE public.appointments
    ADD COLUMN IF NOT EXISTS visit_no varchar(50);

CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_visit_no_unique
    ON public.appointments (visit_no)
    WHERE visit_no IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_appointments_visit_no
    ON public.appointments (visit_no);
