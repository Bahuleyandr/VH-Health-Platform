-- 220_appointments_uid_default.sql
--
-- `appointments.uid` is a uuid column that downstream callers (deep-link
-- SMS, FHIR exports, audit references) treat as a stable per-row
-- identifier. The column existed but the legacy `INSERT` paths in
-- `appointmentService.createAppointment` and the `/book` controller
-- never supplied a value, so every row landed with `uid = NULL` and the
-- `appointments_uid_idx` index sat empty.
--
-- Adding a DB-side `DEFAULT gen_random_uuid()` keeps every future row
-- well-formed without touching call sites. Backfill the existing NULL
-- rows in the same migration so callers that look up by uid stop
-- returning empty. Finding:
--   2026-05-09-follow-up-opd-receptionist-appointment-uid-null

ALTER TABLE public.appointments
    ALTER COLUMN uid SET DEFAULT gen_random_uuid();

UPDATE public.appointments
   SET uid = gen_random_uuid()
 WHERE uid IS NULL;

ALTER TABLE public.appointments
    ALTER COLUMN uid SET NOT NULL;
