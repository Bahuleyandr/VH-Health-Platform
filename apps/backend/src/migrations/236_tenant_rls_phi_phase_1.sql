-- 236_tenant_rls_phi_phase_1.sql
--
-- Tenant-scoping for the operational PHI tables that staff write to.
-- Closes the structural gap captured in docs/GAP_ANALYSIS_TENANT_RLS.md
-- (swarm finding 2026-05-17-cross-tenant-rls-receptionist-e1904f2e).
--
-- Scope of this migration (Phase 1):
--   1. ADD tenant_id NOT NULL DEFAULT '00000000-…0001' to seven PHI
--      tables that lack it. Backfill from the linked users row by the
--      table's own patient linkage shape (some use patient_uid:UUID,
--      some patient_id:int). Rows with no patient linkage take the
--      default (current single tenant).
--
--   2. ENABLE ROW LEVEL SECURITY + tenant_isolation policy on those seven
--      tables AND on emergency_visits (which already carried tenant_id
--      from a prior migration). Pattern mirrors migration 075 exactly:
--      permissive when GUC is unset/empty/'bypass', strict tenant match
--      when GUC is a uuid (via the existing app_current_tenant_id_uuid()
--      helper).
--
--   3. Add foreign-key constraints to tenants(id) on the newly added
--      columns.
--
-- Permissive-by-default semantics keep every current call site working
-- unchanged (the GUC is unset, so the policy passes). New code wraps
-- PHI reads/writes in setTenant() to activate the isolation.
--
-- Patient-linkage map for backfill (verified against current schema.prisma):
--   appointments       — patient_id  → users.id
--   admissions         — patient_uid → users.uid
--   clinical_notes     — patient_uid → users.uid
--   prescriptions      — patient_uid → users.uid
--   e_prescriptions    — COALESCE(patient_uid → users.uid, patient_id → users.id)
--   investigations     — patient_id  → users.id
--   vitals_chart       — patient_uid → users.uid
--   emergency_visits   — already has tenant_id (no ADD COLUMN, just RLS)
--
-- Out of scope (Phase 2):
--   - Auditing the 288+ raw-SQL call sites and wrapping PHI ops in
--     setTenant()
--   - Tightening the SUPER_ADMIN x-tenant-id override
--   - Cron / scheduled-job tenant context
--   - Two-tenant deep tests

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. ADD tenant_id to seven PHI tables that lack it.
-- ---------------------------------------------------------------------------

-- appointments — patient_id → users.id
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS tenant_id uuid;
UPDATE appointments a
   SET tenant_id = COALESCE(u.tenant_id, '00000000-0000-4000-8000-000000000001'::uuid)
  FROM users u
 WHERE a.tenant_id IS NULL
   AND u.id = a.patient_id;
UPDATE appointments
   SET tenant_id = '00000000-0000-4000-8000-000000000001'::uuid
 WHERE tenant_id IS NULL;
ALTER TABLE appointments
  ALTER COLUMN tenant_id SET NOT NULL,
  ALTER COLUMN tenant_id SET DEFAULT '00000000-0000-4000-8000-000000000001'::uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_appointments_tenant') THEN
    ALTER TABLE appointments
      ADD CONSTRAINT fk_appointments_tenant
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_appointments_tenant_id ON appointments (tenant_id);

-- admissions — patient_uid → users.uid
ALTER TABLE admissions
  ADD COLUMN IF NOT EXISTS tenant_id uuid;
UPDATE admissions a
   SET tenant_id = COALESCE(u.tenant_id, '00000000-0000-4000-8000-000000000001'::uuid)
  FROM users u
 WHERE a.tenant_id IS NULL
   AND u.uid = a.patient_uid;
UPDATE admissions
   SET tenant_id = '00000000-0000-4000-8000-000000000001'::uuid
 WHERE tenant_id IS NULL;
ALTER TABLE admissions
  ALTER COLUMN tenant_id SET NOT NULL,
  ALTER COLUMN tenant_id SET DEFAULT '00000000-0000-4000-8000-000000000001'::uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_admissions_tenant') THEN
    ALTER TABLE admissions
      ADD CONSTRAINT fk_admissions_tenant
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_admissions_tenant_id ON admissions (tenant_id);

-- clinical_notes — patient_uid → users.uid
ALTER TABLE clinical_notes
  ADD COLUMN IF NOT EXISTS tenant_id uuid;
UPDATE clinical_notes c
   SET tenant_id = COALESCE(u.tenant_id, '00000000-0000-4000-8000-000000000001'::uuid)
  FROM users u
 WHERE c.tenant_id IS NULL
   AND u.uid = c.patient_uid;
UPDATE clinical_notes
   SET tenant_id = '00000000-0000-4000-8000-000000000001'::uuid
 WHERE tenant_id IS NULL;
ALTER TABLE clinical_notes
  ALTER COLUMN tenant_id SET NOT NULL,
  ALTER COLUMN tenant_id SET DEFAULT '00000000-0000-4000-8000-000000000001'::uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_clinical_notes_tenant') THEN
    ALTER TABLE clinical_notes
      ADD CONSTRAINT fk_clinical_notes_tenant
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_clinical_notes_tenant_id ON clinical_notes (tenant_id);

-- prescriptions — patient_uid → users.uid
ALTER TABLE prescriptions
  ADD COLUMN IF NOT EXISTS tenant_id uuid;
UPDATE prescriptions p
   SET tenant_id = COALESCE(u.tenant_id, '00000000-0000-4000-8000-000000000001'::uuid)
  FROM users u
 WHERE p.tenant_id IS NULL
   AND u.uid = p.patient_uid;
