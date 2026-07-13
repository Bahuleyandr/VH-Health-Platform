-- 574_unified_audit_read_model.sql
--
-- Normalized, read-only accountability view over the five audit sinks used by
-- the platform. Source tables remain the authoritative evidence stores; this
-- view gives the admin audit API one stable contract without rewriting legacy
-- writers. The supporting indexes match tenant + time, actor, patient,
-- resource, outcome, and request-correlation query patterns.

BEGIN;

DROP VIEW IF EXISTS unified_audit_events_v;

CREATE VIEW unified_audit_events_v WITH (security_invoker = true) AS
SELECT
  'request'::text AS source,
  al.id::text AS id,
  al.tenant_id,
  al.created_at AS occurred_at,
  COALESCE(al.actor_uid, al.uid) AS actor_uid,
  al.user_id AS actor_user_id,
  al.user_name AS actor_name,
  al.user_role AS actor_role,
  CASE
    WHEN COALESCE(al.metadata->>'patient_uid',
      CASE WHEN al.resource = 'patient' THEN al.resource_id END)
      ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    THEN COALESCE(al.metadata->>'patient_uid',
      CASE WHEN al.resource = 'patient' THEN al.resource_id END)::uuid
  END AS patient_uid,
  COALESCE(al.metadata->>'patient_id',
    CASE WHEN al.resource = 'patient' AND al.resource_id ~ '^[0-9]+$' THEN al.resource_id END) AS patient_id,
  al.metadata->>'department_id' AS department_id,
  al.metadata->>'encounter_id' AS encounter_id,
  al.metadata->>'admission_id' AS admission_id,
  al.action::text AS action,
  CASE WHEN al.success IS TRUE THEN 'success'
       WHEN al.success IS FALSE THEN 'failure'
       ELSE 'unknown' END::text AS outcome,
  'request'::text AS category,
  COALESCE(al.resource, al.module)::text AS resource_type,
  al.resource_id::text AS resource_id,
  CONCAT_WS(' ', al.method, al.path)::text AS summary,
  al.metadata->>'request_id' AS request_id,
  al.ip_address::text AS ip_address,
  al.device_type::text AS device_type,
  al.user_agent::text AS user_agent,
  jsonb_strip_nulls(jsonb_build_object(
    'method', al.method,
    'path', al.path,
    'module', al.module,
    'status_code', al.status_code,
    'response_time_ms', al.response_time_ms,
    'request_id', al.metadata->>'request_id',
    'encounter_id', al.metadata->>'encounter_id',
    'appointment_id', al.metadata->>'appointment_id',
    'admission_id', al.metadata->>'admission_id',
    'device_type', al.device_type
  )) AS safe_detail
FROM audit_log al

UNION ALL

SELECT
  'operational'::text AS source,
  al.id::text AS id,
  al.tenant_id,
  al.created_at AT TIME ZONE 'UTC' AS occurred_at,
  COALESCE(al.actor_uid, al.uid) AS actor_uid,
  NULL::integer AS actor_user_id,
  NULL::text AS actor_name,
  al.role::text AS actor_role,
  CASE
    WHEN COALESCE(al.metadata->>'patient_uid',
      CASE WHEN al.resource = 'patient' THEN al.resource_id END)
      ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    THEN COALESCE(al.metadata->>'patient_uid',
      CASE WHEN al.resource = 'patient' THEN al.resource_id END)::uuid
  END AS patient_uid,
  COALESCE(al.metadata->>'patient_id',
    CASE WHEN al.resource = 'patient' AND al.resource_id ~ '^[0-9]+$' THEN al.resource_id END) AS patient_id,
  al.metadata->>'department_id' AS department_id,
  al.metadata->>'encounter_id' AS encounter_id,
  al.metadata->>'admission_id' AS admission_id,
  al.action::text AS action,
  COALESCE(NULLIF(al.metadata->>'outcome', ''), 'success')::text AS outcome,
  'operational'::text AS category,
  al.resource::text AS resource_type,
  al.resource_id::text AS resource_id,
  CONCAT_WS(' ', al.action, al.resource, al.resource_id)::text AS summary,
  al.metadata->>'request_id' AS request_id,
  al.ip_address::text AS ip_address,
  al.metadata->>'device_type' AS device_type,
  al.user_agent::text AS user_agent,
  jsonb_strip_nulls(jsonb_build_object(
    'request_id', al.metadata->>'request_id',
    'table_name', al.metadata->>'table_name',
    'audit_action_type', al.metadata->>'audit_action_type',
    'encounter_id', al.metadata->>'encounter_id',
    'appointment_id', al.metadata->>'appointment_id',
    'admission_id', al.metadata->>'admission_id',
    'device_type', al.metadata->>'device_type'
  )) AS safe_detail
