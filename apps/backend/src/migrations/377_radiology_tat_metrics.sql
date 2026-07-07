-- N6-1: radiology turnaround-time metrics and thresholds.

CREATE TABLE IF NOT EXISTS radiology_tat_thresholds (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  priority VARCHAR(50) NOT NULL,
  modality VARCHAR(50),
  target_minutes INTEGER NOT NULL,
  warning_minutes INTEGER NOT NULL,
  critical_minutes INTEGER NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT fk_radiology_tat_thresholds_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT radiology_tat_thresholds_priority
    CHECK (priority IN ('stat', 'urgent', 'routine')),
  CONSTRAINT radiology_tat_thresholds_minutes
    CHECK (target_minutes > 0 AND warning_minutes >= target_minutes AND critical_minutes >= warning_minutes)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_radiology_tat_thresholds_scope
  ON radiology_tat_thresholds (tenant_id, priority, COALESCE(modality, ''));

ALTER TABLE radiology_tat_thresholds ENABLE ROW LEVEL SECURITY;
ALTER TABLE radiology_tat_thresholds FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON radiology_tat_thresholds;
CREATE POLICY tenant_isolation ON radiology_tat_thresholds
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  );

INSERT INTO radiology_tat_thresholds
  (tenant_id, priority, modality, target_minutes, warning_minutes, critical_minutes, metadata)
VALUES
  ('00000000-0000-4000-8000-000000000001'::uuid, 'stat', NULL, 60, 60, 120,
   '{"stage":"ordered_to_signed","label":"STAT radiology report TAT"}'::jsonb),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'urgent', NULL, 240, 240, 480,
   '{"stage":"ordered_to_signed","label":"Urgent radiology report TAT"}'::jsonb),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'routine', NULL, 1440, 1440, 2880,
   '{"stage":"ordered_to_signed","label":"Routine radiology report TAT"}'::jsonb)
ON CONFLICT DO NOTHING;

INSERT INTO workflow_sla_rules
  (tenant_id, rule_code, title, trigger_event_type, target_minutes, severity,
   owner_role_codes, escalation_role_codes, metadata)
VALUES
  (
    '00000000-0000-4000-8000-000000000001'::uuid,
    'radiology_tat_stat',
    'Radiology STAT turnaround time',
    'radiology.order_created',
    60,
    'high',
    ARRAY['RADIOLOGIST','RADIOLOGY_STAFF']::text[],
    ARRAY['RADIOLOGIST','CMO','QUALITY_OFFICER']::text[],
    '{"source":"radiology_tat_metrics","priority":"stat"}'::jsonb
  ),
  (
    '00000000-0000-4000-8000-000000000001'::uuid,
    'radiology_tat_urgent',
    'Radiology urgent turnaround time',
    'radiology.order_created',
    240,
    'medium',
    ARRAY['RADIOLOGIST','RADIOLOGY_STAFF']::text[],
    ARRAY['RADIOLOGIST','QUALITY_OFFICER']::text[],
    '{"source":"radiology_tat_metrics","priority":"urgent"}'::jsonb
  ),
  (
    '00000000-0000-4000-8000-000000000001'::uuid,
    'radiology_tat_routine',
    'Radiology routine turnaround time',
    'radiology.order_created',
    1440,
    'medium',
    ARRAY['RADIOLOGIST','RADIOLOGY_STAFF']::text[],
    ARRAY['RADIOLOGIST','QUALITY_OFFICER']::text[],
    '{"source":"radiology_tat_metrics","priority":"routine"}'::jsonb
  )
ON CONFLICT ((COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)), rule_code)
DO UPDATE SET
  target_minutes = EXCLUDED.target_minutes,
  severity = EXCLUDED.severity,
  owner_role_codes = EXCLUDED.owner_role_codes,
  escalation_role_codes = EXCLUDED.escalation_role_codes,
  metadata = EXCLUDED.metadata,
  enabled = TRUE,
  updated_at = NOW();