UPDATE prescriptions
   SET tenant_id = '00000000-0000-4000-8000-000000000001'::uuid
 WHERE tenant_id IS NULL;
ALTER TABLE prescriptions
  ALTER COLUMN tenant_id SET NOT NULL,
  ALTER COLUMN tenant_id SET DEFAULT '00000000-0000-4000-8000-000000000001'::uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_prescriptions_tenant') THEN
    ALTER TABLE prescriptions
      ADD CONSTRAINT fk_prescriptions_tenant
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_prescriptions_tenant_id ON prescriptions (tenant_id);

-- e_prescriptions — COALESCE(patient_uid → users.uid, patient_id → users.id)
ALTER TABLE e_prescriptions
  ADD COLUMN IF NOT EXISTS tenant_id uuid;
UPDATE e_prescriptions e
   SET tenant_id = COALESCE(u.tenant_id, '00000000-0000-4000-8000-000000000001'::uuid)
  FROM users u
 WHERE e.tenant_id IS NULL
   AND e.patient_uid IS NOT NULL
   AND u.uid = e.patient_uid;
UPDATE e_prescriptions e
   SET tenant_id = COALESCE(u.tenant_id, '00000000-0000-4000-8000-000000000001'::uuid)
  FROM users u
 WHERE e.tenant_id IS NULL
   AND u.id = e.patient_id;
UPDATE e_prescriptions
   SET tenant_id = '00000000-0000-4000-8000-000000000001'::uuid
 WHERE tenant_id IS NULL;
ALTER TABLE e_prescriptions
  ALTER COLUMN tenant_id SET NOT NULL,
  ALTER COLUMN tenant_id SET DEFAULT '00000000-0000-4000-8000-000000000001'::uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_e_prescriptions_tenant') THEN
    ALTER TABLE e_prescriptions
      ADD CONSTRAINT fk_e_prescriptions_tenant
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_e_prescriptions_tenant_id ON e_prescriptions (tenant_id);

-- investigations — patient_id → users.id
ALTER TABLE investigations
  ADD COLUMN IF NOT EXISTS tenant_id uuid;
UPDATE investigations i
   SET tenant_id = COALESCE(u.tenant_id, '00000000-0000-4000-8000-000000000001'::uuid)
  FROM users u
 WHERE i.tenant_id IS NULL
   AND u.id = i.patient_id;
UPDATE investigations
   SET tenant_id = '00000000-0000-4000-8000-000000000001'::uuid
 WHERE tenant_id IS NULL;
ALTER TABLE investigations
  ALTER COLUMN tenant_id SET NOT NULL,
  ALTER COLUMN tenant_id SET DEFAULT '00000000-0000-4000-8000-000000000001'::uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_investigations_tenant') THEN
    ALTER TABLE investigations
      ADD CONSTRAINT fk_investigations_tenant
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_investigations_tenant_id ON investigations (tenant_id);

-- vitals_chart — patient_uid → users.uid
ALTER TABLE vitals_chart
  ADD COLUMN IF NOT EXISTS tenant_id uuid;
UPDATE vitals_chart v
   SET tenant_id = COALESCE(u.tenant_id, '00000000-0000-4000-8000-000000000001'::uuid)
  FROM users u
 WHERE v.tenant_id IS NULL
   AND u.uid = v.patient_uid;
UPDATE vitals_chart
   SET tenant_id = '00000000-0000-4000-8000-000000000001'::uuid
 WHERE tenant_id IS NULL;
ALTER TABLE vitals_chart
  ALTER COLUMN tenant_id SET NOT NULL,
  ALTER COLUMN tenant_id SET DEFAULT '00000000-0000-4000-8000-000000000001'::uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_vitals_chart_tenant') THEN
    ALTER TABLE vitals_chart
      ADD CONSTRAINT fk_vitals_chart_tenant
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_vitals_chart_tenant_id ON vitals_chart (tenant_id);

-- ---------------------------------------------------------------------------
-- 2. ENABLE RLS + tenant_isolation policy on the eight Phase-1 PHI tables.
--    Reuses the app_current_tenant_id_uuid() helper from migration 075.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
  phi_tables text[] := ARRAY[
    'appointments',
    'admissions',
    'clinical_notes',
    'prescriptions',
    'e_prescriptions',
    'investigations',
    'vitals_chart',
    'emergency_visits'
  ];
BEGIN
  FOREACH t IN ARRAY phi_tables
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = t
    ) THEN
      RAISE NOTICE 'Skipping RLS on %: table does not exist', t;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
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
-- 3. Audit record — searchable alongside the 075 baseline rollout.
-- ---------------------------------------------------------------------------

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'TENANT_RLS_PHI_PHASE_1_APPLIED',
  'tenants',
  '00000000-0000-4000-8000-000000000001',
  jsonb_build_object(
    'migration', '236_tenant_rls_phi_phase_1.sql',
    'columns_added', jsonb_build_array(
      'appointments', 'admissions', 'clinical_notes', 'prescriptions',
      'e_prescriptions', 'investigations', 'vitals_chart'
    ),
    'rls_enabled', jsonb_build_array(
      'appointments', 'admissions', 'clinical_notes', 'prescriptions',
      'e_prescriptions', 'investigations', 'vitals_chart', 'emergency_visits'
    ),
    'policy', 'tenant_isolation',
    'guc', 'app.current_tenant_id',
    'gap_doc', 'docs/GAP_ANALYSIS_TENANT_RLS.md'
  ),
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'TENANT_RLS_PHI_PHASE_1_APPLIED'
    AND resource_id = '00000000-0000-4000-8000-000000000001'
);

COMMIT;
