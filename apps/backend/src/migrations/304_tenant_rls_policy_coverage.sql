-- 304_tenant_rls_policy_coverage.sql
--
-- Audit finding DB-1 (B1.2 RLS policy coverage + B1.1 FORCE RLS).
--
-- Migrations 075 / 236 / 238 / 239 / 262 / 272 / 276 / 279–283 / 285–286 /
-- 289–294 / 296–297 / 299–300 each closed a slice of tenant-RLS coverage,
-- but they grew table-by-table. A full audit of prisma/schema.prisma vs
-- pg_policies (2026-06-13) found that of the ~386 tables carrying a
-- `tenant_id` column, only 94 had a `tenant_isolation` RLS policy — leaving
-- 283 tenant-owned PHI / clinical / financial / operational tables with
-- ZERO database-level tenant isolation. When AUTH_ENFORCE_TENANT_RLS=true
-- (set on dalekdefender 2026-05-19) those 283 tables were silently
-- cross-tenant readable/writable for any code path that did NOT manually
-- filter by tenant_id. This migration closes the whole gap in one pass.
--
-- Scope decision (B1.2):
--   * POLICY every base table that carries a `tenant_id` column and lacks a
--     tenant_isolation policy. The schema authors only put `tenant_id` on
--     tables that are tenant-owned, so column presence is the isolation
--     signal — verified: genuinely global reference/catalog tables
--     (icd10_codes, terminology_concepts/_systems, drug masters, the seeded
--     clinical_protocols, investigation_test_catalog, etc.) deliberately
--     carry NO tenant_id and therefore never enter this set. Tables whose
--     name hints "catalog/master/reference" but DO carry tenant_id
--     (clinical_trials_catalog, vaccine_catalogue, pmjay_packages,
--     or_procedure_catalog, service_catalog, lab_reference_ranges, the
--     *_counter / numbering_series sequence allocators, …) are per-tenant
--     configuration — each has tenant_id in its natural key
--     (@@unique([tenant_id, …])) — so they ARE policied. Seeded global rows
--     land in the default tenant and stay readable while the GUC is unset
--     (permissive branch), so seeding/lookup is unaffected.
--
-- EXPLICITLY SKIPPED (intentionally cross-tenant — NOT policied here):
--   * All true global reference / terminology / catalog / code-system tables
--     — they self-exclude by carrying no tenant_id column, so they are not
--     in the array below (icd10_codes, terminology_concepts,
--     terminology_systems, drug_master/drug_catalog, loinc/snomed/cpt/icd
--     code tables, investigation_test_catalog, medication_catalog, the
--     seeded clinical_protocols master, etc.).
--   * Reporting VIEWs / materialized views that surface a tenant_id from
--     their base tables (antibiogram_90d, billing_daily_collection,
--     bmw_monthly_rollup, dialysis_adequacy_30d, dialysis_today,
--     icu_bundle_30d, mortality_30d_summary, pharmacy_schedule_register_full,
--     tpa_claims_aging). RLS is a base-table mechanism — a view enforces
--     isolation through the RLS on the tables it reads, so policying the
--     view is neither possible nor needed. (They appear in
--     information_schema.columns but not as relkind='r'/'p'.)
--
-- B1.1 — FORCE ROW LEVEL SECURITY is applied to every table here, because
-- prod (CloudNativePG) connects as the table OWNER (`vhhealth`), and without
-- FORCE Postgres exempts the owner so the policy is silently inert. This
-- mirrors migrations 238/239/272's FORCE step. It also repairs two tables
-- found in a half-built state (clinical_ai_decision_memory,
-- clinical_ai_workflow_runs) where RLS was ENABLEd by an earlier migration
-- but no policy was ever created — under FORCE that is a deny-all, which the
-- permissive policy installed here corrects.
--
-- Policy shape is byte-for-byte the repo's existing one (075 / 236 / 238 /
-- 239): permissive when `app.current_tenant_id` is unset / '' / 'bypass'
-- (so untenanted system queries, seeds, and the existing test suite keep
-- working — this is deliberate, do NOT tighten it here), else strict
-- `tenant_id = app_current_tenant_id_uuid()`. Enforcement is activated per
-- request by setTenant() (src/lib/prisma.js) under AUTH_ENFORCE_TENANT_RLS.
--
-- Idempotent: ENABLE/FORCE are no-ops when already set; the policy is created
-- only when absent from pg_policies; the tenant_id index is created only when
-- no tenant_id-leading index already exists (247 of these tables already
-- carry a composite (tenant_id, …) index — we do not duplicate it). Re-runs
-- are safe.

BEGIN;