CREATE OR REPLACE VIEW radiology_tat_metrics AS
SELECT
  ro.tenant_id,
  ro.id AS radiology_order_id,
  ro.patient_uid,
  u.id AS patient_id,
  ro.modality,
  ro.body_part,
  COALESCE(ro.priority, 'routine') AS priority,
  ro.status,
  ro.created_at AS ordered_at,
  ro.acquired_at,
  ro.report_completed_at AS reported_at,
  ro.report_signed_off_at AS signed_at,
  CASE
    WHEN ro.created_at IS NOT NULL AND ro.acquired_at IS NOT NULL
      THEN ROUND(EXTRACT(EPOCH FROM (ro.acquired_at - ro.created_at)) / 60)::integer
    ELSE NULL
  END AS ordered_to_acquired_minutes,
  CASE
    WHEN ro.acquired_at IS NOT NULL AND ro.report_completed_at IS NOT NULL
      THEN ROUND(EXTRACT(EPOCH FROM (ro.report_completed_at - ro.acquired_at)) / 60)::integer
    ELSE NULL
  END AS acquired_to_reported_minutes,
  CASE
    WHEN ro.report_completed_at IS NOT NULL AND ro.report_signed_off_at IS NOT NULL
      THEN ROUND(EXTRACT(EPOCH FROM (ro.report_signed_off_at - ro.report_completed_at)) / 60)::integer
    ELSE NULL
  END AS reported_to_signed_minutes,
  CASE
    WHEN ro.created_at IS NOT NULL AND ro.report_signed_off_at IS NOT NULL
      THEN ROUND(EXTRACT(EPOCH FROM (ro.report_signed_off_at - ro.created_at)) / 60)::integer
    ELSE NULL
  END AS ordered_to_signed_minutes,
  CASE
    WHEN ro.created_at IS NOT NULL
      THEN ROUND(EXTRACT(EPOCH FROM (COALESCE(ro.report_signed_off_at, NOW()) - ro.created_at)) / 60)::integer
    ELSE NULL
  END AS current_elapsed_minutes,
  th.target_minutes,
  th.warning_minutes,
  th.critical_minutes,
  CASE
    WHEN ro.report_signed_off_at IS NOT NULL THEN 'signed'
    WHEN ro.report_completed_at IS NOT NULL THEN 'reported_pending_signoff'
    WHEN ro.acquired_at IS NOT NULL THEN 'acquired_pending_report'
    ELSE 'ordered_pending_acquisition'
  END AS tat_stage,
  CASE
    WHEN ro.created_at IS NULL THEN FALSE
    WHEN ROUND(EXTRACT(EPOCH FROM (COALESCE(ro.report_signed_off_at, NOW()) - ro.created_at)) / 60)::integer >= th.warning_minutes THEN TRUE
    ELSE FALSE
  END AS threshold_breached,
  CASE
    WHEN ro.created_at IS NULL THEN NULL
    WHEN ROUND(EXTRACT(EPOCH FROM (COALESCE(ro.report_signed_off_at, NOW()) - ro.created_at)) / 60)::integer >= th.critical_minutes THEN 'CRITICAL'
    WHEN ROUND(EXTRACT(EPOCH FROM (COALESCE(ro.report_signed_off_at, NOW()) - ro.created_at)) / 60)::integer >= th.warning_minutes THEN 'WARNING'
    ELSE NULL
  END AS alert_severity
FROM radiology_orders ro
LEFT JOIN users u ON u.uid = ro.patient_uid
LEFT JOIN LATERAL (
  SELECT target_minutes, warning_minutes, critical_minutes
    FROM radiology_tat_thresholds rt
   WHERE rt.tenant_id = ro.tenant_id
     AND rt.priority = COALESCE(ro.priority, 'routine')
     AND rt.is_active = TRUE
     AND (rt.modality IS NULL OR rt.modality = ro.modality)
   ORDER BY rt.modality NULLS LAST
   LIMIT 1
) th ON TRUE
WHERE th.target_minutes IS NOT NULL;
