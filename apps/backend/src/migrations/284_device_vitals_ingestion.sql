-- 284_device_vitals_ingestion.sql
--
-- Roadmap Pillar C / item C5 (docs/EPIC_LEVEL_ROADMAP.md) — ICU monitor /
-- device vitals ingestion. Monitors push HL7 ORU vitals; those land in
-- vitals_chart through the SAME write path nurses use (NEWS2, anomaly
-- alerts, canonical events all fire) but are labelled device-synced and
-- UNVERIFIED until a clinician reviews them, per
-- docs/CANONICAL_CLINICAL_TIMELINE.md ("device observations must be
-- labelled unverified until a clinician reviews them").

BEGIN;

ALTER TABLE vitals_chart
  ADD COLUMN IF NOT EXISTS source VARCHAR(30) NOT NULL DEFAULT 'staff',
  ADD COLUMN IF NOT EXISTS source_device VARCHAR(120),
  ADD COLUMN IF NOT EXISTS device_verified BOOLEAN,
  ADD COLUMN IF NOT EXISTS verified_by UUID,
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ(6);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_vitals_chart_source'
  ) THEN
    ALTER TABLE vitals_chart
      ADD CONSTRAINT chk_vitals_chart_source
      CHECK (source IN ('staff', 'device', 'fhir', 'patient_app'));
  END IF;
END
$$;

-- The ICU review queue: device rows awaiting clinician verification.
CREATE INDEX IF NOT EXISTS idx_vitals_chart_device_unverified
  ON vitals_chart (patient_uid, recorded_at DESC)
  WHERE source = 'device' AND device_verified = false;

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'DEVICE_VITALS_INGESTION_APPLIED',
  'vitals_chart',
  'vitals_chart',
  jsonb_build_object(
    'migration', '284_device_vitals_ingestion.sql',
    'roadmap', 'docs/EPIC_LEVEL_ROADMAP.md#C5',
    'reason', 'Device-sourced vitals labelling (source/source_device/device_verified) + clinician verification stamps; ICU monitor ORU ingestion uses the standard vitals write path.'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'DEVICE_VITALS_INGESTION_APPLIED'
    AND resource = 'vitals_chart'
);

COMMIT;
