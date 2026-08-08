-- 641_drug_chart_missing_sla_rule.sql
--
-- C-M6: the drug-chart-missing sweep (drugChartSlaService) raised its alert
-- entirely outside the canonical SLA layer — no workflow_sla_instances row,
-- no escalation proof, and an audit_logs-based dedupe that made the alert
-- permanently one-shot per admission. The service now starts / re-arms a
-- canonical clock through startWorkflowSla, which requires an enabled
-- workflow_sla_rules row. Seed the global default (tenant_id NULL, the
-- migration-456 shape; migration 352's RLS policy keeps global defaults
-- visible inside setTenantTx). target_minutes mirrors the sweep's
-- DEFAULT_GRACE_MINUTES (60).

INSERT INTO workflow_sla_rules
  (tenant_id, rule_code, title, trigger_event_type, target_minutes, severity,
   owner_role_codes, escalation_role_codes, enabled, metadata, created_at, updated_at)
SELECT NULL::uuid, rule_code, title, trigger_event_type, target_minutes, severity,
       owner_role_codes, escalation_role_codes, TRUE, metadata, NOW(), NOW()
  FROM (
    VALUES
      (
        'drug_chart_first_entry',
        'Inpatient drug chart - first entry after ward arrival',
        'admission.drug_chart_missing',
        60,
        'high',
        ARRAY['DOCTOR','DUTY_DOCTOR','CONSULTANT','JUNIOR_DOCTOR','SENIOR_DOCTOR','RESIDENT','MEDICAL_SUPERINTENDENT']::text[],
        ARRAY['NURSING_INCHARGE','MEDICAL_SUPERINTENDENT']::text[],
        '{"source":"drug_chart_sla"}'::jsonb
      )
  ) AS seed(rule_code, title, trigger_event_type, target_minutes, severity,
            owner_role_codes, escalation_role_codes, metadata)
 WHERE NOT EXISTS (
   SELECT 1
     FROM workflow_sla_rules existing
    WHERE existing.tenant_id IS NULL
      AND existing.rule_code = seed.rule_code
 );
