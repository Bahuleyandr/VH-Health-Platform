-- NL-13 P2: owner-governed stroke activation registry.
-- Stroke writes are PHI and remain inert behind stroke_pathway_settings
-- until a tenant owner enables the pathway with source/version metadata.

CREATE TABLE IF NOT EXISTS stroke_activations (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  activation_uid UUID NOT NULL DEFAULT gen_random_uuid(),
  patient_uid UUID NOT NULL,
  encounter_id UUID,
  activation_source VARCHAR(80) NOT NULL,
  last_known_well_at TIMESTAMPTZ,
  arrived_at TIMESTAMPTZ,
  door_time_at TIMESTAMPTZ NOT NULL,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  team JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(40) NOT NULL DEFAULT 'active',
  radiology_context_tags TEXT[] NOT NULL DEFAULT ARRAY['code_stroke']::TEXT[],
  radiology_signal_codes TEXT[] NOT NULL DEFAULT ARRAY['STROKE_PROTOCOL']::TEXT[],
  canonical_timeline_event_id UUID,
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_stroke_activations_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_stroke_activations_patient
    FOREIGN KEY (patient_uid) REFERENCES users(uid) ON DELETE RESTRICT,
  CONSTRAINT fk_stroke_activations_encounter
    FOREIGN KEY (encounter_id) REFERENCES patient_encounters(id) ON DELETE SET NULL,
  CONSTRAINT fk_stroke_activations_timeline
    FOREIGN KEY (canonical_timeline_event_id) REFERENCES clinical_timeline_events(id) ON DELETE SET NULL,
  CONSTRAINT stroke_activations_status_check
    CHECK (status IN ('active', 'imaging', 'decision_pending', 'treated', 'transferred', 'disposed', 'closed', 'cancelled')),
  CONSTRAINT stroke_activations_team_object
    CHECK (jsonb_typeof(team) = 'object'),
  CONSTRAINT stroke_activations_metadata_object
    CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT stroke_activations_last_known_well_clock
    CHECK (last_known_well_at IS NULL OR last_known_well_at <= door_time_at),
  CONSTRAINT stroke_activations_arrival_clock
    CHECK (arrived_at IS NULL OR arrived_at <= activated_at),
  CONSTRAINT stroke_activations_door_clock
    CHECK (door_time_at <= activated_at + INTERVAL '5 minutes')
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_stroke_activations_uid
  ON stroke_activations (tenant_id, activation_uid);

CREATE INDEX IF NOT EXISTS idx_stroke_activations_patient
  ON stroke_activations (tenant_id, patient_uid, activated_at DESC);

CREATE INDEX IF NOT EXISTS idx_stroke_activations_status
  ON stroke_activations (tenant_id, status, activated_at DESC);

CREATE INDEX IF NOT EXISTS idx_stroke_activations_encounter
  ON stroke_activations (tenant_id, encounter_id)
  WHERE encounter_id IS NOT NULL;

ALTER TABLE stroke_activations ENABLE ROW LEVEL SECURITY;
ALTER TABLE stroke_activations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON stroke_activations;
CREATE POLICY tenant_isolation ON stroke_activations
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
