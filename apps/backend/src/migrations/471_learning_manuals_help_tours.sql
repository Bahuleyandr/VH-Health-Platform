-- NL11-S7: Manuals/Tours/LMS P1 - role manuals, help taxonomy, and tour registry.
-- Catalog content is training-only and explicitly no-PHI; rich course authoring stays out.

BEGIN;

CREATE TABLE IF NOT EXISTS help_center_categories (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  category_key VARCHAR(100) NOT NULL,
  label VARCHAR(160) NOT NULL,
  description TEXT,
  parent_category_id BIGINT REFERENCES help_center_categories(id) ON DELETE SET NULL,
  role_scope TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  sort_order INTEGER NOT NULL DEFAULT 100,
  status VARCHAR(30) NOT NULL DEFAULT 'active',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_help_center_categories_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT help_center_categories_status_check
    CHECK (status IN ('active', 'hidden', 'archived')),
  CONSTRAINT ux_help_center_categories_key
    UNIQUE (tenant_id, category_key)
);

CREATE TABLE IF NOT EXISTS learning_modules (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  module_key VARCHAR(120) NOT NULL,
  title VARCHAR(180) NOT NULL,
  module_type VARCHAR(40) NOT NULL DEFAULT 'role_manual',
  category_key VARCHAR(100),
  summary TEXT,
  content_markdown TEXT NOT NULL DEFAULT '',
  content_uri TEXT,
  role_scope TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  required_for_roles TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  status VARCHAR(30) NOT NULL DEFAULT 'draft',
  version INTEGER NOT NULL DEFAULT 1,
  estimated_minutes INTEGER NOT NULL DEFAULT 5,
  no_phi BOOLEAN NOT NULL DEFAULT TRUE,
  effective_from DATE,
  review_due_on DATE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  updated_by UUID,
  published_at TIMESTAMPTZ(6),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_learning_modules_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT learning_modules_type_check
    CHECK (module_type IN ('role_manual', 'policy', 'quick_reference', 'safety_brief', 'external_lms_link')),
  CONSTRAINT learning_modules_status_check
    CHECK (status IN ('draft', 'published', 'retired', 'archived')),
  CONSTRAINT learning_modules_version_check
    CHECK (version > 0),
  CONSTRAINT learning_modules_minutes_check
    CHECK (estimated_minutes BETWEEN 1 AND 600),
  CONSTRAINT learning_modules_no_phi_check
    CHECK (no_phi IS TRUE),
  CONSTRAINT ux_learning_modules_key
    UNIQUE (tenant_id, module_key)
);

CREATE TABLE IF NOT EXISTS tour_definitions (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  tour_key VARCHAR(120) NOT NULL,
  title VARCHAR(180) NOT NULL,
  surface VARCHAR(80) NOT NULL,
  route_pattern TEXT,
  role_scope TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  status VARCHAR(30) NOT NULL DEFAULT 'draft',
  version INTEGER NOT NULL DEFAULT 1,
  resume_policy VARCHAR(30) NOT NULL DEFAULT 'resume_last_step',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  updated_by UUID,
  published_at TIMESTAMPTZ(6),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_tour_definitions_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT tour_definitions_status_check
    CHECK (status IN ('draft', 'published', 'retired', 'archived')),
  CONSTRAINT tour_definitions_version_check
    CHECK (version > 0),
  CONSTRAINT tour_definitions_resume_policy_check
    CHECK (resume_policy IN ('restart', 'resume_last_step', 'manual')),
  CONSTRAINT tour_definitions_steps_array_check
    CHECK (jsonb_typeof(steps) = 'array'),
  CONSTRAINT ux_tour_definitions_key
    UNIQUE (tenant_id, tour_key)
);

CREATE INDEX IF NOT EXISTS idx_help_center_categories_tenant_status
  ON help_center_categories (tenant_id, status, sort_order, category_key);

CREATE INDEX IF NOT EXISTS idx_learning_modules_tenant_status
  ON learning_modules (tenant_id, status, module_type, category_key);

CREATE INDEX IF NOT EXISTS idx_learning_modules_role_scope
  ON learning_modules USING GIN(role_scope);

CREATE INDEX IF NOT EXISTS idx_tour_definitions_tenant_surface
  ON tour_definitions (tenant_id, surface, status);

CREATE INDEX IF NOT EXISTS idx_tour_definitions_role_scope
  ON tour_definitions USING GIN(role_scope);