-- ---------------------------------------------------------------------------
-- Helper (defensive). Identical to migration 075. Created ONLY when absent so
-- this migration is self-contained on a DB that somehow lacks it, WITHOUT
-- requiring ownership of an already-existing function: 075 created it as the
-- prod table owner, and a re-create as a different deploy role (e.g. the QA
-- `qa_writer`) would fail "must be owner of function". The rest of this
-- migration only needs table ownership (ALTER TABLE / CREATE POLICY / CREATE
-- INDEX), so we never touch the function when it already exists. Returns NULL
-- for unset / '' / 'bypass' so the policy OR-chain never casts a non-uuid GUC.
-- ---------------------------------------------------------------------------
DO $bootstrap$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.proname = 'app_current_tenant_id_uuid'
       AND n.nspname = 'public'
  ) THEN
    EXECUTE $fn$
      CREATE FUNCTION app_current_tenant_id_uuid()
      RETURNS uuid
      LANGUAGE sql
      STABLE
      AS $body$
        SELECT CASE
          WHEN current_setting('app.current_tenant_id', true) IS NULL THEN NULL
          WHEN current_setting('app.current_tenant_id', true) = '' THEN NULL
          WHEN current_setting('app.current_tenant_id', true) = 'bypass' THEN NULL
          ELSE current_setting('app.current_tenant_id', true)::uuid
        END
      $body$
    $fn$;
  END IF;
END
$bootstrap$;

