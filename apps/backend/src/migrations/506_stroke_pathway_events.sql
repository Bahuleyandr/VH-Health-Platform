-- NL-13 P2: stroke pathway milestones and timer evidence.
-- Application code records CT and treatment milestones here, then completes
-- matching workflow_sla_instances in the same tenant-scoped transaction.

CREATE TABLE IF NOT EXISTS stroke_pathway_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  activation_id BIGINT NOT NULL,
  patient_uid UUID NOT NULL,
  encounter_id UUID,
  event_type VARCHAR(40) NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  radiology_order_id INTEGER,
  event_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_by UUID,
  canonical_timeline_event_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_stroke_pathway_events_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_stroke_pathway_events_activation
    FOREIGN KEY (activation_id) REFERENCES stroke_activations(id) ON DELETE CASCADE,
  CONSTRAINT fk_stroke_pathway_events_patient
    FOREIGN KEY (patient_uid) REFERENCES users(uid) ON DELETE RESTRICT,
  CONSTRAINT fk_stroke_pathway_events_encounter
    FOREIGN KEY (encounter_id) REFERENCES patient_encounters(id) ON DELETE SET NULL,
  CONSTRAINT fk_stroke_pathway_events_timeline
    FOREIGN KEY (canonical_timeline_event_id) REFERENCES clinical_timeline_events(id) ON DELETE SET NULL,
  CONSTRAINT stroke_pathway_events_type_check
    CHECK (event_type IN ('ct_order', 'ct_start', 'ct_result', 'neurology_review', 'decision', 'treatment_start', 'transfer', 'disposition')),
  CONSTRAINT stroke_pathway_events_payload_object
    CHECK (jsonb_typeof(event_payload) = 'object'),
  CONSTRAINT stroke_pathway_events_metadata_object
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_stroke_pathway_events_activation
  ON stroke_pathway_events (tenant_id, activation_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_stroke_pathway_events_patient
  ON stroke_pathway_events (tenant_id, patient_uid, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_stroke_pathway_events_type
  ON stroke_pathway_events (tenant_id, event_type, occurred_at DESC);

ALTER TABLE stroke_pathway_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE stroke_pathway_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON stroke_pathway_events;
CREATE POLICY tenant_isolation ON stroke_pathway_events
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
