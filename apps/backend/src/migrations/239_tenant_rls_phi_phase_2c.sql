-- 239_tenant_rls_phi_phase_2c.sql
--
-- Phase-2c tenant-scoping for the residual PHI tables that were still on
-- check-phi-tenant-id's ALLOWLIST after migrations 236 (Phase 1, 7 tables)
-- and 238 (Phase 2b, 13 tables). Closes the last 27 entries.
--
-- Scope (27 tables, grouped by patient-linkage column):
--
--   patient_uid linkage (uuid → users.uid) — 23 tables:
--     abdm_consents, abdm_data_requests, allergies,
--     bed_transfers, blood_requests, cds_alerts, claim_denials,
--     diet_orders, discharge_consults, downtime_snapshots, event_outbox,
--     family_members, infection_cases, insurance_claims, invoices,
--     medication_reminders, ot_schedules, patient_consents,
--     patient_data_rights_requests, quality_incidents, radiology_orders,
--     referrals, staff_messages
--
--   patient_id linkage (int → users.id) — 2 tables:
--     appointment_documents, prescription_safety_overrides
--
--   special patient linkage — 2 tables:
--     beds            — has BOTH patient_uid (uuid) AND patient_id (int);
--                       prefer patient_uid (newer canonical FK), fall
--                       back to patient_id.
--     hipaa_access_log — patient is referenced as subject_uid (uuid, the
--                       data-subject of the audit record). Falls back to
--                       actor_uid if subject_uid is null (still tenant-
--                       scoped to whoever performed the access).
--
-- Pattern per table (same shape as migrations 236 + 238):
--   1. ADD COLUMN tenant_id uuid (idempotent)
--   2. Backfill via the table's own patient linkage
--   3. Coerce any remaining NULLs to DEFAULT_TENANT_ID
--   4. SET NOT NULL + DEFAULT '00000000-0000-4000-8000-000000000001'
--   5. FK to tenants(id) + index
--   6. ENABLE + FORCE RLS, install tenant_isolation policy
--
-- The permissive-by-default policy from migration 075 (bypass when the
-- GUC is unset / empty / 'bypass') keeps every legacy call site
-- working unchanged. AUTH_ENFORCE_TENANT_RLS=true (set on dalekdefender
-- 2026-05-19) activates enforcement via the prisma proxy's auto-applied
-- setTenant().
--
-- See: docs/GAP_ANALYSIS_TENANT_RLS.md, Phase 2b residual.

BEGIN;

-- ---------------------------------------------------------------------------
-- Group 1: patient_uid → users.uid (23 tables)
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
  uid_tables text[] := ARRAY[
    'abdm_consents', 'abdm_data_requests', 'allergies',
    'bed_transfers', 'blood_requests', 'cds_alerts', 'claim_denials',
    'diet_orders', 'discharge_consults', 'downtime_snapshots',
    'event_outbox', 'family_members', 'infection_cases',
    'insurance_claims', 'invoices', 'medication_reminders',
    'ot_schedules', 'patient_consents', 'patient_data_rights_requests',
    'quality_incidents', 'radiology_orders', 'referrals',
    'staff_messages'
  ];
BEGIN
  FOREACH t IN ARRAY uid_tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = t
    ) THEN
      RAISE NOTICE 'Skipping %: table does not exist', t;
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id uuid', t);
    EXECUTE format(
      'UPDATE %I x SET tenant_id = COALESCE(u.tenant_id, ''00000000-0000-4000-8000-000000000001''::uuid) FROM users u WHERE x.tenant_id IS NULL AND u.uid = x.patient_uid',
      t
    );
    EXECUTE format(
      'UPDATE %I SET tenant_id = ''00000000-0000-4000-8000-000000000001''::uuid WHERE tenant_id IS NULL',
      t
    );
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN tenant_id SET NOT NULL, ALTER COLUMN tenant_id SET DEFAULT ''00000000-0000-4000-8000-000000000001''::uuid',
      t
    );
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = format('fk_%s_tenant', t)
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION',
        t, format('fk_%s_tenant', t)
      );
    END IF;
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %I (tenant_id)',
      format('idx_%s_tenant_id', t), t
    );
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- Group 2: patient_id → users.id (2 tables)
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
  int_tables text[] := ARRAY[
    'appointment_documents', 'prescription_safety_overrides'
  ];