-- ---------------------------------------------------------------------------
-- ENABLE + FORCE RLS, install tenant_isolation policy (if absent), and create
-- a tenant_id index (only if no tenant_id-leading index exists) for every
-- tenant-owned base table that still lacks the policy.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  policied int := 0;
  forced int := 0;
  indexed int := 0;
  skipped_missing int := 0;
  tenant_tables text[] := ARRAY[
    'abdm_care_contexts', 'abdm_consent_artifacts', 'abdm_consent_requests',
    'abdm_data_transfers', 'abdm_facility_mappings', 'abdm_practitioner_mappings',
    'abdm_webhook_events', 'abha_profiles', 'advance_deposits',
    'ambulance_requests', 'anesthesia_chart_entries', 'anesthesia_records',
    'api_clients', 'api_keys', 'appointment_queue_status_history',
    'appointment_queues', 'approvals', 'attendant_passes',
    'automation_rules', 'bed_inspections', 'billing_advances',
    'billing_invoice_counter', 'billing_invoices', 'billing_payment_links',
    'billing_payments', 'billing_refunds', 'billing_service_master',
    'bmw_waste_log', 'bookable_resources', 'care_plan_activities',
    'care_plan_goals', 'care_plan_review_log', 'care_plans',
    'care_team_member_status_history', 'care_team_members', 'care_team_status_history',
    'care_teams', 'cash_drawer_sessions', 'chat_session_messages',
    'chat_sessions', 'clinical_ai_acuity_staffing_forecasts', 'clinical_ai_agent_health_reports',
    'clinical_ai_agent_registry', 'clinical_ai_antimicrobial_reviews', 'clinical_ai_appeal_letters',
    'clinical_ai_bed_turnover_predictions', 'clinical_ai_biomed_devices', 'clinical_ai_biomed_maintenance_predictions',
    'clinical_ai_blood_bank_forecast_reviews', 'clinical_ai_blood_bank_inventory_snapshots', 'clinical_ai_canary_cases',
    'clinical_ai_canary_runs', 'clinical_ai_charge_capture_audits', 'clinical_ai_chart_gap_audits',
    'clinical_ai_command_center_snapshots', 'clinical_ai_corpus', 'clinical_ai_decision_memory',
    'clinical_ai_deterioration_snapshots', 'clinical_ai_ed_triage_predictions', 'clinical_ai_explainability_reports',
    'clinical_ai_family_updates', 'clinical_ai_federation_rounds', 'clinical_ai_federation_sites',
    'clinical_ai_imaging_findings', 'clinical_ai_imaging_studies', 'clinical_ai_infection_control_audits',
    'clinical_ai_inventory_alerts', 'clinical_ai_kg_edges', 'clinical_ai_kg_health_reports',
    'clinical_ai_kg_nodes', 'clinical_ai_lab_autoverifications', 'clinical_ai_labeling_annotations',
    'clinical_ai_labeling_tasks', 'clinical_ai_model_eval_runs', 'clinical_ai_model_registry',
    'clinical_ai_no_show_predictions', 'clinical_ai_obstetric_risk_assessments', 'clinical_ai_ot_block_suggestions',
    'clinical_ai_ot_duration_predictions', 'clinical_ai_pathway_bundle_audits', 'clinical_ai_patient_genotypes',
    'clinical_ai_patient_timeline_snapshots', 'clinical_ai_payer_contracts', 'clinical_ai_payer_variance_reviews',
    'clinical_ai_pediatric_dose_checks', 'clinical_ai_pgx_advisories', 'clinical_ai_policy_diffs',
    'clinical_ai_polypharmacy_reviews', 'clinical_ai_prior_auth_requests', 'clinical_ai_privacy_sentinel_audits',
    'clinical_ai_procurement_opportunities', 'clinical_ai_prompt_assignments', 'clinical_ai_prompt_experiments',
    'clinical_ai_radiology_report_reviews', 'clinical_ai_radiology_worklist_priorities', 'clinical_ai_rca_drafts',
    'clinical_ai_roi_snapshots', 'clinical_ai_security_anomalies', 'clinical_ai_self_healing_runs',
    'clinical_ai_sepsis_bundle_audits', 'clinical_ai_staff_burnout_reviews', 'clinical_ai_synthetic_cases',
    'clinical_ai_task_candidates', 'clinical_ai_teach_back_sessions', 'clinical_ai_training_modules',
    'clinical_ai_translations', 'clinical_ai_trial_sync_runs', 'clinical_ai_ventilator_bundle_audits',
    'clinical_ai_voice_ivr_sessions', 'clinical_ai_workflow_runs', 'clinical_ambient_encounters',
    'clinical_audit_events', 'clinical_document_extraction_events', 'clinical_document_intake',
    'clinical_longitudinal_risk', 'clinical_nursing_ambient_sessions', 'clinical_order_set_applications',
    'clinical_order_sets', 'clinical_timeline_events', 'clinical_trial_match_results',
    'clinical_trials_catalog', 'clinical_voice_notes', 'data_processing_activities',
    'data_retention_policies', 'death_records', 'dialysis_patients',
    'dialysis_sessions', 'discharge_summaries', 'discharge_summary_templates',
    'drug_return_batches', 'drug_return_serial_counter', 'encryption_keys',
    'escalation_rules', 'external_system_mappings', 'facilities',
    'facility_locations', 'facility_rooms', 'fall_risk_assessments',
    'follow_up_plans', 'growth_charts', 'icu_admissions',
    'icu_assessments', 'icu_daily_bundles', 'icu_flowsheet_entries',
    'idempotency_keys', 'incident_reports', 'insurance_policies',
    'insurance_preauth', 'insurance_preauth_counter', 'integration_credentials',
    'integration_logs', 'integrations', 'intraop_notes',
    'knowledge_access_policies', 'knowledge_bases', 'knowledge_chunks',
    'knowledge_documents', 'knowledge_retrieval_logs', 'lab_analyzer_qc_runs',
    'lab_analyzer_status_history', 'lab_analyzers', 'lab_critical_alerts',
    'lab_critical_thresholds', 'lab_pathologist_signoffs', 'lab_reference_ranges',
    'lab_results', 'lab_specimen_status_history', 'lab_specimens',
    'maternity_anc_advice', 'maternity_anc_visits', 'maternity_deliveries',
    'maternity_fetal_kicks', 'maternity_labor_admissions', 'maternity_newborns',
    'maternity_partograph_entries', 'maternity_postnatal_visits', 'maternity_pregnancies',
    'maternity_supplements', 'mccd_serial_counter', 'medication_safety_reviews',
    'mfa_backup_codes', 'mfa_challenges', 'mfa_devices',
    'micro_orders', 'mlc_records', 'mortality_reviews',
    'newborn_immunisations', 'notification_events', 'notifications',
    'numbering_series', 'nursing_assessments', 'or_procedure_catalog',
    'or_rooms', 'package_items', 'packages',
    'pain_assessments', 'patient_access_audit_log', 'patient_access_break_glass',
    'patient_access_break_glass_status_history', 'patient_chat_conversations', 'patient_chat_messages',
    'patient_duplicate_candidates', 'patient_encounters', 'patient_identifiers',
    'patient_immunisations', 'patient_merge_requests', 'patient_message_threads',
    'patient_messages', 'payer_tariff_links', 'payers',
    'pcpndt_form_f', 'pcpndt_serial_counter', 'pcpndt_sonologists',
    'pcpndt_submissions', 'pcpndt_usg_machines', 'pharmacy_expiry_alerts',
    'pharmacy_expiry_scan_cache', 'pharmacy_goods_receipt_items', 'pharmacy_goods_receipts',
    'pharmacy_inventory_batches', 'pharmacy_inventory_items', 'pharmacy_purchase_order_items',
    'pharmacy_purchase_orders', 'pharmacy_schedule_register', 'pharmacy_stock_movements',
    'pharmacy_substitutes', 'pharmacy_suppliers', 'pmjay_beneficiaries',
    'pmjay_case_counter', 'pmjay_cases', 'pmjay_packages',
    'postop_complication_alerts', 'postop_notes', 'preop_checklists',
    'provider_availability_templates', 'provider_leaves', 'remote_prescriptions',
    'roster_calendar_events', 'roster_weather_signals', 'service_catalog',
    'sla_definitions', 'smart_access_tokens', 'smart_apps',
    'smart_authz_codes', 'smart_phrases', 'staff_access_audit_log',
    'staff_commute_profile_audit', 'staff_commute_profiles', 'staff_credentials',
    'staff_grievances', 'staff_leave_forecast_audit', 'staff_leave_forecast_runs',
    'staff_leave_forecast_scores', 'staff_leave_forecast_shift_risks', 'staff_queries',
    'staff_roster_preferences', 'staff_roster_runs', 'surgical_implants',
    'surgical_safety_checklists', 'tariff_items', 'tariff_plans',
    'task_comments', 'tasks', 'teleconsult_provider_configs',
    'teleconsultations', 'tpa_claim_counter', 'tpa_claim_line_decisions',
    'tpa_claims', 'tpas', 'triage_assessments',
    'vaccine_catalogue', 'video_sessions', 'virtual_ward_check_ins',
    'virtual_ward_enrollments', 'virtual_ward_escalations', 'ward_indents',
    'webhook_deliveries', 'webhook_subscriptions', 'workflow_definitions',
    'workflow_runs', 'workflow_sla_instances', 'workflow_sla_rules',
    'workflow_steps'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    -- Only operate on a real ordinary/partitioned table that actually exists
    -- AND carries a tenant_id column. Skip gracefully otherwise so the
    -- migration is robust across partially-migrated DBs.
    IF NOT EXISTS (
      SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = t
         AND c.relkind IN ('r', 'p')
    ) THEN
      skipped_missing := skipped_missing + 1;
      RAISE NOTICE 'migration 304: skipping % (not a base table here)', t;
      CONTINUE;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = t AND column_name = 'tenant_id'
    ) THEN
      skipped_missing := skipped_missing + 1;
      RAISE NOTICE 'migration 304: skipping % (no tenant_id column here)', t;
      CONTINUE;
    END IF;

    -- B1.1 — ENABLE + FORCE (FORCE so the table OWNER in prod is not exempt).
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = t AND c.relforcerowsecurity
    ) THEN
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
      forced := forced + 1;
    END IF;

    -- B1.2 — install the canonical tenant_isolation policy only when absent.
    -- (Mirrors 075/236/238/239 USING + WITH CHECK byte-for-byte.)
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = t AND policyname = 'tenant_isolation'
    ) THEN
      EXECUTE format($f$
        CREATE POLICY tenant_isolation ON %I
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
          )
      $f$, t);
      policied := policied + 1;
    END IF;

    -- Performance — ensure a tenant_id-leading index exists for the policy's
    -- equality predicate. Skip when one already does (most of these tables
    -- already carry a composite (tenant_id, …) index under a different name).
    IF NOT EXISTS (
      SELECT 1
        FROM pg_index ix
        JOIN pg_class c       ON c.oid = ix.indrelid
        JOIN pg_namespace n   ON n.oid = c.relnamespace AND n.nspname = 'public'
        JOIN pg_attribute a   ON a.attrelid = c.oid AND a.attnum = ix.indkey[0]
       WHERE c.relname = t AND a.attname = 'tenant_id'
    ) THEN
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS %I ON %I (tenant_id)',
        format('idx_%s_tenant_id', t), t
      );
      indexed := indexed + 1;
    END IF;
  END LOOP;

  RAISE NOTICE 'migration 304: policies_created=% forced=% indexes_created=% skipped=%',
    policied, forced, indexed, skipped_missing;
END
$$;

-- ---------------------------------------------------------------------------
-- Audit trail (idempotent — mirrors the 075 / 236 / 239 / 272 convention).
-- ---------------------------------------------------------------------------
INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'TENANT_RLS_POLICY_COVERAGE_APPLIED',
  'tenants',
  '00000000-0000-4000-8000-000000000001',
  jsonb_build_object(
    'migration', '304_tenant_rls_policy_coverage.sql',
    'strategy', 'data-driven loop over a vetted 283-table array; ENABLE + FORCE RLS, tenant_isolation policy when absent, tenant_id index when no tenant_id-leading index exists',
    'finding', 'DB-1 (B1.2 RLS policy coverage + B1.1 FORCE RLS)',
    'tables_targeted', 283,
    'policy', 'tenant_isolation',
    'guc', 'app.current_tenant_id',
    'skip_note', 'Global reference/terminology/catalog tables carry no tenant_id and are excluded by construction; reporting views (relkind v/m) are not policied — RLS is enforced on their base tables.'
  ),
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'TENANT_RLS_POLICY_COVERAGE_APPLIED'
    AND resource_id = '00000000-0000-4000-8000-000000000001'
);

COMMIT;
