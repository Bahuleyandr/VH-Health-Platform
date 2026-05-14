-- Migration 222 — deduplicate maternity_anc_visits + UNIQUE (pregnancy_id, visit_date).
--
-- Ref:
--   finding 2026-05-09-obstetric-anc-patient-duplicate-anc-visit-alarming-bp
--
-- The ANC nurse step was inserting a second visit row on the same day
-- to test the pre-eclampsia alert threshold (BP ≥ 140/90), leaving the
-- pregnancy timeline with a ghost visit that reads as a clinical
-- emergency that never happened. Worse, the ghost row's NULL
-- next_visit_date breaks any "latest ANC visit → next appointment"
-- logic.
--
-- Clinically there is at most one ANC visit per (pregnancy, calendar
-- day). Multiple readings on the same day belong to the same row,
-- updated as new measurements come in. Enforce that at the DB layer
-- so the recordAncVisit service can switch to an UPSERT.
--
-- Strategy:
--   1. Within each (pregnancy_id, visit_date) duplicate group, keep
--      the row with the most clinical fields populated (BP, weight,
--      fundal height, FHR, gestational age, next_visit_date). Tie-break
--      on lowest id so the canonical "first" visit wins over the ghost.
--      Delete the others.
--   2. Add a unique constraint so future inserts cannot reintroduce
--      the duplicate.

BEGIN;

WITH ranked AS (
  SELECT
    id, pregnancy_id, visit_date,
    ROW_NUMBER() OVER (
      PARTITION BY pregnancy_id, visit_date
      ORDER BY (
        (bp_systolic IS NOT NULL)::int +
        (bp_diastolic IS NOT NULL)::int +
        (weight_kg IS NOT NULL)::int +
        (fundal_height_cm IS NOT NULL)::int +
        (fetal_heart_rate_bpm IS NOT NULL)::int +
        (gestational_age_weeks IS NOT NULL)::int +
        (next_visit_date IS NOT NULL)::int +
        (hb_gm_dl IS NOT NULL)::int
      ) DESC,
      id ASC
    ) AS rn
  FROM maternity_anc_visits
)
DELETE FROM maternity_anc_visits
 WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

ALTER TABLE maternity_anc_visits
  ADD CONSTRAINT maternity_anc_visits_pregnancy_visit_date_uniq
  UNIQUE (pregnancy_id, visit_date);

COMMIT;
