-- NL-14 P2: resuscitation team roles and signatures.
--
-- Team attendance with role, join/leave times, and per-member signature
-- capture. The event header's team_leader_uid / recorder_uid are the finalize
-- gate; this table is the full attendance + signature record behind them.

BEGIN;

CREATE TABLE IF NOT EXISTS resuscitation_team_roles (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  resuscitation_event_id BIGINT NOT NULL REFERENCES resuscitation_events(id) ON DELETE RESTRICT,
  patient_uid UUID NOT NULL REFERENCES users(uid) ON DELETE NO ACTION,
  staff_uid UUID NOT NULL,
  staff_name VARCHAR(160),
  role VARCHAR(30) NOT NULL,
  joined_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  left_at TIMESTAMPTZ(6),
  signed_at TIMESTAMPTZ(6),
  signature_method VARCHAR(30),
  signature_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  assigned_by UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT resuscitation_team_roles_role_check CHECK (
    role IN (
      'team_leader',
      'recorder',
      'airway',
      'compressions',
      'medications',
      'defibrillation',
      'circulation',
      'runner',
      'observer',
      'other'
    )
  ),
  CONSTRAINT resuscitation_team_roles_time_check
    CHECK (left_at IS NULL OR left_at >= joined_at),
  CONSTRAINT resuscitation_team_roles_signature_method_check
    CHECK (
      signature_method IS NULL
      OR signature_method IN ('app_confirmation', 'pin_confirmed', 'wet_signature_scan')
    ),
  -- A signature carries its method; a method without a timestamp is meaningless.
  CONSTRAINT resuscitation_team_roles_signature_pair_check
    CHECK (
      (signed_at IS NULL AND signature_method IS NULL)
      OR (signed_at IS NOT NULL AND signature_method IS NOT NULL)
    ),
  CONSTRAINT fk_resuscitation_team_roles_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_resuscitation_team_roles_member
  ON resuscitation_team_roles (tenant_id, resuscitation_event_id, staff_uid, role);

CREATE INDEX IF NOT EXISTS idx_resuscitation_team_roles_event
  ON resuscitation_team_roles (tenant_id, resuscitation_event_id, joined_at);

ALTER TABLE resuscitation_team_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE resuscitation_team_roles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON resuscitation_team_roles;
CREATE POLICY tenant_isolation ON resuscitation_team_roles
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
