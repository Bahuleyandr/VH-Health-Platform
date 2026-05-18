-- 238_tenant_rls_phi_phase_2b.sql
--
-- Phase-2b tenant-scoping for the second wave of PHI tables. Extends
-- migration 236's coverage to the 13 tables with clear patient linkage
-- that were allow-listed at Phase-1 land time. The remaining 27 tables
-- (master data, ops/audit, ABDM-specific, claim/billing) either don't
-- need per-tenant scoping or need per-table review and stay in the
-- check-phi-tenant-id allowlist.
--
-- Scope (13 tables):
--   patient_uid linkage (uuid → users.uid):
--     clinical_orders, diagnoses, intake_output, medication_administrations,
--     news2_scores, nurse_handovers, patient_allergies, patient_vitals
--   patient_id linkage (int → users.id):
--     clinical_alerts, medical_records, pharmacy_orders,
--     investigation_bookings, patient_records
--
-- For each table:
--   1. ADD COLUMN tenant_id uuid NOT NULL DEFAULT current-single-tenant
--   2. Backfill via the table's own patient linkage join
--   3. FK to tenants(id) + index
--   4. ENABLE ROW LEVEL SECURITY + FORCE + tenant_isolation policy
--      (same shape as migrations 236 + 237).
--
-- Permissive-by-default semantics from migration 075 keep every legacy
-- call site working unchanged; the Phase-2 substrate at src/lib/prisma.js
-- activates enforcement when AUTH_ENFORCE_TENANT_RLS=true.

BEGIN;

-- ---------------------------------------------------------------------------
-- Helper: bulk-apply tenant_id column + FK + index for a given linkage.
-- ---------------------------------------------------------------------------

-- patient_uid → users.uid set
DO $$
DECLARE
  t text;
  uid_tables text[] := ARRAY[
    'clinical_orders', 'diagnoses', 'intake_output',
    'medication_administrations', 'news2_scores', 'nurse_handovers',
    'patient_allergies', 'patient_vitals'
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

-- patient_id → users.id set
DO $$
DECLARE
  t text;
  -- medical_records.patient_id is actually a UUID column despite the
  -- name; it FKs to users.uid, not users.id. Handled separately below.
  int_tables text[] := ARRAY[
    'clinical_alerts', 'pharmacy_orders',
    'investigation_bookings', 'patient_records'
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

-- medical_records: patient_id is UUID → users.uid (legacy naming).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'medical_records'
  ) THEN
    ALTER TABLE medical_records ADD COLUMN IF NOT EXISTS tenant_id uuid;
    UPDATE medical_records x
       SET tenant_id = COALESCE(u.tenant_id, '00000000-0000-4000-8000-000000000001'::uuid)
      FROM users u
     WHERE x.tenant_id IS NULL AND u.uid = x.patient_id::uuid;
    UPDATE medical_records
       SET tenant_id = '00000000-0000-4000-8000-000000000001'::uuid
     WHERE tenant_id IS NULL;
    ALTER TABLE medical_records
      ALTER COLUMN tenant_id SET NOT NULL,
      ALTER COLUMN tenant_id SET DEFAULT '00000000-0000-4000-8000-000000000001'::uuid;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_medical_records_tenant') THEN
      ALTER TABLE medical_records
        ADD CONSTRAINT fk_medical_records_tenant
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION;
    END IF;
    CREATE INDEX IF NOT EXISTS idx_medical_records_tenant_id ON medical_records (tenant_id);
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- ENABLE RLS + FORCE + tenant_isolation policy on all 13 Phase-2b tables.
-- Reuses app_current_tenant_id_uuid() helper from migration 075.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
  phi_tables text[] := ARRAY[
    'clinical_orders', 'diagnoses', 'intake_output',
    'medication_administrations', 'news2_scores', 'nurse_handovers',
    'patient_allergies', 'patient_vitals',
    'clinical_alerts', 'medical_records', 'pharmacy_orders',
    'investigation_bookings', 'patient_records'
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
  'TENANT_RLS_PHI_PHASE_2B_APPLIED',
  'tenants',
  '00000000-0000-4000-8000-000000000001',
  jsonb_build_object(
    'migration', '238_tenant_rls_phi_phase_2b.sql',
    'tables_added', jsonb_build_array(
      'clinical_orders', 'diagnoses', 'intake_output',
      'medication_administrations', 'news2_scores', 'nurse_handovers',
      'patient_allergies', 'patient_vitals',
      'clinical_alerts', 'medical_records', 'pharmacy_orders',
      'investigation_bookings', 'patient_records'
    ),
    'reason', 'Phase-2b: extend tenant scoping to PHI tables with clear patient linkage. Remaining 27 allow-listed tables are master/ops/audit/billing and need per-table review.',
    'gap_doc', 'docs/GAP_ANALYSIS_TENANT_RLS.md'
  ),
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'TENANT_RLS_PHI_PHASE_2B_APPLIED'
    AND resource_id = '00000000-0000-4000-8000-000000000001'
);

COMMIT;
