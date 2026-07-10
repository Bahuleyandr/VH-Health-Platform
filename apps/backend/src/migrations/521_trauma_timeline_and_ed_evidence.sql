-- NL-14 P2: append-only trauma timeline and ED encounter evidence links.
-- NL-7 keeps owning device transport/association/downsampling. These tables
-- only link already-stored vitals or device observations to the ED encounter.

BEGIN;

CREATE TABLE IF NOT EXISTS trauma_timeline_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  trauma_activation_id BIGINT NOT NULL REFERENCES trauma_activations(id) ON DELETE CASCADE,
  emergency_visit_id INTEGER REFERENCES emergency_visits(id) ON DELETE SET NULL,
  patient_uid UUID REFERENCES users(uid) ON DELETE RESTRICT,
  occurred_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  event_type VARCHAR(60) NOT NULL,
  event_label VARCHAR(180),
  intervention_details JSONB NOT NULL DEFAULT '{}'::jsonb,
  performed_by_uid UUID,
  source_citations JSONB NOT NULL DEFAULT '[]'::jsonb,
  timeline_event_id UUID REFERENCES clinical_timeline_events(id) ON DELETE SET NULL,
  audit_event_id UUID REFERENCES clinical_audit_events(id) ON DELETE SET NULL,
  created_by_uid UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT trauma_timeline_events_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT trauma_timeline_events_type_check CHECK (
    event_type IN (
      'arrival', 'airway', 'breathing', 'circulation', 'disability', 'exposure',
      'fast', 'imaging', 'procedure', 'medication_reference', 'blood_product',
      'fluid', 'consult', 'transfer', 'reassessment', 'note'
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_trauma_timeline_activation_time
  ON trauma_timeline_events (tenant_id, trauma_activation_id, occurred_at, id);

CREATE INDEX IF NOT EXISTS idx_trauma_timeline_patient
  ON trauma_timeline_events (tenant_id, patient_uid, occurred_at DESC)
  WHERE patient_uid IS NOT NULL;

CREATE TABLE IF NOT EXISTS ed_encounter_evidence (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  emergency_visit_id INTEGER NOT NULL REFERENCES emergency_visits(id) ON DELETE CASCADE,
  patient_uid UUID REFERENCES users(uid) ON DELETE RESTRICT,
  evidence_kind VARCHAR(40) NOT NULL,
  vitals_chart_id INTEGER REFERENCES vitals_chart(id) ON DELETE SET NULL,
  device_vital_sample_observation_id INTEGER REFERENCES device_vital_sample_observations(id) ON DELETE SET NULL,
  device_registry_id INTEGER REFERENCES device_registry(id) ON DELETE SET NULL,
  observed_at TIMESTAMPTZ(6),
  verified BOOLEAN,
  linked_by_uid UUID,
  linked_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  timeline_event_id UUID REFERENCES clinical_timeline_events(id) ON DELETE SET NULL,
  audit_event_id UUID REFERENCES clinical_audit_events(id) ON DELETE SET NULL,
  CONSTRAINT ed_encounter_evidence_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT ed_encounter_evidence_kind_check CHECK (
    evidence_kind IN ('vital_snapshot', 'device_observation')
  ),
  CONSTRAINT ed_encounter_evidence_one_source_check CHECK (
    (evidence_kind = 'vital_snapshot' AND vitals_chart_id IS NOT NULL AND device_vital_sample_observation_id IS NULL)
    OR
    (evidence_kind = 'device_observation' AND device_vital_sample_observation_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_ed_evidence_vitals
  ON ed_encounter_evidence (tenant_id, emergency_visit_id, vitals_chart_id)
  WHERE vitals_chart_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_ed_evidence_device_observation
  ON ed_encounter_evidence (tenant_id, emergency_visit_id, device_vital_sample_observation_id)
  WHERE device_vital_sample_observation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ed_evidence_visit
  ON ed_encounter_evidence (tenant_id, emergency_visit_id, linked_at DESC);

ALTER TABLE trauma_timeline_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE trauma_timeline_events FORCE ROW LEVEL SECURITY;
ALTER TABLE ed_encounter_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE ed_encounter_evidence FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON trauma_timeline_events;
CREATE POLICY tenant_isolation ON trauma_timeline_events
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

DROP POLICY IF EXISTS tenant_isolation ON ed_encounter_evidence;
CREATE POLICY tenant_isolation ON ed_encounter_evidence
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
