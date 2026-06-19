-- 336_medium_tail_tenant_rls.sql
--
-- W2 (multi-tenancy program) — schema completeness, MEDIUM tail. Closes the
-- W2 done-criterion "no tenant-owned-in-spirit table left unisolated and no
-- global-unique that breaks on tenant #2".
--
-- After migrations 328-335 there were 116 base tables without tenant_id. 34 of
-- them are GLOBAL BY DESIGN and stay unscoped (the program's "do not scope"
-- set + four resolved by code-usage investigation): tenants; the terminology /
-- ICD / drug-KB / clinical_ai_modules / clinical_protocols catalogs;
-- totp_challenges, invalidated_tokens, interop_replay_guard, feature_flags;
-- investigation_test_catalog (the global test reference w/ default_cost — the
-- PER-TENANT pricing master is billing_service_master); qa_seed_meta,
-- canary_checks; and hospitals / blood_banks / pharmacies (regional directories
-- read globally for patient nearby-search), medications (global drug master),
-- health_milestones (reward-definition catalog), clinical_ai_guardrails
-- (singleton id=1 safety config), system_alerts (legacy infra; the live
-- per-tenant alerts are clinical_ai_operational_alerts).
--
-- The remaining 82 ARE tenant-owned — HR/staff-ops (attendance/shifts/roster/
-- leave/overtime/geofence/anomalies/breaks/onboarding/reviews/devices/sessions),
-- the housekeeping cluster, patient gamification (step_*/health_*_claims/ledger),
-- per-tenant config (investigation_templates(_tests), notification_templates,
-- pharmacy_catalog, leave_types), clinical detail/child tables (chemo_protocol_
-- drugs [spec: RLS was skipped — added here], dialysis_*, micro_*,
-- vascular_access, maternity_apgar_scores, clinical_order_set_items,
-- insurance_preauth_responses, insurance_claim_caps, investigation_files/_history,
-- tpa_claim_*, ward_indent_items, drug_return_lines, pharmacy_order_history,
-- appointment_status_history, report_updates, replacement_requests,
-- discharge_summary_sections, feedback/patient_feedback), and operational/audit
-- logs (api_access_logs, auth_logs, *_audit/_log, user_*_log, legal_holds,
-- gdpr_erasure_log, data_breaches, scheduled/failed/delivery notifications).
-- Pattern A: tenant_id + ENABLE/FORCE RLS + canonical tenant_isolation policy +
-- GUC-reading DEFAULT.
--
-- BACKFILL = DEFAULT TENANT for all rows. Every existing row is single-tenant;
-- these tables carry heterogeneous, mixed-type linkage columns (the
-- integer=uuid hazard from mig 333), and a per-row parent join would resolve to
-- the same default tenant anyway. New rows get their tenant from the GUC DEFAULT.
-- None of these 82 carry the mig-324 append-only trigger (verified), so the
-- backfill UPDATE needs no audit_bypass.
--
-- UNIQUE swaps (Pattern B) — only the genuinely-global ones (the staff_uid /
-- user_uid / parent-FK keyed uniques are already naturally per-tenant and
-- devices.device_id is a globally-unique token; all left unchanged). Verified
-- no FK depends on any swapped column:
--   * housekeeping_requests.request_number, housekeeping_logs.log_number,
--     leave_types.leave_type, data_breaches.breach_id (document numbers),
--   * housekeeping_zones (lower(name), lower(zone_type)) and
--     staff_shift_roster_boards (department, roster_date, shift_label) —
--     per-tenant human identifiers that would 23505 on tenant #2.
--
-- Mirrors migration 239/335 (multi-table Pattern A) + 326/329 (uniq_<t>_tenant_<col>).

BEGIN;

