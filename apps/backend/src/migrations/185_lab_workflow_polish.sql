-- 185_lab_workflow_polish.sql
--
-- E-5 — Lab workflow polish.
--
-- Closes:
--   2026-05-08-lab-walk-in-lab-tech-results-overwrite-no-history
--      Re-PUT /investigations/:id/results silently overwrote prior
--      values. Adds previous_results JSONB[] so each overwrite pushes
--      the prior snapshot into history before replacing.
--
--   2026-05-08-lab-walk-in-lab-tech-status-enum-mismatch
--      Adds an explicit 'COLLECTED' status (sample drawn but not yet
--      on the analyser). The validator + service additions land in
--      investigationConfig.js and investigationService.
--
-- Architectural item E-5.

BEGIN;

ALTER TABLE investigations
  ADD COLUMN IF NOT EXISTS previous_results JSONB,
  ADD COLUMN IF NOT EXISTS result_version   INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS collected_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS collected_by     UUID;

CREATE INDEX IF NOT EXISTS idx_investigations_collected
  ON investigations(collected_at)
  WHERE collected_at IS NOT NULL;

COMMIT;
