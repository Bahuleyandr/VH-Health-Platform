-- Migration 319: OR double-booking guard (gist exclusion constraint).
--
-- Audit 2026-06-18 §C-2 / §3 (Theatre): OR double-booking was prevented
-- only by orBoardService.scheduleWithConflictCheck's app-layer overlap
-- query, which (a) races under concurrency (two simultaneous bookings each
-- see no conflict, both insert) and (b) is fully bypassed by the `force=true`
-- flag — so an operator override could create a TRUE overlap, two surgical
-- cases assigned to the same room+window. Patient-safety + theatre-logistics
-- hazard with no durable backstop.
--
-- This adds a durable DB-level EXCLUDE constraint so two non-cancelled,
-- non-completed cases in the SAME (tenant_id, ot_room) cannot hold
-- overlapping time windows, regardless of how the row is inserted (service,
-- raw SQL, force-override, or a future code path). The app `force` flag may
-- still skip the friendly pre-check, but the constraint makes a real overlap
-- impossible — force degrades to "attempt anyway", and a genuine clash now
-- surfaces as 23P01 (exclusion_violation) the service maps to 409, instead
-- of silently double-booking the room.
--
-- WINDOW MODEL: ot_schedules stores scheduled_date (date) + scheduled_time
-- (time, nullable) + estimated_duration (int minutes, nullable). There are no
-- start/end timestamp columns, so the window is composed as:
--   [ scheduled_date + scheduled_time,
--     scheduled_date + scheduled_time + COALESCE(estimated_duration,60) min )
-- COALESCE(...,60) mirrors orBoardService.findConflicts so the DB constraint
-- and the app-layer conflict query agree on the assumed duration of a case
-- booked without an explicit estimate.
--
-- IMMUTABILITY: the half-open tsrange uses `(int * INTERVAL '1 minute')` for
-- the duration, NOT `((dur || ' minutes')::interval)`. The text->interval cast
-- is only STABLE (it reads IntervalStyle/DateStyle), so an index expression
-- using it fails with 42P17 "functions in index expression must be marked
-- IMMUTABLE". `date + time` and `timestamp + interval` and integer*interval
-- are all IMMUTABLE, so this form is index-safe. (Verified on the QA cluster
-- before writing this migration.)
--
-- PARTIAL PREDICATE: the constraint only covers rows that can actually clash —
-- scheduled_time and ot_room must be present, and the case must be live
-- (status NULL or not in cancelled/completed). Cancelled/completed cases and
-- cases with an unspecified time/room are exempt: they cannot meaningfully
-- "occupy" a room-window, and exempting them matches findConflicts' own
-- filters so the constraint never rejects a booking the app would have allowed.
--
-- SAFE-ON-EXISTING-DATA: ADD CONSTRAINT ... EXCLUDE validates against existing
-- rows and would fail with an opaque "could not create exclusion constraint"
-- that does not name the offending pair. The DO-block below pre-checks for any
-- existing overlapping live pair and RAISEs an actionable error first, so the
-- operator can resolve the clash (reschedule/cancel one case) before applying.
--
-- No CONCURRENTLY: the migration runner wraps every file in one transaction
-- (SET LOCAL statement_timeout = '120s'); CREATE INDEX/CONSTRAINT CONCURRENTLY
-- cannot run inside a transaction block. btree_gist is created guarded with
-- IF NOT EXISTS so re-runs and pre-existing installs are no-ops.

BEGIN;

-- btree_gist gives gist operator classes for the scalar `=` columns
-- (tenant_id uuid, ot_room text) so they can sit in the same gist index
-- alongside the `&&` range column.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Pre-flight: refuse to apply if existing live rows already overlap, so the
-- constraint build never fails with an unactionable error.
DO $$
DECLARE
  clash RECORD;
BEGIN
  SELECT a.id AS a_id, b.id AS b_id, a.tenant_id, a.ot_room, a.scheduled_date
    INTO clash
    FROM ot_schedules a
    JOIN ot_schedules b
      ON a.tenant_id = b.tenant_id
     AND a.ot_room = b.ot_room
     AND a.id < b.id
     AND a.scheduled_time IS NOT NULL
     AND b.scheduled_time IS NOT NULL
     AND a.ot_room IS NOT NULL
     AND (a.status IS NULL OR a.status NOT IN ('cancelled', 'completed'))
     AND (b.status IS NULL OR b.status NOT IN ('cancelled', 'completed'))
     AND tsrange(
           a.scheduled_date + a.scheduled_time,
           a.scheduled_date + a.scheduled_time + (COALESCE(a.estimated_duration, 60) * INTERVAL '1 minute')
         ) && tsrange(
           b.scheduled_date + b.scheduled_time,
           b.scheduled_date + b.scheduled_time + (COALESCE(b.estimated_duration, 60) * INTERVAL '1 minute')
         )
    LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'ot_schedules already has overlapping live cases (ids % and % in room % on %); reschedule or cancel one before applying migration 319',
      clash.a_id, clash.b_id, clash.ot_room, clash.scheduled_date;
  END IF;
END $$;

-- Durable double-booking backstop: no two live cases may overlap in the same
-- room within the same tenant.
ALTER TABLE ot_schedules
  ADD CONSTRAINT excl_ot_schedules_room_no_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    ot_room WITH =,
    tsrange(
      scheduled_date + scheduled_time,
      scheduled_date + scheduled_time + (COALESCE(estimated_duration, 60) * INTERVAL '1 minute')
    ) WITH &&
  )
  WHERE (
    scheduled_time IS NOT NULL
    AND ot_room IS NOT NULL
    AND (status IS NULL OR status NOT IN ('cancelled', 'completed'))
  );

COMMIT;