FROM audit_logs al

UNION ALL

SELECT
  'clinical'::text AS source,
  cae.id::text AS id,
  cae.tenant_id,
  cae.occurred_at,
  cae.actor_uid,
  NULL::integer AS actor_user_id,
  NULL::text AS actor_name,
  cae.actor_role::text AS actor_role,
  cae.patient_uid,
  NULL::text AS patient_id,
  cae.metadata->>'department_id' AS department_id,
  cae.encounter_id::text AS encounter_id,
  cae.metadata->>'admission_id' AS admission_id,
  cae.action::text AS action,
  cae.action_status::text AS outcome,
  'clinical'::text AS category,
  cae.resource_type::text AS resource_type,
  cae.resource_id::text AS resource_id,
  cae.action::text AS summary,
  cae.request_id::text AS request_id,
  cae.ip_address::text AS ip_address,
  cae.metadata->>'device_type' AS device_type,
  cae.user_agent::text AS user_agent,
  jsonb_strip_nulls(jsonb_build_object(
    'request_id', cae.request_id,
    'encounter_id', cae.encounter_id,
    'resource_table', cae.resource_table,
    'idempotency_key', cae.idempotency_key,
    'chain_seq', cae.chain_seq,
    'device_type', cae.metadata->>'device_type'
  )) AS safe_detail
FROM clinical_audit_events cae

UNION ALL

SELECT
  'phi_access'::text AS source,
  hal.id::text AS id,
  hal.tenant_id,
  hal.accessed_at AS occurred_at,
  COALESCE(hal.actor_uid, hal.accessed_by) AS actor_uid,
  NULL::integer AS actor_user_id,
  NULL::text AS actor_name,
  hal.accessed_by_role::text AS actor_role,
  CASE
    WHEN hal.patient_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    THEN hal.patient_id::uuid
  END AS patient_uid,
  CASE WHEN hal.patient_id ~ '^[0-9]+$' THEN hal.patient_id END AS patient_id,
  NULL::text AS department_id,
  NULL::text AS encounter_id,
  NULL::text AS admission_id,
  COALESCE(hal.action, 'view')::text AS action,
  'success'::text AS outcome,
  'phi_access'::text AS category,
  hal.record_type::text AS resource_type,
  hal.patient_id::text AS resource_id,
  CONCAT_WS(' ', COALESCE(hal.action, 'view'), hal.record_type)::text AS summary,
  hal.request_id::text AS request_id,
  hal.ip_address::text AS ip_address,
  hal.device_type::text AS device_type,
  NULL::text AS user_agent,
  jsonb_strip_nulls(jsonb_build_object(
    'request_id', hal.request_id,
    'record_type', hal.record_type,
    'acting_as_dependent', hal.acting_as_dependent,
    'device_type', hal.device_type
  )) AS safe_detail
FROM hipaa_access_log hal

UNION ALL

