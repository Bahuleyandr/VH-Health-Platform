-- 170_admissions_er_linkage.sql
--
-- ER → admission linkage. When an emergency-department patient is admitted,
-- we record the source ER visit on the admission row so the inpatient stay
-- and the preceding ER chart are one continuous clinical encounter, even
-- though they remain separate billable encounters (ER + ward/ICU prices
-- differ; per project decision 2026-05-09).
--
-- Carry-over of clinical fields (chief_complaint, priority, attending
-- doctor) happens in admissionService.admitPatient — this migration only
-- adds the columns. ER bed → ward bed is NOT a carry-over by design (ER
-- and ward bed pools are separate).
--
-- Finding: 2026-05-08-emergency-walk-in-doctor-admit-no-er-visit-linkage.

BEGIN;

ALTER TABLE admissions
  -- FK to emergency_visits.id. ON DELETE SET NULL preserves the admission
  -- audit trail if the ER visit is ever deleted/archived.
  ADD COLUMN IF NOT EXISTS from_er_visit_id INTEGER
    REFERENCES emergency_visits(id) ON DELETE SET NULL,
  -- Captured separately from admissions.admitted_at so SLA / door-to-bed
  -- reports can query without joining back to emergency_visits.
  ADD COLUMN IF NOT EXISTS er_arrival_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_admissions_from_er_visit
  ON admissions(from_er_visit_id)
  WHERE from_er_visit_id IS NOT NULL;

COMMIT;
