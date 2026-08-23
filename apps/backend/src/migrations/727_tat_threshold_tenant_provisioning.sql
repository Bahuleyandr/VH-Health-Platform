-- 727: TAT thresholds for every tenant, not just the default one.
--
-- Migrations 377 and 385 seeded radiology_tat_thresholds and ap_tat_thresholds
-- for tenant 00000000-0000-4000-8000-000000000001 ONLY, and no code path
-- created rows for any other tenant (2026-08-23 once-over). Because the
-- radiology_tat_metrics view drops orders with no threshold row, a second
-- tenant's TAT dashboards rendered empty and RADIOLOGY_TAT_BREACH detection
-- never fired — silently.
--
-- This backfills every existing non-default tenant with a copy of the default
-- tenant's threshold rows (which operators may have tuned — the defaults are
-- the platform's clinical baseline either way). tenantService.createTenant
-- performs the same copy for tenants created after this migration.

INSERT INTO radiology_tat_thresholds
  (tenant_id, priority, modality, target_minutes, warning_minutes, critical_minutes, metadata)
SELECT t.id, d.priority, d.modality, d.target_minutes, d.warning_minutes, d.critical_minutes, d.metadata
  FROM tenants t
 CROSS JOIN radiology_tat_thresholds d
 WHERE d.tenant_id = '00000000-0000-4000-8000-000000000001'::uuid
   AND t.id <> '00000000-0000-4000-8000-000000000001'::uuid
   AND NOT EXISTS (
     SELECT 1 FROM radiology_tat_thresholds x WHERE x.tenant_id = t.id
   )
ON CONFLICT DO NOTHING;

INSERT INTO ap_tat_thresholds
  (tenant_id, case_kind, priority, target_hours, is_active)
SELECT t.id, d.case_kind, d.priority, d.target_hours, d.is_active
  FROM tenants t
 CROSS JOIN ap_tat_thresholds d
 WHERE d.tenant_id = '00000000-0000-4000-8000-000000000001'::uuid
   AND t.id <> '00000000-0000-4000-8000-000000000001'::uuid
   AND NOT EXISTS (
     SELECT 1 FROM ap_tat_thresholds x WHERE x.tenant_id = t.id
   )
ON CONFLICT (tenant_id, case_kind, priority) DO NOTHING;
