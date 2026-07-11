-- NL-14 P2/P3: pre-hospital observation/intervention timeline.
-- Service code treats this as append-only; no update route is exposed.

CREATE TABLE IF NOT EXISTS prehospital_handover_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  handover_id BIGINT NOT NULL,
  event_type VARCHAR(40) NOT NULL,
  event_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recorded_by UUID,
  source_type VARCHAR(32) NOT NULL DEFAULT 'manual',
  summary TEXT NOT NULL,
  observation JSONB NOT NULL DEFAULT '{}'::jsonb,
  intervention JSONB NOT NULL DEFAULT '{}'::jsonb,
  vital_signs JSONB NOT NULL DEFAULT '{}'::jsonb,
  external_reference VARCHAR(160),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT prehospital_handover_events_type_chk CHECK (
    event_type IN ('observation', 'intervention', 'vital', 'eta_change', 'medication', 'allergy', 'note', 'device_observation')
  ),
  CONSTRAINT prehospital_handover_events_source_type_chk CHECK (
    source_type IN ('manual', 'partner_payload', 'device_observation')
  ),
  CONSTRAINT fk_prehospital_handover_events_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_prehospital_handover_events_handover
    FOREIGN KEY (handover_id) REFERENCES prehospital_handovers(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_prehospital_handover_events_handover
  ON prehospital_handover_events (tenant_id, handover_id, event_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_prehospital_handover_events_type
  ON prehospital_handover_events (tenant_id, event_type, event_at DESC);

ALTER TABLE prehospital_handover_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE prehospital_handover_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON prehospital_handover_events;
CREATE POLICY tenant_isolation ON prehospital_handover_events
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
