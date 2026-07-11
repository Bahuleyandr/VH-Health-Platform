BEGIN;

CREATE TABLE IF NOT EXISTS burn_protocol_content_links (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  burn_chart_id BIGINT NOT NULL REFERENCES burn_charts(id) ON DELETE CASCADE,
  patient_uid UUID NOT NULL,
  protocol_kind VARCHAR(40) NOT NULL
    CHECK (protocol_kind IN ('fluid', 'analgesia', 'tetanus', 'wound_care', 'transfer', 'follow_up')),
  content_order_set_id INTEGER NOT NULL REFERENCES clinical_order_sets(id) ON DELETE RESTRICT,
  family_key VARCHAR(160) NOT NULL,
  content_version INTEGER NOT NULL,
  link_status VARCHAR(30) NOT NULL DEFAULT 'available'
    CHECK (link_status IN ('available', 'unavailable', 'retired')),
  evidence_owner_uid UUID,
  governance_owner_uid UUID,
  reviewer_signoff_uid UUID,
  reviewer_signoff_at TIMESTAMPTZ,
  linked_by UUID,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_burn_protocol_content_links_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_burn_protocol_content_links_kind
  ON burn_protocol_content_links (tenant_id, burn_chart_id, protocol_kind)
  WHERE link_status = 'available';
CREATE INDEX IF NOT EXISTS idx_burn_protocol_content_links_content
  ON burn_protocol_content_links (tenant_id, content_order_set_id);
CREATE INDEX IF NOT EXISTS idx_burn_protocol_content_links_patient
  ON burn_protocol_content_links (tenant_id, patient_uid, linked_at DESC);

ALTER TABLE burn_protocol_content_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE burn_protocol_content_links FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON burn_protocol_content_links;
CREATE POLICY tenant_isolation ON burn_protocol_content_links
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
