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
--      * news2_scores.superseded_by_id / superseded_at — the visible
--        supersede chain. A correction inserts a NEW score row (append,
--        never in-place edit) and stamps the replaced row with the successor
--        and timestamp. When a correction removes the final scorable NEWS2
--        input there is no successor, so superseded_at still retires the stale
--        score while superseded_by_id remains NULL. Readers that want only
--        live scores filter superseded_at IS NULL.
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
  ADD COLUMN IF NOT EXISTS superseded_at    TIMESTAMPTZ,
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

-- Backfill the explicit partial marker for historical rows. Without this,
-- every pre-migration partial score would be mislabeled as complete by the
-- new DEFAULT FALSE.
WITH derived AS (
  SELECT id,
         NUM_NONNULLS(respiration_rate, spo2, temperature, systolic_bp,
                      heart_rate, consciousness) AS present_count,
         ARRAY_REMOVE(ARRAY[
           CASE WHEN respiration_rate IS NULL THEN 'respiration_rate' END,
           CASE WHEN spo2 IS NULL THEN 'spo2' END,
           CASE WHEN temperature IS NULL THEN 'temperature' END,
           CASE WHEN systolic_bp IS NULL THEN 'systolic_bp' END,
           CASE WHEN heart_rate IS NULL THEN 'heart_rate' END,
           CASE WHEN consciousness IS NULL THEN 'consciousness' END
         ], NULL) AS missing
    FROM news2_scores
)
UPDATE news2_scores n
   SET partial_score = d.present_count > 0 AND d.present_count < 6,
       missing_params = CASE
         WHEN d.present_count > 0 AND d.present_count < 6 THEN d.missing
         ELSE NULL
       END
 FROM derived d
 WHERE n.id = d.id;

ALTER TABLE nursing_assessments
  ADD COLUMN IF NOT EXISTS partial_score  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS missing_params TEXT[];

WITH derived AS (
  SELECT id,
         ARRAY_REMOVE(ARRAY[
           CASE WHEN NULLIF(BTRIM(COALESCE(inputs->>'rr', inputs->>'respiratory_rate')), '') IS NULL THEN 'respiration_rate' END,
           CASE WHEN NULLIF(BTRIM(inputs->>'spo2'), '') IS NULL THEN 'spo2' END,
           CASE WHEN NULLIF(BTRIM(COALESCE(inputs->>'temp_c', inputs->>'temperature')), '') IS NULL THEN 'temperature' END,
           CASE WHEN NULLIF(BTRIM(COALESCE(inputs->>'sbp', inputs->>'systolic_bp')), '') IS NULL THEN 'systolic_bp' END,
           CASE WHEN NULLIF(BTRIM(COALESCE(inputs->>'hr', inputs->>'pulse', inputs->>'heart_rate')), '') IS NULL THEN 'heart_rate' END,
           CASE WHEN NULLIF(BTRIM(inputs->>'consciousness'), '') IS NULL THEN 'consciousness' END
         ], NULL) AS missing
    FROM nursing_assessments
   WHERE assessment_kind = 'news2'
), counted AS (
  SELECT id, missing, 6 - CARDINALITY(missing) AS present_count
    FROM derived
)
UPDATE nursing_assessments n
   SET partial_score = c.present_count > 0 AND c.present_count < 6,
       missing_params = CASE
         WHEN c.present_count > 0 AND c.present_count < 6 THEN c.missing
         ELSE NULL
       END
  FROM counted c
 WHERE n.id = c.id;

-- The correction path looks up live scores by their source vitals row.
DROP INDEX IF EXISTS idx_news2_scores_vitals_chart;
CREATE INDEX IF NOT EXISTS idx_news2_scores_vitals_chart
  ON news2_scores (vitals_chart_id)
  WHERE vitals_chart_id IS NOT NULL AND superseded_at IS NULL;

COMMIT;
