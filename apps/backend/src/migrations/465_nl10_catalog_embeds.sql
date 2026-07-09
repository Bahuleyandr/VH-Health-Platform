-- NL10-B2: governed dataset catalog + curated embedded dashboard catalog.
-- Catalog metadata only: these tables do not store tenant facts or patient PHI.

CREATE TABLE IF NOT EXISTS analytics_dataset_catalog (
  dataset_key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  dbt_relation TEXT NOT NULL,
  grain TEXT NOT NULL,
  refresh_cadence TEXT NOT NULL,
  source_domain TEXT NOT NULL,
  owner_role TEXT NOT NULL,
  certification_status TEXT NOT NULL,
  tenant_boundary_mode TEXT NOT NULL,
  phi_class TEXT NOT NULL,
  min_cell_threshold INTEGER NOT NULL DEFAULT 10 CHECK (min_cell_threshold >= 0),
  allowed_roles TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  export_policy TEXT NOT NULL,
  deprecation_status TEXT NOT NULL DEFAULT 'active',
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (dataset_key ~ '^[a-z0-9_]+$'),
  CHECK (certification_status IN ('certified', 'internal_only', 'held', 'deprecated')),
  CHECK (tenant_boundary_mode IN ('tenant_id', 'pseudonymous_tenant_id', 'internal_aggregate_no_tenant_id', 'approved_global_dimension')),
  CHECK (phi_class IN ('none', 'operational_aggregate', 'restricted_phi', 'pseudonymous_phi', 'financial')),
  CHECK (export_policy IN ('blocked', 'internal_only', 'governed_aggregate_only')),
  CHECK (deprecation_status IN ('active', 'deprecated'))
);

CREATE TABLE IF NOT EXISTS analytics_dataset_fields (
  dataset_key TEXT NOT NULL REFERENCES analytics_dataset_catalog(dataset_key) ON DELETE CASCADE,
  field_name TEXT NOT NULL,
  display_label TEXT NOT NULL,
  semantic_type TEXT NOT NULL,
  aggregation_behavior TEXT NOT NULL,
  phi_class TEXT NOT NULL,
  hidden_by_default BOOLEAN NOT NULL DEFAULT FALSE,
  allowed_filter BOOLEAN NOT NULL DEFAULT TRUE,
  backend_drilldown_only BOOLEAN NOT NULL DEFAULT FALSE,
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (dataset_key, field_name),
  CHECK (field_name ~ '^[a-zA-Z0-9_]+$'),
  CHECK (phi_class IN ('none', 'operational_aggregate', 'restricted_phi', 'pseudonymous_phi', 'financial'))
);

CREATE TABLE IF NOT EXISTS analytics_dashboard_catalog (
  dashboard_key TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  metabase_env_var TEXT NOT NULL,
  dataset_keys TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  required_params TEXT[] NOT NULL DEFAULT ARRAY['tenant_id']::TEXT[],
  embed_roles TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  owner_role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  certification_status TEXT NOT NULL DEFAULT 'certified',
  last_certified_at DATE NOT NULL DEFAULT CURRENT_DATE,
  display_order INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (dashboard_key ~ '^[a-z0-9_]+$'),
  CHECK (status IN ('active', 'held', 'deprecated')),
  CHECK (certification_status IN ('certified', 'internal_only', 'held', 'deprecated'))
);

CREATE INDEX IF NOT EXISTS idx_analytics_dataset_catalog_domain
  ON analytics_dataset_catalog(source_domain, display_name);
CREATE INDEX IF NOT EXISTS idx_analytics_dataset_fields_hidden
  ON analytics_dataset_fields(dataset_key, hidden_by_default, backend_drilldown_only);
CREATE INDEX IF NOT EXISTS idx_analytics_dashboard_catalog_status_order
  ON analytics_dashboard_catalog(status, display_order, dashboard_key);
CREATE INDEX IF NOT EXISTS idx_analytics_dashboard_catalog_dataset_keys
  ON analytics_dashboard_catalog USING GIN(dataset_keys);