DO $$
DECLARE
  t text;
  tbls text[] := ARRAY[
    'annual_review_reminders', 'anomalies', 'api_access_logs', 'appointment_status_history',
    'attendance_disputes', 'attendance_logs', 'attendance_regularization', 'auth_logs',
    'batch_upload_logs', 'bulk_operation_logs', 'chemo_protocol_drugs', 'clinical_order_set_items',
    'data_breaches', 'department_audit_log', 'devices', 'dialysis_intra_obs', 'dialysis_serology',
    'discharge_summary_sections', 'drug_return_lines', 'failed_notifications', 'feedback',
    'file_deletion_log', 'gdpr_erasure_log', 'geofence_breaches', 'health_milestone_claims',
    'health_point_ledger', 'housekeeping_floor_assignments', 'housekeeping_logs',
    'housekeeping_request_recipients', 'housekeeping_request_updates', 'housekeeping_requests',
    'housekeeping_zones', 'insurance_claim_caps', 'insurance_preauth_responses',
    'investigation_booking_history', 'investigation_files', 'investigation_template_tests',
    'investigation_templates', 'leave_applications', 'leave_balance_overrides', 'leave_types',
    'legal_holds', 'maternity_apgar_scores', 'micro_isolates', 'micro_sensitivities',
    'notification_delivery_log', 'notification_templates', 'overtime_requests', 'patient_feedback',
    'payslip_queries', 'payslip_query_replies', 'pharmacy_catalog', 'pharmacy_order_history',
    'replacement_requests', 'report_updates', 'scheduled_notifications', 'staff_attendance',
    'staff_auth_sessions', 'staff_breaks', 'staff_devices', 'staff_onboarding_tasks',
    'staff_performance_reviews', 'staff_shift_assignments', 'staff_shift_roster_assignment_audit',
    'staff_shift_roster_assignments', 'staff_shift_roster_boards', 'staff_shift_roster_request_audit',
    'staff_shift_roster_requests', 'staff_shifts', 'step_profiles', 'step_rewards', 'step_sessions',
    'tpa_claim_correspondence', 'tpa_claim_documents', 'user_action_logs', 'user_deactivation_log',
    'user_devices', 'user_reactivation_log', 'user_role_audit', 'user_status_history',
    'vascular_access', 'ward_indent_items'
  ];
  default_expr text := $def$COALESCE(NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid, '00000000-0000-4000-8000-000000000001'::uuid)$def$;
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=t) THEN
      RAISE NOTICE 'Skipping %: table does not exist', t;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id uuid', t);
    EXECUTE format(
      'UPDATE %I SET tenant_id = ''00000000-0000-4000-8000-000000000001''::uuid WHERE tenant_id IS NULL', t
    );
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN tenant_id SET NOT NULL, ALTER COLUMN tenant_id SET DEFAULT %s', t, default_expr
    );
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = format('fk_%s_tenant', t)) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION',
        t, format('fk_%s_tenant', t)
      );
    END IF;
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (tenant_id)', format('idx_%s_tenant_id', t), t);

    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
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
  END LOOP;
  RAISE NOTICE 'mig 336: tenant-isolated % MEDIUM-tail tables', array_length(tbls, 1);
END
$$;

-- ---------------------------------------------------------------------------
-- Pattern B — tenant-scope the genuinely-global uniques on these tables.
-- ---------------------------------------------------------------------------
-- Document numbers (standalone indexes; NOT NULL except data_breaches.breach_id).
DROP INDEX IF EXISTS housekeeping_requests_request_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_housekeeping_requests_tenant_request_number
  ON housekeeping_requests (tenant_id, request_number);

DROP INDEX IF EXISTS housekeeping_logs_log_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_housekeeping_logs_tenant_log_number
  ON housekeeping_logs (tenant_id, log_number);

DROP INDEX IF EXISTS leave_types_leave_type_key;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_leave_types_tenant_leave_type
  ON leave_types (tenant_id, leave_type);

DROP INDEX IF EXISTS data_breaches_breach_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_data_breaches_tenant_breach_id
  ON data_breaches (tenant_id, breach_id) WHERE breach_id IS NOT NULL;

-- Per-tenant human identifiers caught by the comprehensive unique scan.
DROP INDEX IF EXISTS idx_housekeeping_zones_name_type;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_housekeeping_zones_tenant_name_type
  ON housekeeping_zones (tenant_id, lower((name)::text), lower((zone_type)::text));

ALTER TABLE staff_shift_roster_boards DROP CONSTRAINT IF EXISTS staff_shift_roster_boards_unique_shift;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_staff_shift_roster_boards_tenant_shift
  ON staff_shift_roster_boards (tenant_id, department, roster_date, shift_label);

COMMIT;
