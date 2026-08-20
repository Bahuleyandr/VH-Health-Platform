-- 723: Analytics BI mart-expansion catalog (slate C2, NL-10 phase 3).
-- DATA-ONLY: idempotent upserts into the migration-465 governed catalog
-- tables. No DDL, no new tables, no Prisma schema impact.
--
-- What this records:
--   1. The three marts that previously omitted tenant_id
--      (mart_bed_flow_daily, mart_department_revenue_monthly,
--      mart_payer_mix_monthly) now carry it (dbt-side change in
--      infra/kubernetes/optional/analytics-warehouse/dbt) — their
--      tenant_boundary_mode moves 'internal_aggregate_no_tenant_id' →
--      'tenant_id' and the "internal embed only" caveat is dropped.
--   2. Five new tenant-bounded marts built from already-replicated tables:
--      mart_encounter_volume_daily, mart_lab_tat_daily,
--      mart_pharmacy_orders_daily, mart_collections_daily,
--      mart_claims_aging_monthly.
--   3. Four new curated dashboards over those marts. All status='active'
--      but DARK BY CONSTRUCTION: available = envId > 0
--      (analyticsCatalogService.mapDashboard), and no METABASE_DASH_* env
--      var ships set, so the admin page renders a disabled "Config" card
--      and buildEmbedUrl refuses. Embedding additionally requires the
--      settings.analyticsBi.enabled tenant gate (metabaseService).
--
-- Re-running this file is safe: every statement is ON CONFLICT DO UPDATE
-- keyed on the catalog primary keys.

