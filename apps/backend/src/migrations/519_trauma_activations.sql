-- NL-14 P2: trauma activations and team roles.

BEGIN;

CREATE TABLE IF NOT EXISTS trauma_activations (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  activation_number VARCHAR(80) NOT NULL,
  emergency_visit_id INTEGER REFERENCES emergency_visits(id) ON DELETE SET NULL,
  admission_id INTEGER REFERENCES admissions(id) ON DELETE SET NULL,
  patient_uid UUID REFERENCES users(uid) ON DELETE RESTRICT,
  activation_reason TEXT NOT NULL,
  activation_level VARCHAR(24) NOT NULL,
  activated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  activated_by_uid UUID,
  team_leader_uid UUID,
  expected_arrival_at TIMESTAMPTZ(6),
  patient_arrived_at TIMESTAMPTZ(6),
  blood_bank_alerted_at TIMESTAMPTZ(6),
  blood_bank_alerted_by_uid UUID,
  radiology_alerted_at TIMESTAMPTZ(6),
  radiology_alerted_by_uid UUID,
  ot_alerted_at TIMESTAMPTZ(6),
  ot_alerted_by_uid UUID,
  registry_participation VARCHAR(32),
  registry_reviewer_uid UUID,
  registry_reviewed_at TIMESTAMPTZ(6),
  registry_export_status VARCHAR(24) NOT NULL DEFAULT 'not_configured',
  status VARCHAR(24) NOT NULL DEFAULT 'active',
  timeline_event_id UUID REFERENCES clinical_timeline_events(id) ON DELETE SET NULL,
  audit_event_id UUID REFERENCES clinical_audit_events(id) ON DELETE SET NULL,
  source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT trauma_activations_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT trauma_activations_level_check CHECK (
    activation_level IN ('standby', 'partial', 'full', 'mass_casualty')
  ),
  CONSTRAINT trauma_activations_status_check CHECK (
    status IN ('active', 'cancelled', 'completed', 'finalized')
  ),
  CONSTRAINT trauma_activations_registry_check CHECK (
    registry_participation IS NULL
    OR registry_participation IN ('internal_only', 'state_partner', 'registry_ready')
  ),
  CONSTRAINT trauma_activations_export_status_check CHECK (
    registry_export_status IN ('not_configured', 'blocked_pending_review', 'ready', 'exported')
  ),
  CONSTRAINT trauma_activations_registry_review_check CHECK (
    registry_export_status <> 'ready'
    OR (registry_participation = 'registry_ready' AND registry_reviewer_uid IS NOT NULL AND registry_reviewed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_trauma_activations_number
  ON trauma_activations (tenant_id, activation_number);

CREATE INDEX IF NOT EXISTS idx_trauma_activations_visit
  ON trauma_activations (tenant_id, emergency_visit_id, activated_at DESC)
  WHERE emergency_visit_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trauma_activations_patient
  ON trauma_activations (tenant_id, patient_uid, activated_at DESC)
  WHERE patient_uid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trauma_activations_status
  ON trauma_activations (tenant_id, status, activated_at DESC);

CREATE TABLE IF NOT EXISTS trauma_activation_team_roles (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  trauma_activation_id BIGINT NOT NULL REFERENCES trauma_activations(id) ON DELETE CASCADE,
  role_code VARCHAR(60) NOT NULL,
  role_label VARCHAR(160),
  staff_uid UUID,
  assigned_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  arrived_at TIMESTAMPTZ(6),
  accepted_at TIMESTAMPTZ(6),
  status VARCHAR(24) NOT NULL DEFAULT 'assigned',
  notes TEXT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT trauma_team_roles_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT trauma_team_roles_status_check CHECK (
    status IN ('assigned', 'accepted', 'arrived', 'released', 'replaced')
  ),
  CONSTRAINT trauma_team_roles_role_not_blank CHECK (length(trim(role_code)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_trauma_team_roles_activation_role
  ON trauma_activation_team_roles (tenant_id, trauma_activation_id, role_code);

CREATE INDEX IF NOT EXISTS idx_trauma_team_roles_staff
  ON trauma_activation_team_roles (tenant_id, staff_uid, assigned_at DESC)
  WHERE staff_uid IS NOT NULL;

ALTER TABLE trauma_activations ENABLE ROW LEVEL SECURITY;
ALTER TABLE trauma_activations FORCE ROW LEVEL SECURITY;
ALTER TABLE trauma_activation_team_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE trauma_activation_team_roles FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON trauma_activations;
CREATE POLICY tenant_isolation ON trauma_activations
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
  );

DROP POLICY IF EXISTS tenant_isolation ON trauma_activation_team_roles;
CREATE POLICY tenant_isolation ON trauma_activation_team_roles
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
  );

COMMIT;
