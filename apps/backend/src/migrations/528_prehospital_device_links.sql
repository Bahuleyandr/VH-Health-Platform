-- NL-14 P2/P3: pre-hospital device link references.
-- NL-7 owns transport/auth/ingest. This table only records the chart-side link.

CREATE TABLE IF NOT EXISTS prehospital_device_links (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  handover_id BIGINT NOT NULL,
  ambulance_request_id INTEGER,
  patient_uid UUID NOT NULL,
  device_patient_association_id INTEGER,
  device_registry_id INTEGER,
  link_status VARCHAR(32) NOT NULL DEFAULT 'unverified',
  verification_status VARCHAR(32) NOT NULL DEFAULT 'unverified',
  source_system VARCHAR(80) NOT NULL DEFAULT 'nl7',
  verified_by_uid UUID,
  verified_at TIMESTAMPTZ,
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT prehospital_device_links_status_chk CHECK (
    link_status IN ('unverified', 'active', 'ended', 'rejected')
  ),
  CONSTRAINT prehospital_device_links_verification_chk CHECK (
    verification_status IN ('unverified', 'verified', 'rejected')
  ),
  CONSTRAINT fk_prehospital_device_links_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_prehospital_device_links_handover
    FOREIGN KEY (handover_id) REFERENCES prehospital_handovers(id) ON DELETE RESTRICT,
  CONSTRAINT fk_prehospital_device_links_ambulance_request
    FOREIGN KEY (ambulance_request_id) REFERENCES ambulance_requests(id) ON DELETE SET NULL,
  CONSTRAINT fk_prehospital_device_links_device_patient_association
    FOREIGN KEY (device_patient_association_id) REFERENCES device_patient_associations(id) ON DELETE SET NULL,
  CONSTRAINT fk_prehospital_device_links_device_registry
    FOREIGN KEY (device_registry_id) REFERENCES device_registry(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_prehospital_device_links_handover
  ON prehospital_device_links (tenant_id, handover_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_prehospital_device_links_patient
  ON prehospital_device_links (tenant_id, patient_uid, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_prehospital_device_links_verified
  ON prehospital_device_links (tenant_id, verification_status, link_status)
  WHERE verification_status = 'verified';

ALTER TABLE prehospital_device_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE prehospital_device_links FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON prehospital_device_links;
CREATE POLICY tenant_isolation ON prehospital_device_links
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