INSERT INTO analytics_dataset_catalog (
  dataset_key, display_name, dbt_relation, grain, refresh_cadence, source_domain,
  owner_role, certification_status, tenant_boundary_mode, phi_class,
  min_cell_threshold, allowed_roles, export_policy, deprecation_status, description
) VALUES
  -- Amended marts: tenant boundary added dbt-side; caveat wording dropped.
  ('mart_bed_flow_daily', 'Daily bed-flow mart', 'analytics_marts.mart_bed_flow_daily', 'one row per tenant, ward, and day', 'nightly dbt after warehouse replication', 'inpatient_operations', 'CNO', 'certified', 'tenant_id', 'operational_aggregate', 10, ARRAY['ADMIN','SUPER_ADMIN','CMO','CNO','MEDICAL_SUPERINTENDENT','DEPARTMENT_HEAD','QUALITY_OFFICER']::TEXT[], 'internal_only', 'active', 'Daily occupancy and discharge-ready flow, tenant-bounded per ward and day.'),
  ('mart_department_revenue_monthly', 'Monthly department revenue mart', 'analytics_marts.mart_department_revenue_monthly', 'one row per tenant, department, and month', 'nightly dbt after warehouse replication', 'finance', 'FINANCE_INCHARGE', 'certified', 'tenant_id', 'financial', 10, ARRAY['ADMIN','SUPER_ADMIN','FINANCE_INCHARGE','BILLING_INCHARGE','CLAIMS_MANAGER','MEDICAL_SUPERINTENDENT']::TEXT[], 'internal_only', 'active', 'Department-level monthly revenue, tenant-bounded.'),
  ('mart_payer_mix_monthly', 'Monthly payer-mix mart', 'analytics_marts.mart_payer_mix_monthly', 'one row per tenant, payer class, and month', 'nightly dbt after warehouse replication', 'finance', 'FINANCE_INCHARGE', 'certified', 'tenant_id', 'financial', 10, ARRAY['ADMIN','SUPER_ADMIN','FINANCE_INCHARGE','BILLING_INCHARGE','CLAIMS_MANAGER','INSURANCE_COORDINATOR','MEDICAL_SUPERINTENDENT']::TEXT[], 'internal_only', 'active', 'Monthly payer mix and receivables, tenant-bounded.'),
  -- New marts (all read only tables already in the vh_analytics_pub publication).
  ('mart_encounter_volume_daily', 'Daily encounter volume mart', 'analytics_marts.mart_encounter_volume_daily', 'one row per tenant, day, department, and encounter type', 'nightly dbt after warehouse replication', 'clinical_operations', 'MEDICAL_SUPERINTENDENT', 'certified', 'tenant_id', 'operational_aggregate', 10, ARRAY['ADMIN','SUPER_ADMIN','CMO','CNO','MEDICAL_SUPERINTENDENT','DEPARTMENT_HEAD','QUALITY_OFFICER']::TEXT[], 'internal_only', 'active', 'OPD/IPD/ER encounter counts and average length of stay from certified encounter facts.'),
  ('mart_lab_tat_daily', 'Daily lab turnaround mart', 'analytics_marts.mart_lab_tat_daily', 'one row per tenant, day, order store, and order type', 'nightly dbt after warehouse replication', 'diagnostics', 'QUALITY_OFFICER', 'certified', 'tenant_id', 'operational_aggregate', 10, ARRAY['ADMIN','SUPER_ADMIN','CMO','QUALITY_OFFICER','LAB_INCHARGE','RADIOLOGIST','MEDICAL_SUPERINTENDENT']::TEXT[], 'internal_only', 'active', 'Ordered/completed counts, completion rate, and turnaround p50/p90 from order facts.'),
  ('mart_pharmacy_orders_daily', 'Daily pharmacy orders mart', 'analytics_marts.mart_pharmacy_orders_daily', 'one row per tenant, day, and status class', 'nightly dbt after warehouse replication', 'pharmacy_operations', 'PHARMACY_INCHARGE', 'certified', 'tenant_id', 'operational_aggregate', 10, ARRAY['ADMIN','SUPER_ADMIN','CMO','PHARMACY_INCHARGE','MEDICAL_SUPERINTENDENT','DEPARTMENT_HEAD','QUALITY_OFFICER']::TEXT[], 'internal_only', 'active', 'Pharmacy order volumes by status class. OTC counter sales are not replicated and are out of scope.'),
  ('mart_collections_daily', 'Daily collections mart', 'analytics_marts.mart_collections_daily', 'one row per tenant, day, and payment mode', 'nightly dbt after warehouse replication', 'finance', 'FINANCE_INCHARGE', 'certified', 'tenant_id', 'financial', 10, ARRAY['ADMIN','SUPER_ADMIN','FINANCE_INCHARGE','BILLING_INCHARGE','CLAIMS_MANAGER','MEDICAL_SUPERINTENDENT']::TEXT[], 'internal_only', 'active', 'Collected and reversed amounts per payment mode with same-day billed/outstanding joins.'),
  ('mart_claims_aging_monthly', 'Monthly claims aging mart', 'analytics_marts.mart_claims_aging_monthly', 'one row per tenant, submission month, claim store, and aging bucket', 'nightly dbt after warehouse replication', 'finance', 'FINANCE_INCHARGE', 'certified', 'tenant_id', 'financial', 10, ARRAY['ADMIN','SUPER_ADMIN','FINANCE_INCHARGE','BILLING_INCHARGE','CLAIMS_MANAGER','INSURANCE_COORDINATOR','MEDICAL_SUPERINTENDENT']::TEXT[], 'internal_only', 'active', 'Bucketed aging of open TPA and insurance claims (claim_store keeps the two stores distinct) plus settlement value and lag.')
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

-- 465 cataloged field rows for columns the rebuilt marts (wt/bi-warehouse)
-- no longer produce. Data-only, idempotent: harmless when already gone.
DELETE FROM analytics_dataset_fields
WHERE (dataset_key, field_name) IN (
  ('mart_bed_flow_daily', 'occupancy_rate'),
  ('mart_bed_flow_daily', 'discharge_ready_count'),
  ('mart_department_revenue_monthly', 'net_revenue'),
  ('mart_payer_mix_monthly', 'outstanding_amount')
);

