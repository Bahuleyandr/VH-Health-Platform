-- NL-14 P2/P3: pre-hospital handover header.
-- Linked to the ambulance dispatch row and, once created/arrived, the ED visit.

CREATE TABLE IF NOT EXISTS prehospital_handovers (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  handover_number VARCHAR(100) NOT NULL,
  ambulance_request_id INTEGER NOT NULL,
  emergency_visit_id INTEGER,
  partner_config_id BIGINT,
  patient_uid UUID NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'ready_for_acceptance',
  manual_entry BOOLEAN NOT NULL DEFAULT true,
  source_type VARCHAR(32) NOT NULL DEFAULT 'manual',
  pickup_context TEXT,
  scene_observations TEXT,
  allergies_reported TEXT,
  medications_reported TEXT,
  eta_first_at TIMESTAMPTZ,
  eta_latest_at TIMESTAMPTZ,
  eta_change_reason TEXT,
  presenting_complaint TEXT,
  sbar JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT prehospital_handovers_status_chk CHECK (
    status IN ('draft', 'ready_for_acceptance', 'accepted', 'cancelled', 'void')
  ),
  CONSTRAINT prehospital_handovers_source_type_chk CHECK (
    source_type IN ('manual', 'partner_payload', 'device_observation')
  ),
  CONSTRAINT prehospital_handovers_eta_chk CHECK (
    eta_latest_at IS NULL OR eta_first_at IS NULL OR eta_latest_at >= eta_first_at
  ),
  CONSTRAINT fk_prehospital_handovers_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_prehospital_handovers_ambulance_request
    FOREIGN KEY (ambulance_request_id) REFERENCES ambulance_requests(id) ON DELETE RESTRICT,
  CONSTRAINT fk_prehospital_handovers_emergency_visit
    FOREIGN KEY (emergency_visit_id) REFERENCES emergency_visits(id) ON DELETE SET NULL,
  CONSTRAINT fk_prehospital_handovers_partner_config
    FOREIGN KEY (partner_config_id) REFERENCES ambulance_partner_fleet_configs(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_prehospital_handovers_number
  ON prehospital_handovers (tenant_id, handover_number);

CREATE UNIQUE INDEX IF NOT EXISTS ux_prehospital_handovers_ambulance_request
  ON prehospital_handovers (tenant_id, ambulance_request_id);

CREATE INDEX IF NOT EXISTS idx_prehospital_handovers_status
  ON prehospital_handovers (tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_prehospital_handovers_patient
  ON prehospital_handovers (tenant_id, patient_uid, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_prehospital_handovers_visit
  ON prehospital_handovers (tenant_id, emergency_visit_id)
  WHERE emergency_visit_id IS NOT NULL;

ALTER TABLE prehospital_handovers ENABLE ROW LEVEL SECURITY;
ALTER TABLE prehospital_handovers FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON prehospital_handovers;
CREATE POLICY tenant_isolation ON prehospital_handovers
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
