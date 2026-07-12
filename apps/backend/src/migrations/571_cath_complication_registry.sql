-- NL-13 P1f: structured cath complication registry + BI catalog registration.
--
-- Registry rows are derived from cath_procedure_logs.complications (JSONB,
-- migration 483) at procedure-log time and can also be curated manually.
-- complication_code/complication_category are OWNER-TAXONOMY slots (free
-- text, no seeded vocabulary — coding systems are an owner decision);
-- severity/outcome/review_status are generic workflow enums only.
--
-- Seeder-law notes (playbook §3): every CHECK below is a simple single-column
-- IN list or NULL-tolerant range — no conditional cross-column CHECKs. The
-- nullable procedure_log_id FK uses ON DELETE SET NULL and this table carries
-- NO append-only trigger, so the FK-nulling action stays legal.

CREATE TABLE IF NOT EXISTS cath_complication_registry (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  case_id BIGINT NOT NULL REFERENCES cath_lab_cases(id) ON DELETE CASCADE,
  procedure_log_id BIGINT REFERENCES cath_procedure_logs(id) ON DELETE SET NULL,
  patient_uid UUID NOT NULL REFERENCES users(uid) ON DELETE RESTRICT,
  complication_code VARCHAR(80),
  complication_category VARCHAR(80) NOT NULL DEFAULT 'uncategorised',
  description TEXT,
  severity VARCHAR(30) NOT NULL DEFAULT 'unspecified',
  outcome VARCHAR(30),
  review_status VARCHAR(30) NOT NULL DEFAULT 'open',
  review_notes TEXT,
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ(6),
  occurred_at TIMESTAMPTZ(6),
  source VARCHAR(30) NOT NULL DEFAULT 'procedure_log',
  reported_by UUID,
  timeline_event_id UUID REFERENCES clinical_timeline_events(id) ON DELETE SET NULL,
  audit_event_id UUID REFERENCES clinical_audit_events(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT fk_cath_complication_registry_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT cath_complication_registry_severity_check
    CHECK (severity IN ('unspecified', 'minor', 'moderate', 'severe', 'fatal')),
  CONSTRAINT cath_complication_registry_outcome_check
    CHECK (outcome IS NULL OR outcome IN ('resolved', 'ongoing', 'sequelae', 'death', 'unknown')),
  CONSTRAINT cath_complication_registry_review_status_check
    CHECK (review_status IN ('open', 'under_review', 'reviewed', 'closed')),
  CONSTRAINT cath_complication_registry_source_check
    CHECK (source IN ('procedure_log', 'manual'))
);

CREATE INDEX IF NOT EXISTS idx_cath_complication_registry_case
  ON cath_complication_registry (tenant_id, case_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cath_complication_registry_review
  ON cath_complication_registry (tenant_id, review_status, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_cath_complication_registry_patient
  ON cath_complication_registry (tenant_id, patient_uid, created_at DESC);

ALTER TABLE cath_complication_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE cath_complication_registry FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON cath_complication_registry;
CREATE POLICY tenant_isolation ON cath_complication_registry
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

-- Register the registry as a READ-ONLY BI catalog dataset (migration-465
-- pattern). Metadata only: certification stays internal_only and the relation
-- points at the governed source table; warehouse replication enrolment
-- (ALTER PUBLICATION vh_analytics_pub) remains a separate owner decision.
INSERT INTO analytics_dataset_catalog (
  dataset_key, display_name, dbt_relation, grain, refresh_cadence, source_domain,
  owner_role, certification_status, tenant_boundary_mode, phi_class,
  min_cell_threshold, allowed_roles, export_policy, deprecation_status, description
) VALUES
  ('cath_complication_registry', 'Cath complication registry', 'public.cath_complication_registry',
   'one row per registry complication entry', 'live OLTP read (warehouse enrolment pending owner decision)',
   'clinical_quality', 'QUALITY_OFFICER', 'internal_only', 'tenant_id', 'restricted_phi',
   10, ARRAY['ADMIN','SUPER_ADMIN','CMO','MEDICAL_SUPERINTENDENT','DEPARTMENT_HEAD','QUALITY_OFFICER']::TEXT[],
   'governed_aggregate_only', 'active',
   'Structured cath-lab complication registry entries (category, severity, outcome, review status) for quality review and aggregate reporting; read-only.')
ON CONFLICT (dataset_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  dbt_relation = EXCLUDED.dbt_relation,
  grain = EXCLUDED.grain,
  refresh_cadence = EXCLUDED.refresh_cadence,
  source_domain = EXCLUDED.source_domain,
  owner_role = EXCLUDED.owner_role,
  certification_status = EXCLUDED.certification_status,
  tenant_boundary_mode = EXCLUDED.tenant_boundary_mode,
  phi_class = EXCLUDED.phi_class,
  min_cell_threshold = EXCLUDED.min_cell_threshold,
  allowed_roles = EXCLUDED.allowed_roles,
  export_policy = EXCLUDED.export_policy,
  deprecation_status = EXCLUDED.deprecation_status,
  description = EXCLUDED.description,
  updated_at = NOW();

INSERT INTO analytics_dataset_fields (
  dataset_key, field_name, display_label, semantic_type, aggregation_behavior,
  phi_class, hidden_by_default, allowed_filter, backend_drilldown_only, description
) VALUES
  ('cath_complication_registry', 'tenant_id', 'Tenant boundary', 'tenant_scope', 'required_filter', 'none', TRUE, FALSE, FALSE, 'Injected by backend embed params; not user-editable.'),
  ('cath_complication_registry', 'patient_uid', 'Patient pseudonym', 'pseudonymous_identifier', 'none', 'pseudonymous_phi', TRUE, FALSE, TRUE, 'Hidden from BI authors; backend-controlled drilldowns only.'),
  ('cath_complication_registry', 'case_id', 'Cath case reference', 'identifier', 'none', 'restricted_phi', TRUE, FALSE, TRUE, 'Case-level drilldown key; backend drilldowns must re-check tenant and role.'),
  ('cath_complication_registry', 'complication_category', 'Complication category', 'category', 'group_by', 'operational_aggregate', FALSE, TRUE, FALSE, 'Owner-taxonomy complication grouping.'),
  ('cath_complication_registry', 'severity', 'Severity', 'category', 'group_by', 'operational_aggregate', FALSE, TRUE, FALSE, 'Generic severity band for aggregate complication analysis.'),
  ('cath_complication_registry', 'outcome', 'Outcome', 'category', 'group_by', 'operational_aggregate', FALSE, TRUE, FALSE, 'Complication outcome bucket.'),
  ('cath_complication_registry', 'review_status', 'Review status', 'category', 'group_by', 'operational_aggregate', FALSE, TRUE, FALSE, 'Registry review workflow state.'),
  ('cath_complication_registry', 'occurred_at', 'Occurred at', 'event_time', 'group_by', 'operational_aggregate', FALSE, TRUE, FALSE, 'Complication occurrence timestamp for period trends.')
ON CONFLICT (dataset_key, field_name) DO UPDATE SET
  display_label = EXCLUDED.display_label,
  semantic_type = EXCLUDED.semantic_type,
  aggregation_behavior = EXCLUDED.aggregation_behavior,
  phi_class = EXCLUDED.phi_class,
  hidden_by_default = EXCLUDED.hidden_by_default,
  allowed_filter = EXCLUDED.allowed_filter,
  backend_drilldown_only = EXCLUDED.backend_drilldown_only,
  description = EXCLUDED.description;
