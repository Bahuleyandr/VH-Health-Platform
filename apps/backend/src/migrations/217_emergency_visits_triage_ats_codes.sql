-- 2026-05-13 — emergency_visits.triage_priority CHECK constraint allows
-- only ESI / Manchester / CTAS levels (migration 126). Nurses charting
-- an `assessment_kind: 'australian'` triage assessment had to set the
-- closest CTAS approximation on the visit, producing a terminology
-- mismatch between the assessment row and the visit row.
--
-- This migration replaces the constraint so the four-scale set is
-- supported end-to-end. Application validators (TRIAGE_PRIORITIES in
-- edOperationsService.js) are updated to match.
--
-- Finding: 2026-05-09-emergency-walk-in-nurse-triage-priority-no-queue-effect.

ALTER TABLE emergency_visits
  DROP CONSTRAINT IF EXISTS emergency_visits_triage_priority_check;

ALTER TABLE emergency_visits
  ADD CONSTRAINT emergency_visits_triage_priority_check
  CHECK (triage_priority IS NULL OR triage_priority IN (
    'esi_1', 'esi_2', 'esi_3', 'esi_4', 'esi_5',
    'manchester_red', 'manchester_orange', 'manchester_yellow', 'manchester_green', 'manchester_blue',
    'ctas_1', 'ctas_2', 'ctas_3', 'ctas_4', 'ctas_5',
    'ats_1', 'ats_2', 'ats_3', 'ats_4', 'ats_5',
    'unassigned'
  ));