INSERT INTO analytics_dataset_catalog (
  dataset_key, display_name, dbt_relation, grain, refresh_cadence, source_domain,
  owner_role, certification_status, tenant_boundary_mode, phi_class,
  min_cell_threshold, allowed_roles, export_policy, deprecation_status, description
) VALUES
  ('dim_date', 'Date dimension', 'analytics_marts.dim_date', 'one row per calendar date', 'nightly dbt after warehouse replication', 'reference', 'QUALITY_OFFICER', 'certified', 'approved_global_dimension', 'none', 0, ARRAY['ADMIN','SUPER_ADMIN','CMO','CNO','MEDICAL_SUPERINTENDENT','DEPARTMENT_HEAD','QUALITY_OFFICER','FINANCE_INCHARGE']::TEXT[], 'internal_only', 'active', 'Calendar attributes used to align certified BI trends.'),
  ('dim_department', 'Department dimension', 'analytics_marts.dim_department', 'one row per department', 'nightly dbt after warehouse replication', 'operations', 'MEDICAL_SUPERINTENDENT', 'certified', 'tenant_id', 'none', 0, ARRAY['ADMIN','SUPER_ADMIN','CMO','CNO','MEDICAL_SUPERINTENDENT','DEPARTMENT_HEAD','QUALITY_OFFICER','FINANCE_INCHARGE']::TEXT[], 'internal_only', 'active', 'Department labels for operational and finance marts.'),
  ('dim_doctor', 'Doctor dimension', 'analytics_marts.dim_doctor', 'one row per clinician pseudonym', 'nightly dbt after warehouse replication', 'clinical_operations', 'CMO', 'certified', 'tenant_id', 'restricted_phi', 10, ARRAY['ADMIN','SUPER_ADMIN','CMO','MEDICAL_SUPERINTENDENT','DEPARTMENT_HEAD','QUALITY_OFFICER']::TEXT[], 'governed_aggregate_only', 'active', 'Clinician dimension for aggregate operations; direct identifiers stay governed.'),
  ('dim_patient', 'Patient demographic dimension', 'analytics_marts.dim_patient', 'one row per pseudonymous patient', 'nightly dbt after warehouse replication', 'patient_demographics', 'DATA_PROTECTION_OFFICER', 'internal_only', 'pseudonymous_tenant_id', 'pseudonymous_phi', 20, ARRAY['ADMIN','SUPER_ADMIN','CMO','DATA_PROTECTION_OFFICER']::TEXT[], 'blocked', 'active', 'Age-banded, pseudonymous demographic dimension; patient_uid is backend-drilldown only.'),
  ('dim_payer', 'Payer dimension', 'analytics_marts.dim_payer', 'one row per payer class or payer', 'nightly dbt after warehouse replication', 'finance', 'FINANCE_INCHARGE', 'certified', 'tenant_id', 'financial', 10, ARRAY['ADMIN','SUPER_ADMIN','FINANCE_INCHARGE','BILLING_INCHARGE','CLAIMS_MANAGER','INSURANCE_COORDINATOR','MEDICAL_SUPERINTENDENT']::TEXT[], 'governed_aggregate_only', 'active', 'Payer grouping for revenue and payer-mix analysis.'),
  ('fct_encounters', 'Encounter fact', 'analytics_marts.fct_encounters', 'one row per encounter', 'nightly dbt after warehouse replication', 'clinical_operations', 'MEDICAL_SUPERINTENDENT', 'internal_only', 'tenant_id', 'restricted_phi', 20, ARRAY['ADMIN','SUPER_ADMIN','CMO','CNO','MEDICAL_SUPERINTENDENT','DEPARTMENT_HEAD','QUALITY_OFFICER']::TEXT[], 'governed_aggregate_only', 'active', 'Encounter volumes for OPD, IPD, and ER metrics.'),
  ('fct_orders', 'Diagnostic and service order fact', 'analytics_marts.fct_orders', 'one row per diagnostic or service order', 'nightly dbt after warehouse replication', 'diagnostics', 'QUALITY_OFFICER', 'internal_only', 'tenant_id', 'restricted_phi', 20, ARRAY['ADMIN','SUPER_ADMIN','CMO','QUALITY_OFFICER','LAB_INCHARGE','RADIOLOGIST','MEDICAL_SUPERINTENDENT']::TEXT[], 'governed_aggregate_only', 'active', 'Order and turnaround metrics for lab, radiology, and service-line exceptions.'),
  ('fct_revenue', 'Revenue line fact', 'analytics_marts.fct_revenue', 'one row per invoice line', 'nightly dbt after warehouse replication', 'finance', 'FINANCE_INCHARGE', 'internal_only', 'tenant_id', 'financial', 10, ARRAY['ADMIN','SUPER_ADMIN','FINANCE_INCHARGE','BILLING_INCHARGE','CLAIMS_MANAGER','INSURANCE_COORDINATOR','MEDICAL_SUPERINTENDENT']::TEXT[], 'governed_aggregate_only', 'active', 'Invoice-line revenue fact for certified finance dashboards.'),
  ('mart_bed_flow_daily', 'Daily bed-flow mart', 'analytics_marts.mart_bed_flow_daily', 'one row per day and bed-flow aggregate', 'nightly dbt after warehouse replication', 'inpatient_operations', 'CNO', 'certified', 'internal_aggregate_no_tenant_id', 'operational_aggregate', 10, ARRAY['ADMIN','SUPER_ADMIN','CMO','CNO','MEDICAL_SUPERINTENDENT','DEPARTMENT_HEAD','QUALITY_OFFICER']::TEXT[], 'internal_only', 'active', 'Daily occupancy and discharge-ready flow; internal embed only until tenant boundary is added or wrapped.'),
  ('mart_ot_utilization_daily', 'Daily OT utilization mart', 'analytics_marts.mart_ot_utilization_daily', 'one row per theatre and day', 'nightly dbt after warehouse replication', 'theatre_operations', 'CMO', 'certified', 'tenant_id', 'operational_aggregate', 10, ARRAY['ADMIN','SUPER_ADMIN','CMO','MEDICAL_SUPERINTENDENT','DEPARTMENT_HEAD','QUALITY_OFFICER']::TEXT[], 'internal_only', 'active', 'OT utilization, late starts, and scheduled-versus-used minutes.'),
  ('mart_department_revenue_monthly', 'Monthly department revenue mart', 'analytics_marts.mart_department_revenue_monthly', 'one row per department and month', 'nightly dbt after warehouse replication', 'finance', 'FINANCE_INCHARGE', 'certified', 'internal_aggregate_no_tenant_id', 'financial', 10, ARRAY['ADMIN','SUPER_ADMIN','FINANCE_INCHARGE','BILLING_INCHARGE','CLAIMS_MANAGER','MEDICAL_SUPERINTENDENT']::TEXT[], 'internal_only', 'active', 'Department-level monthly revenue; internal embed only until tenant boundary is added or wrapped.'),
  ('mart_payer_mix_monthly', 'Monthly payer-mix mart', 'analytics_marts.mart_payer_mix_monthly', 'one row per payer class and month', 'nightly dbt after warehouse replication', 'finance', 'FINANCE_INCHARGE', 'certified', 'internal_aggregate_no_tenant_id', 'financial', 10, ARRAY['ADMIN','SUPER_ADMIN','FINANCE_INCHARGE','BILLING_INCHARGE','CLAIMS_MANAGER','INSURANCE_COORDINATOR','MEDICAL_SUPERINTENDENT']::TEXT[], 'internal_only', 'active', 'Monthly payer mix and receivables; internal embed only until tenant boundary is added or wrapped.')
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
  ('dim_patient', 'patient_uid', 'Patient pseudonym', 'pseudonymous_identifier', 'none', 'pseudonymous_phi', TRUE, FALSE, TRUE, 'Hidden from BI authors; available only to backend-controlled drilldowns.'),
  ('dim_patient', 'age_band', 'Age band', 'demographic_bucket', 'group_by', 'pseudonymous_phi', FALSE, TRUE, FALSE, 'Age band suitable for aggregate demographic analysis.'),
  ('dim_patient', 'gender', 'Gender', 'demographic_bucket', 'group_by', 'pseudonymous_phi', FALSE, TRUE, FALSE, 'Demographic grouping; suppress small cells before export.'),
  ('fct_encounters', 'patient_uid', 'Patient pseudonym', 'pseudonymous_identifier', 'none', 'pseudonymous_phi', TRUE, FALSE, TRUE, 'Hidden from BI authors; backend drilldowns must re-check tenant and role.'),
  ('fct_encounters', 'tenant_id', 'Tenant boundary', 'tenant_scope', 'required_filter', 'none', TRUE, FALSE, FALSE, 'Injected by backend embed params; not user-editable in Metabase.'),
  ('fct_encounters', 'encounter_type', 'Encounter type', 'category', 'group_by', 'operational_aggregate', FALSE, TRUE, FALSE, 'OPD, IPD, ER, and adjacent encounter grouping.'),
  ('fct_orders', 'patient_uid', 'Patient pseudonym', 'pseudonymous_identifier', 'none', 'pseudonymous_phi', TRUE, FALSE, TRUE, 'Hidden from BI authors; backend drilldowns only.'),
  ('fct_orders', 'tenant_id', 'Tenant boundary', 'tenant_scope', 'required_filter', 'none', TRUE, FALSE, FALSE, 'Injected by backend embed params; not user-editable in Metabase.'),
  ('fct_orders', 'order_status', 'Order status', 'category', 'group_by', 'operational_aggregate', FALSE, TRUE, FALSE, 'Status bucket for turnaround exception analytics.'),
  ('fct_revenue', 'patient_uid', 'Patient pseudonym', 'pseudonymous_identifier', 'none', 'pseudonymous_phi', TRUE, FALSE, TRUE, 'Hidden from finance BI authors; backend-controlled drilldowns only.'),
  ('fct_revenue', 'tenant_id', 'Tenant boundary', 'tenant_scope', 'required_filter', 'none', TRUE, FALSE, FALSE, 'Injected by backend embed params; not user-editable in Metabase.'),
  ('fct_revenue', 'net_amount', 'Net amount', 'currency', 'sum', 'financial', FALSE, FALSE, FALSE, 'Financial measure; export only through governed aggregate workflows.'),
  ('mart_bed_flow_daily', 'occupancy_rate', 'Occupancy rate', 'percentage', 'average', 'operational_aggregate', FALSE, TRUE, FALSE, 'Aggregate bed occupancy trend.'),
  ('mart_bed_flow_daily', 'discharge_ready_count', 'Discharge-ready count', 'count', 'sum', 'operational_aggregate', FALSE, TRUE, FALSE, 'Aggregate discharge-readiness flow.'),
  ('mart_ot_utilization_daily', 'utilization_minutes', 'Utilization minutes', 'duration_minutes', 'sum', 'operational_aggregate', FALSE, TRUE, FALSE, 'Theatre minutes used.'),
  ('mart_ot_utilization_daily', 'late_start_count', 'Late starts', 'count', 'sum', 'operational_aggregate', FALSE, TRUE, FALSE, 'Late-start exception count.'),
  ('mart_department_revenue_monthly', 'net_revenue', 'Net revenue', 'currency', 'sum', 'financial', FALSE, TRUE, FALSE, 'Department-level monthly net revenue.'),
  ('mart_payer_mix_monthly', 'payer_class', 'Payer class', 'category', 'group_by', 'financial', FALSE, TRUE, FALSE, 'Payer grouping for mix analysis.'),
  ('mart_payer_mix_monthly', 'outstanding_amount', 'Outstanding amount', 'currency', 'sum', 'financial', FALSE, TRUE, FALSE, 'Receivables measure for executive finance review.')