SELECT
  'patient_access'::text AS source,
  pa.id::text AS id,
  pa.tenant_id,
  pa.created_at AS occurred_at,
  pa.actor_uid,
  NULL::integer AS actor_user_id,
  NULL::text AS actor_name,
  pa.actor_role::text AS actor_role,
  pa.patient_uid,
  NULL::text AS patient_id,
  pa.metadata->>'department_id' AS department_id,
  pa.metadata->>'encounter_id' AS encounter_id,
  pa.metadata->>'admission_id' AS admission_id,
  COALESCE(pa.action, 'patient_access')::text AS action,
  CASE WHEN pa.access_source = 'break_glass' THEN 'break_glass'
       ELSE pa.access_decision END::text AS outcome,
  'patient_access'::text AS category,
  'patient_access'::text AS resource_type,
  COALESCE(pa.care_team_id::text, pa.break_glass_id::text) AS resource_id,
  CONCAT_WS(' ', COALESCE(pa.action, 'patient_access'), pa.access_source)::text AS summary,
  pa.request_id::text AS request_id,
  NULL::text AS ip_address,
  pa.metadata->>'device_type' AS device_type,
  NULL::text AS user_agent,
  jsonb_strip_nulls(jsonb_build_object(
    'request_id', pa.request_id,
    'access_source', pa.access_source,
    'route', pa.route,
    'care_team_id', pa.care_team_id,
    'break_glass_id', pa.break_glass_id,
    'device_type', pa.metadata->>'device_type'
  )) AS safe_detail
FROM patient_access_audit_log pa;

CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_time_id
  ON audit_log (tenant_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_actor_time
  ON audit_log (tenant_id, actor_uid, created_at DESC, id DESC)
  WHERE actor_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_role_time
  ON audit_log (tenant_id, user_role, created_at DESC, id DESC)
  WHERE user_role IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_resource_time
  ON audit_log (tenant_id, resource, resource_id, created_at DESC, id DESC)
  WHERE resource IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_log_patient_uid_time
  ON audit_log (tenant_id, ((metadata->>'patient_uid')), created_at DESC, id DESC)
  WHERE metadata ? 'patient_uid';

CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_time_id
  ON audit_logs (tenant_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_actor_time
  ON audit_logs (tenant_id, uid, created_at DESC, id DESC)
  WHERE uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_role_time
  ON audit_logs (tenant_id, role, created_at DESC, id DESC)
  WHERE role IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_resource_time
  ON audit_logs (tenant_id, resource, resource_id, created_at DESC, id DESC)
  WHERE resource IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_logs_patient_uid_time
  ON audit_logs (tenant_id, ((metadata->>'patient_uid')), created_at DESC, id DESC)
  WHERE metadata ? 'patient_uid';

CREATE INDEX IF NOT EXISTS idx_clinical_audit_tenant_action_time
  ON clinical_audit_events (tenant_id, action, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_clinical_audit_tenant_outcome_time
  ON clinical_audit_events (tenant_id, action_status, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_clinical_audit_tenant_resource_time
  ON clinical_audit_events (tenant_id, resource_type, resource_id, occurred_at DESC, id DESC)
  WHERE resource_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_clinical_audit_tenant_encounter_time
  ON clinical_audit_events (tenant_id, encounter_id, occurred_at DESC, id DESC)
  WHERE encounter_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_clinical_audit_request_id
  ON clinical_audit_events (tenant_id, request_id)
  WHERE request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_hipaa_access_tenant_time_id
  ON hipaa_access_log (tenant_id, accessed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_hipaa_access_tenant_actor_time
  ON hipaa_access_log (tenant_id, accessed_by, accessed_at DESC, id DESC)
  WHERE accessed_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hipaa_access_tenant_patient_time
  ON hipaa_access_log (tenant_id, patient_id, accessed_at DESC, id DESC)
  WHERE patient_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_patient_access_audit_request_id
  ON patient_access_audit_log (tenant_id, request_id)
  WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_patient_access_audit_action_time
  ON patient_access_audit_log (tenant_id, action, created_at DESC, id DESC)
  WHERE action IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_clinical_notes_audit_completeness
  ON clinical_notes (tenant_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_clinical_orders_audit_completeness
  ON clinical_orders (tenant_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_investigations_audit_completeness
  ON investigations (tenant_id, created_at DESC, id DESC)
  WHERE created_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_investigations_audit_completeness_legacy
  ON investigations (tenant_id, requested_at DESC, id DESC)
  WHERE created_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_e_prescriptions_audit_completeness
  ON e_prescriptions (tenant_id, created_at DESC, id DESC)
  WHERE created_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_e_prescriptions_audit_completeness_legacy
  ON e_prescriptions (tenant_id, updated_at DESC, id DESC)
  WHERE created_at IS NULL AND updated_at IS NOT NULL;

COMMIT;
