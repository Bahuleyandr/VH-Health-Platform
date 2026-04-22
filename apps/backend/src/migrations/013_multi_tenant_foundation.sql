-- Multi-tenant foundation for India-first, multi-region SaaS.
-- Introduces a tenants table, backfills existing data with a deterministic
-- default tenant, and adds tenant_id to the per-tenant clinical_ai_* tables.
-- The `clinical_ai_modules` catalog stays global (shared product SKU), with
-- per-tenant enablement/overrides in a separate `clinical_ai_tenant_modules`
-- table so one tenant's toggles never bleed into another's.

CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(200) NOT NULL,
  region VARCHAR(10) NOT NULL DEFAULT 'IN'
    CHECK (region IN ('IN', 'EU', 'US', 'AP', 'OTHER')),
  compliance_profile VARCHAR(20) NOT NULL DEFAULT 'DPDP'
    CHECK (compliance_profile IN ('DPDP', 'HIPAA', 'GDPR', 'NONE')),
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'offboarding')),
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Deterministic default tenant so this migration is idempotent AND so existing
-- rows have a stable tenant to backfill against.
INSERT INTO tenants (id, slug, name, region, compliance_profile)
VALUES ('00000000-0000-4000-8000-000000000001', 'default', 'Default Tenant', 'IN', 'DPDP')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Helper DO blocks: backfill a table's tenant_id to the default tenant, then
-- set NOT NULL. Wrapped in DO blocks so the migration stays idempotent if
-- a previous partial run already added the column.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'tenant_id'
  ) THEN
    ALTER TABLE users ADD COLUMN tenant_id UUID REFERENCES tenants(id);
  END IF;
END $$;

UPDATE users
SET tenant_id = '00000000-0000-4000-8000-000000000001'
WHERE tenant_id IS NULL;

ALTER TABLE users ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_tenant_id ON users(tenant_id);

-- ---------------------------------------------------------------------------
-- Per-tenant module overrides. Global catalog (clinical_ai_modules) defines
-- the SKU; this table layers tenant-specific enable/disable, provider, model,
-- and settings overrides. Service layer merges global + override.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clinical_ai_tenant_modules (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  module_key VARCHAR(80) NOT NULL REFERENCES clinical_ai_modules(module_key) ON DELETE CASCADE,
  enabled BOOLEAN,
  provider_override VARCHAR(80),
  model_override VARCHAR(160),
  external_allowed BOOLEAN,
  max_tokens INTEGER,
  temperature NUMERIC(4, 2),
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, module_key)
);

CREATE INDEX IF NOT EXISTS idx_clinical_ai_tenant_modules_tenant
  ON clinical_ai_tenant_modules(tenant_id);

-- ---------------------------------------------------------------------------
-- Helper: add tenant_id to a clinical_ai_* table, backfill, and index.
-- Postgres can't run ALTER TABLE in a loop cleanly, so we repeat the block.
-- ---------------------------------------------------------------------------

-- clinical_ai_generations
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'clinical_ai_generations' AND column_name = 'tenant_id'
  ) THEN
    ALTER TABLE clinical_ai_generations ADD COLUMN tenant_id UUID REFERENCES tenants(id);
  END IF;
END $$;
UPDATE clinical_ai_generations
SET tenant_id = '00000000-0000-4000-8000-000000000001'
WHERE tenant_id IS NULL;
ALTER TABLE clinical_ai_generations ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_clinical_ai_generations_tenant
  ON clinical_ai_generations(tenant_id, created_at DESC);

-- clinical_ai_prompts
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'clinical_ai_prompts' AND column_name = 'tenant_id'
  ) THEN
    ALTER TABLE clinical_ai_prompts ADD COLUMN tenant_id UUID REFERENCES tenants(id);
  END IF;
END $$;
UPDATE clinical_ai_prompts
SET tenant_id = '00000000-0000-4000-8000-000000000001'
WHERE tenant_id IS NULL;
ALTER TABLE clinical_ai_prompts ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_clinical_ai_prompts_tenant
  ON clinical_ai_prompts(tenant_id, module_key, active);

-- clinical_ai_reviews
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'clinical_ai_reviews' AND column_name = 'tenant_id'
  ) THEN
    ALTER TABLE clinical_ai_reviews ADD COLUMN tenant_id UUID REFERENCES tenants(id);
  END IF;
END $$;
UPDATE clinical_ai_reviews
SET tenant_id = '00000000-0000-4000-8000-000000000001'
WHERE tenant_id IS NULL;
ALTER TABLE clinical_ai_reviews ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_clinical_ai_reviews_tenant
  ON clinical_ai_reviews(tenant_id, decision, created_at DESC);

