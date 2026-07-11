-- NL-13 P1c: ordered, append-only Code-STEMI pathway milestones.
-- Corrections are represented by a new event; in-place mutation is blocked.

BEGIN;

CREATE TABLE IF NOT EXISTS stemi_pathway_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  activation_id BIGINT NOT NULL,
  patient_uid UUID NOT NULL,
  encounter_id UUID,
  sequence_number INTEGER NOT NULL,
  event_type VARCHAR(40) NOT NULL,
  occurred_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  workflow_sla_instance_id UUID,
  event_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_by UUID,
  canonical_timeline_event_id UUID,
  canonical_audit_event_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_stemi_pathway_events_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_stemi_pathway_events_activation
    FOREIGN KEY (activation_id) REFERENCES stemi_activations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_stemi_pathway_events_patient
    FOREIGN KEY (patient_uid) REFERENCES users(uid) ON DELETE RESTRICT,
  CONSTRAINT fk_stemi_pathway_events_encounter
    FOREIGN KEY (encounter_id) REFERENCES patient_encounters(id) ON DELETE SET NULL,
  CONSTRAINT fk_stemi_pathway_events_sla
    FOREIGN KEY (workflow_sla_instance_id) REFERENCES workflow_sla_instances(id) ON DELETE SET NULL,
  CONSTRAINT fk_stemi_pathway_events_timeline
    FOREIGN KEY (canonical_timeline_event_id) REFERENCES clinical_timeline_events(id) ON DELETE SET NULL,
  CONSTRAINT fk_stemi_pathway_events_audit
    FOREIGN KEY (canonical_audit_event_id) REFERENCES clinical_audit_events(id) ON DELETE SET NULL,
  CONSTRAINT stemi_pathway_events_sequence_positive CHECK (sequence_number > 0),
  CONSTRAINT stemi_pathway_events_type_check CHECK (
    event_type IN (
      'ecg_acquired', 'ecg_read', 'activation', 'lab_ready', 'patient_in_lab',
      'access', 'wire_crossing', 'device_deployed', 'reperfusion_assessment',
      'transfer', 'disposition'
    )
  ),
  CONSTRAINT stemi_pathway_events_json_shapes CHECK (
    jsonb_typeof(event_payload) = 'object'
    AND jsonb_typeof(metadata) = 'object'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_stemi_pathway_events_sequence
  ON stemi_pathway_events (tenant_id, activation_id, sequence_number);

CREATE INDEX IF NOT EXISTS idx_stemi_pathway_events_activation
  ON stemi_pathway_events (tenant_id, activation_id, occurred_at, sequence_number);

CREATE INDEX IF NOT EXISTS idx_stemi_pathway_events_patient
  ON stemi_pathway_events (tenant_id, patient_uid, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_stemi_pathway_events_sla
  ON stemi_pathway_events (tenant_id, workflow_sla_instance_id)
  WHERE workflow_sla_instance_id IS NOT NULL;

CREATE OR REPLACE FUNCTION stemi_pathway_events_block_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'stemi_pathway_events is append-only: % is not allowed (record a new event instead)',
    TG_OP
    USING ERRCODE = 'raise_exception';
END;
$$;

DROP TRIGGER IF EXISTS trg_stemi_pathway_events_append_only ON stemi_pathway_events;
CREATE TRIGGER trg_stemi_pathway_events_append_only
  BEFORE UPDATE OR DELETE ON stemi_pathway_events
  FOR EACH ROW EXECUTE FUNCTION stemi_pathway_events_block_mutation();

ALTER TABLE stemi_pathway_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE stemi_pathway_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON stemi_pathway_events;
CREATE POLICY tenant_isolation ON stemi_pathway_events
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