ON CONFLICT (dataset_key, field_name) DO UPDATE SET
  display_label = EXCLUDED.display_label,
  semantic_type = EXCLUDED.semantic_type,
  aggregation_behavior = EXCLUDED.aggregation_behavior,
  phi_class = EXCLUDED.phi_class,
  hidden_by_default = EXCLUDED.hidden_by_default,
  allowed_filter = EXCLUDED.allowed_filter,
  backend_drilldown_only = EXCLUDED.backend_drilldown_only,
  description = EXCLUDED.description;

INSERT INTO analytics_dashboard_catalog (
  dashboard_key, title, description, metabase_env_var, dataset_keys, required_params,
  embed_roles, owner_role, status, certification_status, last_certified_at, display_order
) VALUES
  ('daily_ops', 'Daily Operations Snapshot', 'OPD, IPD, ER, collections, and exception counts for the executive huddle.', 'METABASE_DASH_DAILY_OPS', ARRAY['fct_encounters','mart_bed_flow_daily','fct_revenue','fct_orders']::TEXT[], ARRAY['tenant_id']::TEXT[], ARRAY['ADMIN','SUPER_ADMIN','CMO','CNO','MEDICAL_SUPERINTENDENT','DEPARTMENT_HEAD','QUALITY_OFFICER']::TEXT[], 'MEDICAL_SUPERINTENDENT', 'active', 'certified', CURRENT_DATE, 10),
  ('patient_flow', 'Bed Flow and Occupancy', 'Bed occupancy, discharge-ready flow, and inpatient movement trends.', 'METABASE_DASH_BED_FLOW', ARRAY['mart_bed_flow_daily','fct_encounters','dim_date','dim_department']::TEXT[], ARRAY['tenant_id']::TEXT[], ARRAY['ADMIN','SUPER_ADMIN','CMO','CNO','MEDICAL_SUPERINTENDENT','DEPARTMENT_HEAD','QUALITY_OFFICER']::TEXT[], 'CNO', 'active', 'internal_only', CURRENT_DATE, 20),
  ('theatre_utilization', 'OT Utilization and Late Starts', 'Theatre utilization, late starts, and scheduled-versus-used capacity.', 'METABASE_DASH_OT_UTILIZATION', ARRAY['mart_ot_utilization_daily','dim_date','dim_department','dim_doctor']::TEXT[], ARRAY['tenant_id']::TEXT[], ARRAY['ADMIN','SUPER_ADMIN','CMO','MEDICAL_SUPERINTENDENT','DEPARTMENT_HEAD','QUALITY_OFFICER']::TEXT[], 'CMO', 'active', 'certified', CURRENT_DATE, 30),
  ('revenue_payer_mix', 'Revenue and Payer Mix', 'Department revenue, payer mix, collections, and receivables for finance review.', 'METABASE_DASH_REVENUE_PAYER_MIX', ARRAY['fct_revenue','mart_department_revenue_monthly','mart_payer_mix_monthly','dim_payer','dim_date']::TEXT[], ARRAY['tenant_id']::TEXT[], ARRAY['ADMIN','SUPER_ADMIN','FINANCE_INCHARGE','BILLING_INCHARGE','CLAIMS_MANAGER','INSURANCE_COORDINATOR','MEDICAL_SUPERINTENDENT']::TEXT[], 'FINANCE_INCHARGE', 'active', 'certified', CURRENT_DATE, 40),
  ('orders_turnaround', 'Orders and Turnaround Exceptions', 'Lab, radiology, and service-order turnaround exceptions from certified order facts.', 'METABASE_DASH_ORDERS_TAT', ARRAY['fct_orders','dim_department','dim_doctor','dim_date']::TEXT[], ARRAY['tenant_id']::TEXT[], ARRAY['ADMIN','SUPER_ADMIN','CMO','QUALITY_OFFICER','LAB_INCHARGE','RADIOLOGIST','MEDICAL_SUPERINTENDENT']::TEXT[], 'QUALITY_OFFICER', 'active', 'internal_only', CURRENT_DATE, 50),
  ('quality_feedback', 'Quality Feedback and NPS', 'Held until NL-9 survey aggregates are certified into the warehouse catalog.', 'METABASE_DASH_QUALITY_FEEDBACK', ARRAY[]::TEXT[], ARRAY['tenant_id']::TEXT[], ARRAY['ADMIN','SUPER_ADMIN','QUALITY_OFFICER','MEDICAL_SUPERINTENDENT']::TEXT[], 'QUALITY_OFFICER', 'held', 'held', CURRENT_DATE, 60),
  ('operational_ai_alerts', 'Operational AI Alert Counts', 'Held until Tier-H operational AI aggregates are catalog-certified and tenant-safe.', 'METABASE_DASH_OPERATIONAL_AI_ALERTS', ARRAY[]::TEXT[], ARRAY['tenant_id']::TEXT[], ARRAY['ADMIN','SUPER_ADMIN','AI_GOVERNANCE_ADMIN','CMO','MEDICAL_SUPERINTENDENT']::TEXT[], 'AI_GOVERNANCE_ADMIN', 'held', 'held', CURRENT_DATE, 70)
ON CONFLICT (dashboard_key) DO UPDATE SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  metabase_env_var = EXCLUDED.metabase_env_var,
  dataset_keys = EXCLUDED.dataset_keys,
  required_params = EXCLUDED.required_params,
  embed_roles = EXCLUDED.embed_roles,
  owner_role = EXCLUDED.owner_role,
  status = EXCLUDED.status,
  certification_status = EXCLUDED.certification_status,
  last_certified_at = EXCLUDED.last_certified_at,
  display_order = EXCLUDED.display_order,
  updated_at = NOW();
