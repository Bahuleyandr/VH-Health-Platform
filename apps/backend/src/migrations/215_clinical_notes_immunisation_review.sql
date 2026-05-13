-- 215_clinical_notes_immunisation_review.sql
--
-- Wave-5 batch-3 — single-tap "immunisation up-to-date" note.
--
-- Background. Recording that a toddler's immunisation schedule is
-- up-to-date currently requires writing one `newborn_immunisations`
-- row per scheduled vaccine — typically 29 rows for the first two
-- years of the IAP/UIP schedule. The nurse intake at OPD often
-- doesn't have the parent's exact prior-dose dates, just the
-- "all caught up" affirmation. Forcing the full per-dose entry
-- either (a) blocks the chart open, or (b) gets gamed by entering
-- placeholder dates that pollute the immunisation surface.
--
-- The fix is a workflow shortcut: a single `clinical_notes` row with
-- `note_type='immunisation_review'` and `content={status, as_of,
-- signed_by, age_group}`. The patient's immunisation card surface
-- (newborn_immunisations + this note) computes "up-to-date as of X"
-- from the most recent such note.
--
-- Finding:
--   2026-05-10-pediatric-opd-nurse-immunisation-up-to-date-requires-29-writes
--
-- This migration is index-only — `clinical_notes` already has the
-- columns required (note_type, content jsonb, patient_uid, author_*).
-- We add a partial index so the patient-app + admin surfaces can
-- find "most recent immunisation_review" without scanning the whole
-- notes table for a patient.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_clinical_notes_immunisation_review
  ON clinical_notes(patient_uid, created_at DESC)
  WHERE note_type = 'immunisation_review';

COMMIT;
