-- Migration 657: link vital anomaly consequences to their source observation.
--
-- A vitals correction must be able to retire the exact alert/task graph that
-- was derived from the pre-correction values. The source link is nullable for
-- legacy and non-vitals clinical alerts.
-- @no-transaction
-- @statement_timeout: 0

ALTER TABLE public.clinical_alerts
  ADD COLUMN IF NOT EXISTS source_vitals_chart_id INTEGER;

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'fk_clinical_alerts_source_vitals_chart'
       AND conrelid = 'public.clinical_alerts'::regclass
  ) THEN
    ALTER TABLE public.clinical_alerts
      ADD CONSTRAINT fk_clinical_alerts_source_vitals_chart
      FOREIGN KEY (source_vitals_chart_id)
      REFERENCES public.vitals_chart(id)
      ON UPDATE NO ACTION ON DELETE SET NULL
      NOT VALID;
  END IF;
END
$constraint$;

ALTER TABLE public.clinical_alerts
  VALIDATE CONSTRAINT fk_clinical_alerts_source_vitals_chart;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_clinical_alerts_source_vitals_open
  ON public.clinical_alerts (tenant_id, source_vitals_chart_id)
  WHERE source_vitals_chart_id IS NOT NULL
    AND COALESCE(acknowledged, false) = false
    AND acknowledged_at IS NULL;
