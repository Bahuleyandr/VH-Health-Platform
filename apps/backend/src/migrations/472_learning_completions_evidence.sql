-- NL11-S7: Manuals/Tours/LMS P1 - completion events and NABH training evidence ledger.
-- Completion/event rows are tenant-scoped; evidence rows carry assessor-facing metadata only.

BEGIN;

CREATE TABLE IF NOT EXISTS learning_assignments (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  assignment_key VARCHAR(140) NOT NULL,
  module_id BIGINT NOT NULL REFERENCES learning_modules(id) ON DELETE CASCADE,
  role_scope TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  assigned_to_uid UUID,
  status VARCHAR(30) NOT NULL DEFAULT 'active',
  due_on DATE,
  evidence_policy VARCHAR(80) NOT NULL DEFAULT 'training_completion',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_learning_assignments_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT learning_assignments_status_check
    CHECK (status IN ('active', 'paused', 'completed', 'archived')),
  CONSTRAINT ux_learning_assignments_key
    UNIQUE (tenant_id, assignment_key)
);

CREATE TABLE IF NOT EXISTS learning_completions (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  module_id BIGINT NOT NULL REFERENCES learning_modules(id) ON DELETE CASCADE,
  assignment_id BIGINT REFERENCES learning_assignments(id) ON DELETE SET NULL,
  actor_uid UUID NOT NULL,
  actor_role VARCHAR(80),
  module_version INTEGER NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'completed',
  completion_source VARCHAR(40) NOT NULL DEFAULT 'in_app',
  completed_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  attestation_text TEXT,
  evidence_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_learning_completions_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT learning_completions_status_check
    CHECK (status IN ('completed', 'attested', 'waived', 'revoked')),
  CONSTRAINT learning_completions_source_check
    CHECK (completion_source IN ('in_app', 'admin_entry', 'external_lms', 'import')),
  CONSTRAINT learning_completions_version_check
    CHECK (module_version > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_learning_completions_actor_module_version
  ON learning_completions (tenant_id, module_id, actor_uid, module_version);

CREATE INDEX IF NOT EXISTS idx_learning_completions_actor
  ON learning_completions (tenant_id, actor_uid, completed_at DESC);

CREATE INDEX IF NOT EXISTS idx_learning_completions_module
  ON learning_completions (tenant_id, module_id, completed_at DESC);

CREATE TABLE IF NOT EXISTS tour_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  tour_id BIGINT NOT NULL REFERENCES tour_definitions(id) ON DELETE CASCADE,
  actor_uid UUID NOT NULL,
  actor_role VARCHAR(80),
  tour_version INTEGER NOT NULL,
  event_type VARCHAR(30) NOT NULL,
  step_key VARCHAR(120),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_tour_events_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT tour_events_type_check
    CHECK (event_type IN ('started', 'step_viewed', 'skipped', 'completed', 'reset')),
  CONSTRAINT tour_events_version_check
    CHECK (tour_version > 0)
);

CREATE INDEX IF NOT EXISTS idx_tour_events_actor
  ON tour_events (tenant_id, actor_uid, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tour_events_tour_type
  ON tour_events (tenant_id, tour_id, event_type, created_at DESC);

CREATE TABLE IF NOT EXISTS training_evidence_ledger (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  evidence_key VARCHAR(180) NOT NULL,
  source_type VARCHAR(40) NOT NULL,
  source_id BIGINT,
  control_code VARCHAR(100) NOT NULL DEFAULT 'TRAINING_COMPLETION',
  subject_uid UUID NOT NULL,
  subject_role VARCHAR(80),
  title VARCHAR(220) NOT NULL,
  evidence_status VARCHAR(30) NOT NULL DEFAULT 'captured',
  evidence_uri TEXT,
  verified_by UUID,
  verified_at TIMESTAMPTZ(6),
  period_start DATE,
  period_end DATE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_training_evidence_ledger_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT training_evidence_ledger_source_check
    CHECK (source_type IN ('learning_completion', 'tour_completion', 'manual_attestation', 'external_lms')),
  CONSTRAINT training_evidence_ledger_status_check
    CHECK (evidence_status IN ('captured', 'verified', 'rejected', 'superseded')),
  CONSTRAINT training_evidence_ledger_verified_check
    CHECK (evidence_status <> 'verified' OR (verified_by IS NOT NULL AND verified_at IS NOT NULL)),
  CONSTRAINT ux_training_evidence_ledger_key
    UNIQUE (tenant_id, evidence_key)
);

CREATE INDEX IF NOT EXISTS idx_training_evidence_ledger_control
  ON training_evidence_ledger (tenant_id, control_code, evidence_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_training_evidence_ledger_subject
  ON training_evidence_ledger (tenant_id, subject_uid, created_at DESC);

DO $$
DECLARE
  t text;
  tables text[] := ARRAY['learning_assignments', 'learning_completions', 'tour_events', 'training_evidence_ledger'];
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

INSERT INTO learning_assignments
  (tenant_id, assignment_key, module_id, role_scope, status, evidence_policy, metadata)
SELECT
  m.tenant_id,
  'staff-confidentiality-basics-required',
  m.id,
  ARRAY['*']::TEXT[],
  'active',
  'nabh_confidentiality_training',
  '{"seed":"nl11_s7","control_code":"NABH_STAFF_CONFIDENTIALITY_TRAINING"}'::jsonb
FROM learning_modules m
WHERE m.module_key = 'staff-confidentiality-basics'
ON CONFLICT (tenant_id, assignment_key) DO UPDATE SET
  module_id = EXCLUDED.module_id,
  role_scope = EXCLUDED.role_scope,
  status = EXCLUDED.status,
  evidence_policy = EXCLUDED.evidence_policy,
  metadata = learning_assignments.metadata || EXCLUDED.metadata,
  updated_at = NOW();

COMMIT;