-- Field rows mirror the actual model columns under
-- infra/kubernetes/optional/analytics-warehouse/dbt/models/marts/ (a
-- governed representative subset per the 465 idiom, not every column).
INSERT INTO analytics_dataset_fields (
  dataset_key, field_name, display_label, semantic_type, aggregation_behavior,
  phi_class, hidden_by_default, allowed_filter, backend_drilldown_only, description
) VALUES
  -- mart_bed_flow_daily (amended: tenant × ward × day)
  ('mart_bed_flow_daily', 'tenant_id', 'Tenant boundary', 'tenant_scope', 'required_filter', 'none', TRUE, FALSE, FALSE, 'Injected by backend embed params; not user-editable in Metabase.'),
  ('mart_bed_flow_daily', 'ward_name', 'Ward', 'category', 'group_by', 'operational_aggregate', FALSE, TRUE, FALSE, 'Ward grouping (tenant-qualified).'),
  ('mart_bed_flow_daily', 'midnight_census', 'Midnight census', 'count', 'sum', 'operational_aggregate', FALSE, TRUE, FALSE, 'Occupied beds at the day boundary (NABH occupied-bed-day convention).'),
  ('mart_bed_flow_daily', 'occupancy_pct', 'Occupancy %', 'percentage', 'average', 'operational_aggregate', FALSE, TRUE, FALSE, 'Midnight census over seeded ward beds.'),
  ('mart_bed_flow_daily', 'admissions_in', 'Admissions in', 'count', 'sum', 'operational_aggregate', FALSE, TRUE, FALSE, 'Admissions into the ward that day.'),
  ('mart_bed_flow_daily', 'discharges_out', 'Discharges out', 'count', 'sum', 'operational_aggregate', FALSE, TRUE, FALSE, 'Discharges out of the ward that day.'),
  -- mart_department_revenue_monthly (amended: tenant × department × month)
  ('mart_department_revenue_monthly', 'tenant_id', 'Tenant boundary', 'tenant_scope', 'required_filter', 'none', TRUE, FALSE, FALSE, 'Injected by backend embed params; not user-editable in Metabase.'),
  ('mart_department_revenue_monthly', 'department', 'Department', 'category', 'group_by', 'financial', FALSE, TRUE, FALSE, 'Invoice department (Unassigned when absent upstream).'),
  ('mart_department_revenue_monthly', 'net_billed', 'Net billed', 'currency', 'sum', 'financial', FALSE, TRUE, FALSE, 'Gross billed minus header discounts.'),
  ('mart_department_revenue_monthly', 'collected', 'Collected', 'currency', 'sum', 'financial', FALSE, TRUE, FALSE, 'Collections allocated to the invoice department.'),
  ('mart_department_revenue_monthly', 'outstanding', 'Outstanding', 'currency', 'sum', 'financial', FALSE, TRUE, FALSE, 'Receivable outstanding; export only through governed aggregate workflows.'),
  -- mart_payer_mix_monthly (amended: tenant × payer_class × month)
  ('mart_payer_mix_monthly', 'tenant_id', 'Tenant boundary', 'tenant_scope', 'required_filter', 'none', TRUE, FALSE, FALSE, 'Injected by backend embed params; not user-editable in Metabase.'),
  ('mart_payer_mix_monthly', 'encounters', 'Encounters', 'count', 'sum', 'financial', FALSE, TRUE, FALSE, 'Encounter volume in the payer class.'),
  ('mart_payer_mix_monthly', 'billed', 'Billed', 'currency', 'sum', 'financial', FALSE, TRUE, FALSE, 'IPD billed amount for the payer class.'),
  ('mart_payer_mix_monthly', 'claims_paid', 'Claims paid', 'currency', 'sum', 'financial', FALSE, TRUE, FALSE, 'Settled claim value (TPA + insurance).'),
  -- mart_encounter_volume_daily
  ('mart_encounter_volume_daily', 'tenant_id', 'Tenant boundary', 'tenant_scope', 'required_filter', 'none', TRUE, FALSE, FALSE, 'Injected by backend embed params; not user-editable in Metabase.'),
  ('mart_encounter_volume_daily', 'department', 'Department', 'category', 'group_by', 'operational_aggregate', FALSE, TRUE, FALSE, 'Department grouping (Unassigned when absent upstream).'),
  ('mart_encounter_volume_daily', 'encounter_type', 'Encounter type', 'category', 'group_by', 'operational_aggregate', FALSE, TRUE, FALSE, 'OPD, IPD, or ER encounter grouping.'),
  ('mart_encounter_volume_daily', 'encounters', 'Encounters', 'count', 'sum', 'operational_aggregate', FALSE, TRUE, FALSE, 'Encounters per day, department, and type.'),
  ('mart_encounter_volume_daily', 'unique_patients', 'Unique patients', 'count', 'sum', 'operational_aggregate', FALSE, TRUE, FALSE, 'Distinct pseudonymous patients in the cell.'),
  ('mart_encounter_volume_daily', 'avg_los_days', 'Average LOS (days)', 'duration_days', 'average', 'operational_aggregate', FALSE, TRUE, FALSE, 'Average length of stay (IPD rows only; null elsewhere).'),
  -- mart_lab_tat_daily
  ('mart_lab_tat_daily', 'tenant_id', 'Tenant boundary', 'tenant_scope', 'required_filter', 'none', TRUE, FALSE, FALSE, 'Injected by backend embed params; not user-editable in Metabase.'),
  ('mart_lab_tat_daily', 'order_store', 'Order store', 'category', 'group_by', 'operational_aggregate', FALSE, TRUE, FALSE, 'Clinical CPOE, pharmacy, or investigations order store.'),
  ('mart_lab_tat_daily', 'order_type', 'Order type', 'category', 'group_by', 'operational_aggregate', FALSE, TRUE, FALSE, 'Order type within the store.'),
  ('mart_lab_tat_daily', 'orders_placed', 'Orders placed', 'count', 'sum', 'operational_aggregate', FALSE, TRUE, FALSE, 'Orders placed on the day (cohort view).'),
  ('mart_lab_tat_daily', 'orders_completed', 'Orders completed', 'count', 'sum', 'operational_aggregate', FALSE, TRUE, FALSE, 'Completed orders from that day''s cohort.'),
  ('mart_lab_tat_daily', 'completion_pct', 'Completion %', 'percentage', 'average', 'operational_aggregate', FALSE, TRUE, FALSE, 'Completed share of the day''s cohort.'),
  ('mart_lab_tat_daily', 'tat_p50_hours', 'TAT p50 (hours)', 'duration_hours', 'average', 'operational_aggregate', FALSE, TRUE, FALSE, 'Median turnaround hours.'),
  ('mart_lab_tat_daily', 'tat_p90_hours', 'TAT p90 (hours)', 'duration_hours', 'average', 'operational_aggregate', FALSE, TRUE, FALSE, '90th-percentile turnaround hours.'),
  -- mart_pharmacy_orders_daily
  ('mart_pharmacy_orders_daily', 'tenant_id', 'Tenant boundary', 'tenant_scope', 'required_filter', 'none', TRUE, FALSE, FALSE, 'Injected by backend embed params; not user-editable in Metabase.'),
  ('mart_pharmacy_orders_daily', 'status_class', 'Status class', 'category', 'group_by', 'operational_aggregate', FALSE, TRUE, FALSE, 'Pharmacy order status bucket.'),
  ('mart_pharmacy_orders_daily', 'orders', 'Orders', 'count', 'sum', 'operational_aggregate', FALSE, TRUE, FALSE, 'Pharmacy orders per day and status class.'),
  ('mart_pharmacy_orders_daily', 'tat_p50_hours', 'TAT p50 (hours)', 'duration_hours', 'average', 'operational_aggregate', FALSE, TRUE, FALSE, 'Median dispense-to-delivery turnaround hours.'),
  ('mart_pharmacy_orders_daily', 'tat_p90_hours', 'TAT p90 (hours)', 'duration_hours', 'average', 'operational_aggregate', FALSE, TRUE, FALSE, '90th-percentile dispense-to-delivery turnaround hours.'),
  -- mart_collections_daily
  ('mart_collections_daily', 'tenant_id', 'Tenant boundary', 'tenant_scope', 'required_filter', 'none', TRUE, FALSE, FALSE, 'Injected by backend embed params; not user-editable in Metabase.'),
  ('mart_collections_daily', 'mode', 'Payment mode', 'category', 'group_by', 'financial', FALSE, TRUE, FALSE, 'Collection channel grouping.'),
  ('mart_collections_daily', 'collected_amount', 'Collected amount', 'currency', 'sum', 'financial', FALSE, TRUE, FALSE, 'Amount collected; export only through governed aggregate workflows.'),
  ('mart_collections_daily', 'day_net_billed', 'Net billed (day)', 'currency', 'sum', 'financial', FALSE, TRUE, FALSE, 'Same-day gross billed minus discounts.'),
  ('mart_collections_daily', 'day_outstanding', 'Outstanding (day)', 'currency', 'sum', 'financial', FALSE, TRUE, FALSE, 'Amount due on invoices issued that day.'),
  -- mart_claims_aging_monthly
  ('mart_claims_aging_monthly', 'tenant_id', 'Tenant boundary', 'tenant_scope', 'required_filter', 'none', TRUE, FALSE, FALSE, 'Injected by backend embed params; not user-editable in Metabase.'),
  ('mart_claims_aging_monthly', 'claim_store', 'Claim store', 'category', 'group_by', 'financial', FALSE, TRUE, FALSE, 'tpa_claims vs insurance_claims — the two stores are deliberately distinct.'),
  ('mart_claims_aging_monthly', 'aging_bucket', 'Aging bucket', 'category', 'group_by', 'financial', FALSE, TRUE, FALSE, 'Age-since-submission bucket, with settled/closed terminal pseudo-buckets.'),
  ('mart_claims_aging_monthly', 'claims', 'Claims', 'count', 'sum', 'financial', FALSE, TRUE, FALSE, 'Claims in the bucket.'),
  ('mart_claims_aging_monthly', 'claimed_amount', 'Claimed amount', 'currency', 'sum', 'financial', FALSE, TRUE, FALSE, 'Claimed value in the bucket; export only through governed aggregate workflows.'),
  ('mart_claims_aging_monthly', 'open_claimed_amount', 'Open claimed amount', 'currency', 'sum', 'financial', FALSE, TRUE, FALSE, 'Claimed value still open.'),
  ('mart_claims_aging_monthly', 'avg_settlement_lag_days', 'Avg settlement lag (days)', 'duration_days', 'average', 'financial', FALSE, TRUE, FALSE, 'Average submission-to-settlement lag for closed claims.')
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
  -- METABASE_DASH_LAB_TAT reuses the env name already registered in
  -- validateEnv; the other three names are registered by this branch.
  ('lab_turnaround', 'Lab Turnaround', 'Daily lab/diagnostics turnaround: ordered vs completed, completion rate, and TAT p50/p90.', 'METABASE_DASH_LAB_TAT', ARRAY['mart_lab_tat_daily','fct_orders','dim_date','dim_department']::TEXT[], ARRAY['tenant_id']::TEXT[], ARRAY['ADMIN','SUPER_ADMIN','CMO','QUALITY_OFFICER','LAB_INCHARGE','RADIOLOGIST','MEDICAL_SUPERINTENDENT']::TEXT[], 'QUALITY_OFFICER', 'active', 'certified', CURRENT_DATE, 80),
  ('pharmacy_ops', 'Pharmacy Operations', 'Pharmacy order volumes and status-class trends (OTC counter sales excluded — not replicated).', 'METABASE_DASH_PHARMACY_OPS', ARRAY['mart_pharmacy_orders_daily','dim_date']::TEXT[], ARRAY['tenant_id']::TEXT[], ARRAY['ADMIN','SUPER_ADMIN','CMO','PHARMACY_INCHARGE','MEDICAL_SUPERINTENDENT','QUALITY_OFFICER']::TEXT[], 'PHARMACY_INCHARGE', 'active', 'certified', CURRENT_DATE, 90),
  ('collections_rcm', 'Collections and Claims Aging', 'Daily collections by payment method plus bucketed aging of open TPA/insurance claims.', 'METABASE_DASH_COLLECTIONS_RCM', ARRAY['mart_collections_daily','mart_claims_aging_monthly','dim_payer','dim_date']::TEXT[], ARRAY['tenant_id']::TEXT[], ARRAY['ADMIN','SUPER_ADMIN','FINANCE_INCHARGE','BILLING_INCHARGE','CLAIMS_MANAGER','INSURANCE_COORDINATOR','MEDICAL_SUPERINTENDENT']::TEXT[], 'FINANCE_INCHARGE', 'active', 'certified', CURRENT_DATE, 100),
  ('encounter_volume', 'Encounter Volume', 'OPD/IPD/ER encounter volumes and average length of stay per department.', 'METABASE_DASH_ENCOUNTER_VOLUME', ARRAY['mart_encounter_volume_daily','fct_encounters','dim_date','dim_department']::TEXT[], ARRAY['tenant_id']::TEXT[], ARRAY['ADMIN','SUPER_ADMIN','CMO','CNO','MEDICAL_SUPERINTENDENT','DEPARTMENT_HEAD','QUALITY_OFFICER']::TEXT[], 'MEDICAL_SUPERINTENDENT', 'active', 'certified', CURRENT_DATE, 110)
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