BEGIN
  FOREACH t IN ARRAY int_tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = t
    ) THEN
      RAISE NOTICE 'Skipping %: table does not exist', t;
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id uuid', t);
    EXECUTE format(
      'UPDATE %I x SET tenant_id = COALESCE(u.tenant_id, ''00000000-0000-4000-8000-000000000001''::uuid) FROM users u WHERE x.tenant_id IS NULL AND u.id = x.patient_id',
      t
    );
    EXECUTE format(
      'UPDATE %I SET tenant_id = ''00000000-0000-4000-8000-000000000001''::uuid WHERE tenant_id IS NULL',
      t
    );
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN tenant_id SET NOT NULL, ALTER COLUMN tenant_id SET DEFAULT ''00000000-0000-4000-8000-000000000001''::uuid',
      t
    );
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = format('fk_%s_tenant', t)
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION',
        t, format('fk_%s_tenant', t)
      );
    END IF;
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %I (tenant_id)',
      format('idx_%s_tenant_id', t), t
    );
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- Group 3: beds — both patient_uid (uuid) AND patient_id (int).
-- patient_uid is the canonical FK (newer); fall back to patient_id.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'beds'
  ) THEN
    ALTER TABLE beds ADD COLUMN IF NOT EXISTS tenant_id uuid;
    -- Step 1: backfill from users.uid via patient_uid (preferred).
    UPDATE beds x
       SET tenant_id = COALESCE(u.tenant_id, '00000000-0000-4000-8000-000000000001'::uuid)
      FROM users u
     WHERE x.tenant_id IS NULL AND u.uid = x.patient_uid;
    -- Step 2: backfill from users.id via patient_id (fallback for legacy rows).
    UPDATE beds x
       SET tenant_id = COALESCE(u.tenant_id, '00000000-0000-4000-8000-000000000001'::uuid)
      FROM users u
     WHERE x.tenant_id IS NULL AND u.id = x.patient_id;
    -- Step 3: empty beds (no patient assigned) get the default tenant.
    UPDATE beds
       SET tenant_id = '00000000-0000-4000-8000-000000000001'::uuid
     WHERE tenant_id IS NULL;
    ALTER TABLE beds
      ALTER COLUMN tenant_id SET NOT NULL,
      ALTER COLUMN tenant_id SET DEFAULT '00000000-0000-4000-8000-000000000001'::uuid;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_beds_tenant') THEN
      ALTER TABLE beds
        ADD CONSTRAINT fk_beds_tenant
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION;
    END IF;
    CREATE INDEX IF NOT EXISTS idx_beds_tenant_id ON beds (tenant_id);
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Group 4: hipaa_access_log — the access audit log itself.
-- Tenant-scope to the subject_uid (the patient whose record was accessed),
-- falling back to actor_uid (the staff member who accessed it) so an
-- audit row always lands in *some* tenant rather than the default.
-- SUPER_ADMIN cross-tenant compliance reads still work via the bypass
-- branch of the tenant_isolation policy.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'hipaa_access_log'
  ) THEN
    ALTER TABLE hipaa_access_log ADD COLUMN IF NOT EXISTS tenant_id uuid;
    -- Subject of the access (the patient whose record was opened).
    UPDATE hipaa_access_log x
       SET tenant_id = COALESCE(u.tenant_id, '00000000-0000-4000-8000-000000000001'::uuid)
      FROM users u
     WHERE x.tenant_id IS NULL AND u.uid = x.subject_uid;
    -- Actor fallback (staff member who performed the access).
    UPDATE hipaa_access_log x
       SET tenant_id = COALESCE(u.tenant_id, '00000000-0000-4000-8000-000000000001'::uuid)
      FROM users u
     WHERE x.tenant_id IS NULL AND u.uid = x.actor_uid;
    UPDATE hipaa_access_log
       SET tenant_id = '00000000-0000-4000-8000-000000000001'::uuid
     WHERE tenant_id IS NULL;
    ALTER TABLE hipaa_access_log
      ALTER COLUMN tenant_id SET NOT NULL,
      ALTER COLUMN tenant_id SET DEFAULT '00000000-0000-4000-8000-000000000001'::uuid;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hipaa_access_log_tenant') THEN
      ALTER TABLE hipaa_access_log
        ADD CONSTRAINT fk_hipaa_access_log_tenant
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION;
    END IF;
    CREATE INDEX IF NOT EXISTS idx_hipaa_access_log_tenant_id ON hipaa_access_log (tenant_id);
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- ENABLE RLS + FORCE + tenant_isolation policy on all 27 Phase-2c tables.
-- Reuses app_current_tenant_id_uuid() helper from migration 075.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
  phi_tables text[] := ARRAY[
    'abdm_consents', 'abdm_data_requests', 'allergies',
    'appointment_documents', 'bed_transfers', 'beds', 'blood_requests',
    'cds_alerts', 'claim_denials', 'diet_orders', 'discharge_consults',
    'downtime_snapshots', 'event_outbox', 'family_members',
    'hipaa_access_log', 'infection_cases', 'insurance_claims',
    'invoices', 'medication_reminders', 'ot_schedules',
    'patient_consents', 'patient_data_rights_requests',
    'prescription_safety_overrides', 'quality_incidents',
    'radiology_orders', 'referrals', 'staff_messages'
  ];
BEGIN
  FOREACH t IN ARRAY phi_tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = t
    ) THEN
      CONTINUE;
    END IF;
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
END
$$;

-- ---------------------------------------------------------------------------
-- Audit record.
-- ---------------------------------------------------------------------------

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'TENANT_RLS_PHI_PHASE_2C_APPLIED',
  'tenants',
  '00000000-0000-4000-8000-000000000001',
  jsonb_build_object(
    'migration', '239_tenant_rls_phi_phase_2c.sql',
    'tables_added', jsonb_build_array(
      'abdm_consents', 'abdm_data_requests', 'allergies',
      'appointment_documents', 'bed_transfers', 'beds', 'blood_requests',
      'cds_alerts', 'claim_denials', 'diet_orders', 'discharge_consults',
      'downtime_snapshots', 'event_outbox', 'family_members',
      'hipaa_access_log', 'infection_cases', 'insurance_claims',
      'invoices', 'medication_reminders', 'ot_schedules',
      'patient_consents', 'patient_data_rights_requests',
      'prescription_safety_overrides', 'quality_incidents',
      'radiology_orders', 'referrals', 'staff_messages'
    ),
    'reason', 'Phase-2c: tenant_id + RLS on the final 27 PHI tables. Closes the check-phi-tenant-id allowlist; the script is now an empty guard for new tables.',
    'gap_doc', 'docs/GAP_ANALYSIS_TENANT_RLS.md'
  ),
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'TENANT_RLS_PHI_PHASE_2C_APPLIED'
    AND resource_id = '00000000-0000-4000-8000-000000000001'
);

COMMIT;
