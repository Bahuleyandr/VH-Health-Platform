-- Migration 322: appointments double-booking guard (partial unique index).
--
-- Audit 2026-06-18 §3 (Data layer, HIGH): two ACTIVE appointments could be
-- created in the same doctor + date + time slot. The only guard was the
-- app-layer conflict query in appointmentService.checkConflict /
-- createAppointment (and the workflow controller reschedule path):
--   SELECT ... WHERE doctor_id = $ AND appointment_date::date = $::date
--             AND appointment_time = $ AND tenant_id = $::uuid
--             AND status NOT IN ('CANCELLED','NO_SHOW','RESCHEDULED')
-- That check (a) RACES under concurrency — two simultaneous bookings each see
-- no conflict, both insert — and (b) is bypassed by any code path that inserts
-- an appointment row directly. In a money + clinical system a double-booked
-- doctor slot is a scheduling-integrity hazard with no durable backstop.
--
-- This adds a partial UNIQUE INDEX that makes a real collision impossible at
-- the DB level, regardless of how the row is inserted. The index key + predicate
-- mirror the app's own conflict semantics EXACTLY so the constraint never
-- rejects a booking the app would have allowed:
--
--   key   = (tenant_id, doctor_id, appointment_date, appointment_time)
--   where = status NOT IN ('CANCELLED','NO_SHOW','RESCHEDULED')   -- "active"/slot-occupying
--           AND doctor_id IS NOT NULL                              -- department-only bookings are exempt
--           AND appointment_time IS NOT NULL
--           AND btrim(appointment_time) <> ''                      -- blank time = no real slot
--           AND lower(btrim(appointment_time)) <> 'walk-in'        -- walk-ins are legitimately multi-per-slot
--
-- DESIGN NOTES (verified against the live QA schema + service code before
-- writing this migration):
--
--  * STATUS CASING. The canonical APPOINTMENT_CONFIG.STATUSES and every
--    conflict query in the codebase use UPPERCASE status strings
--    ('CANCELLED','NO_SHOW','RESCHEDULED',...). The validators uppercase
--    incoming status, and createAppointment writes 'SCHEDULED'. A
--    RESCHEDULED row has vacated its old slot (the reschedule writes a new
--    row / moves the time), so it is treated as non-occupying — matching
--    appointmentWorkflowController + appointmentService.checkConflict. COMPLETED
--    is NOT excluded (a completed visit still "owns" that historical slot), and
--    the app's own conflict query likewise does not exclude COMPLETED.
--
--  * TENANT SCOPE. The conflict query is tenant-scoped, and appointments has a
--    NOT NULL tenant_id, so tenant_id leads the index. Two different tenants may
--    each book the same doctor_id/date/time (this is the multi-tenant-correct
--    behaviour and matches the app filter `tenant_id = $`).
--
--  * WALK-INS. appointment_time is free text. Walk-in registration stores the
--    literal 'Walk-in' and is inherently many-per-doctor-per-day (the live QA
--    data has dozens of active 'Walk-in' rows for the same doctor+date). Walk-ins
--    are therefore EXEMPT — only real, scheduled clock-time slots are unique.
--    The exclusion is case/whitespace-insensitive (lower(btrim(...))) so 'walk-in',
--    'Walk-In', ' Walk-in ' are all exempt.
--
--  * IMMUTABILITY. A partial-index predicate may only use IMMUTABLE functions.
--    lower(text), btrim(text), and the `<>`/`IN` operators on text are all
--    IMMUTABLE, so the predicate is index-safe. appointment_date is already a
--    `date` column (no cast needed) and appointment_time is the raw text value
--    the app compares with `=`, so the index matches the app's equality exactly.
--
--  * NO CONCURRENTLY. The migration runner wraps every file in one transaction
--    (SET LOCAL statement_timeout); CREATE INDEX CONCURRENTLY cannot run inside a
--    transaction block. A plain CREATE UNIQUE INDEX validates against existing
--    rows synchronously.
--
--  * SAFE-ON-EXISTING-DATA. A plain CREATE UNIQUE INDEX that hits a duplicate
--    fails with a generic "could not create unique index" that does not name the
--    colliding rows. The DO-block below pre-checks for any existing active-slot
--    collision (under the SAME predicate the index uses) and RAISEs an actionable
--    error naming the doctor/date/slot first, so an operator can dedupe before
--    applying. Verified clean on the QA cluster before writing this migration
--    (zero real-slot collisions once walk-ins + vacated statuses are excluded).
--
--  * TOKEN NUMBER. appointments.token_number already has a non-unique index
--    (idx_appointments_token_number) and token generation is atomic in code;
--    there is no per-(tenant,date) uniqueness contract on token_number to enforce
--    here, so this migration deliberately does NOT add a token uniqueness index
--    (adding one would risk rejecting the existing token scheme). Out of scope.

BEGIN;

-- Pre-flight: refuse to apply if existing ACTIVE rows already collide under the
-- exact predicate the unique index will use, so the index build never fails with
-- an unactionable error.
DO $$
DECLARE
  clash RECORD;
BEGIN
  SELECT tenant_id, doctor_id, appointment_date, appointment_time, count(*) AS n
    INTO clash
    FROM appointments
   WHERE doctor_id IS NOT NULL
     AND appointment_time IS NOT NULL
     AND btrim(appointment_time) <> ''
     AND lower(btrim(appointment_time)) <> 'walk-in'
     AND status NOT IN ('CANCELLED', 'NO_SHOW', 'RESCHEDULED')
   GROUP BY tenant_id, doctor_id, appointment_date, appointment_time
  HAVING count(*) > 1
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'appointments already has % active rows in the same slot (tenant %, doctor %, % at %); dedupe appointments before applying migration 322',
      clash.n, clash.tenant_id, clash.doctor_id, clash.appointment_date, clash.appointment_time;
  END IF;
END $$;

-- Durable double-booking backstop: no two ACTIVE appointments may share a
-- (tenant, doctor, date, real clock-time slot). Mirrors the app conflict query.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_appointments_active_doctor_slot
  ON appointments (tenant_id, doctor_id, appointment_date, appointment_time)
  WHERE (
    doctor_id IS NOT NULL
    AND appointment_time IS NOT NULL
    AND btrim(appointment_time) <> ''
    AND lower(btrim(appointment_time)) <> 'walk-in'
    AND status NOT IN ('CANCELLED', 'NO_SHOW', 'RESCHEDULED')
  );

COMMIT;
