-- 224_emergency_icu_continuation.sql
--
-- Stage 5 — emergency/ICU continuation cluster. Closes the schema-level
-- gaps behind three findings; the matching service/route work lands
-- alongside this migration.
--
--   2026-05-08-emergency-walk-in-doctor-er-to-icu-no-continuation
--     An ICU admission carried no link back to the emergency_visit it
--     was admitted from. Add a nullable er_visit_id on icu_admissions
--     so "admit from ER" preserves the ER episode trace (triage, ER
--     orders, results are all reachable through emergency_visits.id).
--     Plain integer link — no formal FK constraint, matching the
--     existing icu_admissions.admission_id style; the from-er service
--     path validates the visit exists before insert.
--
--   2026-05-09-emergency-walk-in-doctor-er-encounter-id-gap
--     ER orders could not attach to an ER encounter — clinical_orders
--     .encounter_id is a UUID and emergency_visits had no UUID key, so
--     orders for ER patients without an admission were filed with
--     encounter_id NULL. Give emergency_visits its own UUID encounter
--     key (same shape as admissions.encounter_id) so ER orders/notes
--     scope to the ER episode the same way IPD orders scope to an
--     admission. DB-side DEFAULT keeps every future row well-formed
--     without touching createEmergencyVisit; existing rows are
--     backfilled in the same migration.

BEGIN;

-- ── ICU admission ← emergency_visit link ─────────────────────────────
ALTER TABLE icu_admissions
  ADD COLUMN IF NOT EXISTS er_visit_id INTEGER;

-- Partial index — most ICU admissions are not ER-sourced, so only index
-- the rows that carry the link. Partial indexes are intentionally not
-- reflected in schema.prisma (see idx_icu_admissions_npo_active from
-- migration 184) so the drift check stays quiet.
CREATE INDEX IF NOT EXISTS idx_icu_admissions_er_visit
  ON icu_admissions(er_visit_id)
  WHERE er_visit_id IS NOT NULL;

-- ── emergency_visits UUID encounter key ──────────────────────────────
ALTER TABLE emergency_visits
  ADD COLUMN IF NOT EXISTS encounter_id UUID DEFAULT gen_random_uuid();

-- Backfill every existing row so the column can go NOT NULL.
UPDATE emergency_visits
   SET encounter_id = gen_random_uuid()
 WHERE encounter_id IS NULL;

ALTER TABLE emergency_visits
  ALTER COLUMN encounter_id SET NOT NULL;

-- Named to match Prisma's default unique-constraint convention
-- ({table}_{column}_key) so `prisma db pull` emits a bare @unique with
-- no map: and the committed schema stays drift-clean.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'emergency_visits_encounter_id_key'
  ) THEN
    ALTER TABLE emergency_visits
      ADD CONSTRAINT emergency_visits_encounter_id_key UNIQUE (encounter_id);
  END IF;
END $$;

COMMIT;