DO $$
DECLARE
  t text;
  tables text[] := ARRAY['help_center_categories', 'learning_modules', 'tour_definitions'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($policy$
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
    $policy$, t);
  END LOOP;
END
$$;

INSERT INTO help_center_categories
  (tenant_id, category_key, label, description, role_scope, sort_order, status, metadata)
SELECT
  t.id,
  seed.category_key,
  seed.label,
  seed.description,
  seed.role_scope,
  seed.sort_order,
  'active',
  seed.metadata
FROM tenants t
CROSS JOIN (
  VALUES
    ('privacy-compliance', 'Privacy and compliance', 'Staff-facing confidentiality, consent, and audit basics.', ARRAY['*']::TEXT[], 10, '{"seed":"nl11_s7"}'::jsonb),
    ('daily-workflows', 'Daily workflows', 'Role manuals and quick references for common hospital workflows.', ARRAY['*']::TEXT[], 20, '{"seed":"nl11_s7"}'::jsonb),
    ('admin-setup', 'Admin setup', 'Admin-only adoption, package, and evidence setup references.', ARRAY['ADMIN','SUPER_ADMIN']::TEXT[], 30, '{"seed":"nl11_s7"}'::jsonb)
) AS seed(category_key, label, description, role_scope, sort_order, metadata)
ON CONFLICT (tenant_id, category_key) DO UPDATE SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  role_scope = EXCLUDED.role_scope,
  sort_order = EXCLUDED.sort_order,
  status = EXCLUDED.status,
  metadata = help_center_categories.metadata || EXCLUDED.metadata,
  updated_at = NOW();

INSERT INTO learning_modules
  (tenant_id, module_key, title, module_type, category_key, summary, content_markdown,
   role_scope, required_for_roles, status, version, estimated_minutes, no_phi,
   published_at, metadata)
SELECT
  t.id,
  'staff-confidentiality-basics',
  'Staff confidentiality basics',
  'role_manual',
  'privacy-compliance',
  'Required confidentiality and safe-record-handling primer for staff onboarding.',
  'Use the minimum necessary patient information, keep credentials private, and report suspected privacy incidents through the hospital process.',
  ARRAY['*']::TEXT[],
  ARRAY['*']::TEXT[],
  'published',
  1,
  12,
  TRUE,
  NOW(),
  '{"seed":"nl11_s7","nabh_control_code":"NABH_STAFF_CONFIDENTIALITY_TRAINING"}'::jsonb
FROM tenants t
ON CONFLICT (tenant_id, module_key) DO UPDATE SET
  title = EXCLUDED.title,
  module_type = EXCLUDED.module_type,
  category_key = EXCLUDED.category_key,
  summary = EXCLUDED.summary,
  content_markdown = EXCLUDED.content_markdown,
  role_scope = EXCLUDED.role_scope,
  required_for_roles = EXCLUDED.required_for_roles,
  status = EXCLUDED.status,
  version = EXCLUDED.version,
  estimated_minutes = EXCLUDED.estimated_minutes,
  no_phi = TRUE,
  published_at = COALESCE(learning_modules.published_at, EXCLUDED.published_at),
  metadata = learning_modules.metadata || EXCLUDED.metadata,
  updated_at = NOW();

INSERT INTO tour_definitions
  (tenant_id, tour_key, title, surface, route_pattern, role_scope, steps,
   status, version, resume_policy, published_at, metadata)
SELECT
  t.id,
  'admin-adoption-overview',
  'Adoption evidence overview',
  'admin',
  '/dashboard/adoption',
  ARRAY['ADMIN','SUPER_ADMIN','QUALITY_OFFICER']::TEXT[],
  '[
    {"key":"catalog","label":"Catalog","target":"#adoption-catalog"},
    {"key":"evidence","label":"Evidence","target":"#training-evidence"}
  ]'::jsonb,
  'published',
  1,
  'resume_last_step',
  NOW(),
  '{"seed":"nl11_s7","no_phi":true}'::jsonb
FROM tenants t
ON CONFLICT (tenant_id, tour_key) DO UPDATE SET
  title = EXCLUDED.title,
  surface = EXCLUDED.surface,
  route_pattern = EXCLUDED.route_pattern,
  role_scope = EXCLUDED.role_scope,
  steps = EXCLUDED.steps,
  status = EXCLUDED.status,
  version = EXCLUDED.version,
  resume_policy = EXCLUDED.resume_policy,
  published_at = COALESCE(tour_definitions.published_at, EXCLUDED.published_at),
  metadata = tour_definitions.metadata || EXCLUDED.metadata,
  updated_at = NOW();

COMMIT;