-- clinical_ai_approvals
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'clinical_ai_approvals' AND column_name = 'tenant_id'
  ) THEN
    ALTER TABLE clinical_ai_approvals ADD COLUMN tenant_id UUID REFERENCES tenants(id);
  END IF;
END $$;
UPDATE clinical_ai_approvals
SET tenant_id = '00000000-0000-4000-8000-000000000001'
WHERE tenant_id IS NULL;
ALTER TABLE clinical_ai_approvals ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_clinical_ai_approvals_tenant
  ON clinical_ai_approvals(tenant_id, status, created_at DESC);

-- clinical_ai_context_snapshots
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'clinical_ai_context_snapshots' AND column_name = 'tenant_id'
  ) THEN
    ALTER TABLE clinical_ai_context_snapshots ADD COLUMN tenant_id UUID REFERENCES tenants(id);
  END IF;
END $$;
UPDATE clinical_ai_context_snapshots
SET tenant_id = '00000000-0000-4000-8000-000000000001'
WHERE tenant_id IS NULL;
ALTER TABLE clinical_ai_context_snapshots ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_clinical_ai_context_snapshots_tenant
  ON clinical_ai_context_snapshots(tenant_id, created_at DESC);

-- clinical_ai_safety_reviews
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'clinical_ai_safety_reviews' AND column_name = 'tenant_id'
  ) THEN
    ALTER TABLE clinical_ai_safety_reviews ADD COLUMN tenant_id UUID REFERENCES tenants(id);
  END IF;
END $$;
UPDATE clinical_ai_safety_reviews
SET tenant_id = '00000000-0000-4000-8000-000000000001'
WHERE tenant_id IS NULL;
ALTER TABLE clinical_ai_safety_reviews ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_clinical_ai_safety_reviews_tenant
  ON clinical_ai_safety_reviews(tenant_id, status, created_at DESC);

-- clinical_ai_break_glass_sessions
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'clinical_ai_break_glass_sessions' AND column_name = 'tenant_id'
  ) THEN
    ALTER TABLE clinical_ai_break_glass_sessions ADD COLUMN tenant_id UUID REFERENCES tenants(id);
  END IF;
END $$;
UPDATE clinical_ai_break_glass_sessions
SET tenant_id = '00000000-0000-4000-8000-000000000001'
WHERE tenant_id IS NULL;
ALTER TABLE clinical_ai_break_glass_sessions ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_clinical_ai_break_glass_tenant
  ON clinical_ai_break_glass_sessions(tenant_id, status);

-- clinical_ai_bed_forecasts
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'clinical_ai_bed_forecasts' AND column_name = 'tenant_id'
  ) THEN
    ALTER TABLE clinical_ai_bed_forecasts ADD COLUMN tenant_id UUID REFERENCES tenants(id);
  END IF;
END $$;
UPDATE clinical_ai_bed_forecasts
SET tenant_id = '00000000-0000-4000-8000-000000000001'
WHERE tenant_id IS NULL;
ALTER TABLE clinical_ai_bed_forecasts ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_clinical_ai_bed_forecasts_tenant
  ON clinical_ai_bed_forecasts(tenant_id, created_at DESC);

-- clinical_ai_pharmacy_forecasts
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'clinical_ai_pharmacy_forecasts' AND column_name = 'tenant_id'
  ) THEN
    ALTER TABLE clinical_ai_pharmacy_forecasts ADD COLUMN tenant_id UUID REFERENCES tenants(id);
  END IF;
END $$;
UPDATE clinical_ai_pharmacy_forecasts
SET tenant_id = '00000000-0000-4000-8000-000000000001'
WHERE tenant_id IS NULL;
ALTER TABLE clinical_ai_pharmacy_forecasts ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_clinical_ai_pharmacy_forecasts_tenant
  ON clinical_ai_pharmacy_forecasts(tenant_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Audit event — record the migration for traceability.
-- Uses audit_logs so multi-tenant rollout is searchable in the same surface
-- as every other governance change.
-- ---------------------------------------------------------------------------
INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'MULTI_TENANT_FOUNDATION_APPLIED',
  'tenants',
  '00000000-0000-4000-8000-000000000001',
  jsonb_build_object(
    'migration', '013_multi_tenant_foundation.sql',
    'default_tenant_id', '00000000-0000-4000-8000-000000000001'
  ),
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'MULTI_TENANT_FOUNDATION_APPLIED'
    AND resource_id = '00000000-0000-4000-8000-000000000001'
);
