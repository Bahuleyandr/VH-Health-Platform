-- Migration 196: allow `'admitted'` as an emergency_visits.disposition.
--
-- Closes finding signature:
--   emergency-walk-in|admission|backend|
--     er-ipd-admit-returns-before-icu-bed-allocation-because-
--     admitted-disposition-violates-er-visit-constraint
--
-- The ER→IPD admission path (`admissionService.js` ~line 366) correctly
-- closes the ER visit with `disposition='admitted'` when a walk-in
-- patient is converted to an inpatient — but the existing
-- `emergency_visits_disposition_check` predates that workflow and
-- doesn't list `'admitted'` in the allowed set. The admit transaction
-- rolls back at the ER-update step, so the admissions row is never
-- created and the ICU bed is never allocated. Live `POST /api/v1/emr/
-- admit` returns 500 for any ER walk-in admit attempt.
--
-- This migration relaxes the constraint to include `'admitted'`. The
-- rest of the allowed set is preserved verbatim. The status-side enum
-- (`emergency_visits_status_check`) already accepts `'admitted'`, so
-- the disposition value lines up with the existing status vocabulary.
--
-- Fix shape is Option A (broaden the constraint). Option B (rewrite
-- the admission service to use one of the existing values such as
-- `'admitted_ward'` / `'admitted_icu'`) was rejected — at admit time
-- the destination bed pool isn't always known (ICU vs ward decision
-- can happen after admission), and `'admitted'` is the semantically
-- correct umbrella disposition.

BEGIN;

ALTER TABLE emergency_visits
  DROP CONSTRAINT IF EXISTS emergency_visits_disposition_check;

ALTER TABLE emergency_visits
  ADD CONSTRAINT emergency_visits_disposition_check
  CHECK (
    disposition IS NULL
    OR disposition IN (
      'discharged_home',
      'admitted_ward',
      'admitted_icu',
      'admitted_hdu',
      'admitted',
      'transferred_out',
      'left_against_medical_advice',
      'lwbs',
      'expired',
      'observation',
      'opd_followup',
      'other'
    )
  );

COMMIT;
