-- 652_news2_rescore_supersede_partial.sql
--
-- 2026-08-10 independent-audit triage, findings R4 + NEWS2-divergence:
--
-- 1. R4 — correcting a vitals row (vitalsChartService.correctVitals) never
--    re-ran NEWS2, so a corrected SpO2 98→88 left the stale reassuring
--    score/escalation on record. Re-scoring needs two things the schema
--    lacked:
--      * news2_scores.vitals_chart_id — the score's source vitals row. The
--        vitals path writes the score in the same tx as the vitals row but
--        kept no linkage, so a correction could not find "the score this
--        row produced". Nullable: standalone / nursing-path scores have no
--        vitals row, and pre-migration rows stay NULL (the 5-minute
--        correction window means every correctable row is post-deploy).
--      * news2_scores.superseded_by_id — the visible supersede chain. A
--        correction inserts a NEW score row (append, never in-place edit)
--        and stamps the replaced row's superseded_by_id with it. Readers
--        that want only live scores filter superseded_by_id IS NULL.
--
-- 2. NEWS2 partial-score marker — persistNews2 records genuine partial
--    scores (deliberate design, news2Service.js) but nothing on the row
--    said so: a partial "total 3" was indistinguishable from a complete
--    assessment except by NULL-spotting the vitals columns. Same gap on the
--    nursing-assessment surface. Both tables now carry an explicit
--    partial_score flag + the missing parameter list.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE news2_scores
  ADD COLUMN IF NOT EXISTS vitals_chart_id  INTEGER,
  ADD COLUMN IF NOT EXISTS superseded_by_id INTEGER,
  ADD COLUMN IF NOT EXISTS partial_score    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS missing_params   TEXT[];

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_news2_scores_vitals_chart') THEN
    ALTER TABLE news2_scores
      ADD CONSTRAINT fk_news2_scores_vitals_chart
      FOREIGN KEY (vitals_chart_id) REFERENCES vitals_chart(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_news2_scores_superseded_by') THEN
    ALTER TABLE news2_scores
      ADD CONSTRAINT fk_news2_scores_superseded_by
      FOREIGN KEY (superseded_by_id) REFERENCES news2_scores(id) ON DELETE SET NULL;
  END IF;
END $$;

-- The correction path looks up live scores by their source vitals row.
CREATE INDEX IF NOT EXISTS idx_news2_scores_vitals_chart
  ON news2_scores (vitals_chart_id)
  WHERE vitals_chart_id IS NOT NULL;

ALTER TABLE nursing_assessments
  ADD COLUMN IF NOT EXISTS partial_score  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS missing_params TEXT[];

COMMIT;
