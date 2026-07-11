-- NL-14 P2/P3: receiving clinician acceptance and handover signatures.

CREATE TABLE IF NOT EXISTS prehospital_handover_acceptances (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  handover_id BIGINT NOT NULL,
  accepted_by_uid UUID NOT NULL,
  accepted_by_role VARCHAR(80),
  acceptance_role VARCHAR(40) NOT NULL DEFAULT 'receiving_nurse',
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  signature_method VARCHAR(40) NOT NULL DEFAULT 'typed',
  signature_text TEXT,
  handover_signed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  clinical_attestation TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT prehospital_handover_acceptances_role_chk CHECK (
    acceptance_role IN ('receiving_nurse', 'receiving_doctor')
  ),
  CONSTRAINT prehospital_handover_acceptances_signature_method_chk CHECK (
    signature_method IN ('typed', 'manual', 'e_signature', 'witnessed')
  ),
  CONSTRAINT fk_prehospital_handover_acceptances_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_prehospital_handover_acceptances_handover
    FOREIGN KEY (handover_id) REFERENCES prehospital_handovers(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_prehospital_handover_acceptance_role
  ON prehospital_handover_acceptances (tenant_id, handover_id, acceptance_role);

CREATE INDEX IF NOT EXISTS idx_prehospital_handover_acceptances_actor
  ON prehospital_handover_acceptances (tenant_id, accepted_by_uid, accepted_at DESC);

ALTER TABLE prehospital_handover_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE prehospital_handover_acceptances FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON prehospital_handover_acceptances;
CREATE POLICY tenant_isolation ON prehospital_handover_acceptances
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
