-- NL-13 P1c: tenant-scoped Code-STEMI activation registry.
-- Clinical criteria and timing targets are owner-supplied metadata only. This
-- table does not evaluate or seed diagnostic criteria.

BEGIN;

CREATE TABLE IF NOT EXISTS stemi_activations (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  activation_uid UUID NOT NULL DEFAULT gen_random_uuid(),
  patient_uid UUID NOT NULL,
  encounter_id UUID,
  emergency_visit_id INTEGER,
  prehospital_handover_id BIGINT,
  cath_case_id BIGINT,
  activation_source VARCHAR(40) NOT NULL,
  symptom_onset_at TIMESTAMPTZ(6),
  last_known_well_at TIMESTAMPTZ(6),
  first_medical_contact_at TIMESTAMPTZ(6),
  door_time_at TIMESTAMPTZ(6),
  ecg_at TIMESTAMPTZ(6),
  activated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  lab_notified_at TIMESTAMPTZ(6),
  in_lab_at TIMESTAMPTZ(6),
  device_deployed_at TIMESTAMPTZ(6),
  completed_at TIMESTAMPTZ(6),
  stood_down_at TIMESTAMPTZ(6),
  team JSONB NOT NULL DEFAULT '{"members":[]}'::jsonb,
  status VARCHAR(32) NOT NULL DEFAULT 'activated',
  stand_down_reason TEXT,
  activation_criteria JSONB NOT NULL DEFAULT '{}'::jsonb,
  owner_target_minutes JSONB NOT NULL DEFAULT '{}'::jsonb,
  clock_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  canonical_timeline_event_id UUID,
  canonical_audit_event_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_stemi_activations_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_stemi_activations_patient
    FOREIGN KEY (patient_uid) REFERENCES users(uid) ON DELETE RESTRICT,
  CONSTRAINT fk_stemi_activations_encounter
    FOREIGN KEY (encounter_id) REFERENCES patient_encounters(id) ON DELETE SET NULL,
  CONSTRAINT fk_stemi_activations_emergency_visit
    FOREIGN KEY (emergency_visit_id) REFERENCES emergency_visits(id) ON DELETE SET NULL,
  CONSTRAINT fk_stemi_activations_prehospital_handover
    FOREIGN KEY (prehospital_handover_id) REFERENCES prehospital_handovers(id) ON DELETE SET NULL,
  CONSTRAINT fk_stemi_activations_cath_case
    FOREIGN KEY (cath_case_id) REFERENCES cath_lab_cases(id) ON DELETE SET NULL,
  CONSTRAINT fk_stemi_activations_timeline
    FOREIGN KEY (canonical_timeline_event_id) REFERENCES clinical_timeline_events(id) ON DELETE SET NULL,
  CONSTRAINT fk_stemi_activations_audit
    FOREIGN KEY (canonical_audit_event_id) REFERENCES clinical_audit_events(id) ON DELETE SET NULL,
  CONSTRAINT stemi_activations_source_check CHECK (
    activation_source IN ('ed_triage', 'ecg_auto_flag', 'clinician', 'prehospital_handover')
  ),
  CONSTRAINT stemi_activations_status_check CHECK (
    status IN ('activated', 'lab_notified', 'in_lab', 'device_deployed', 'completed', 'stood_down')
  ),
  CONSTRAINT stemi_activations_json_shapes CHECK (
    jsonb_typeof(team) = 'object'
    AND jsonb_typeof(activation_criteria) = 'object'
    AND jsonb_typeof(owner_target_minutes) = 'object'
    AND jsonb_typeof(clock_metadata) = 'object'
    AND jsonb_typeof(metadata) = 'object'
  ),
  CONSTRAINT stemi_activations_symptom_clock CHECK (
    symptom_onset_at IS NULL OR symptom_onset_at <= activated_at
  ),
  CONSTRAINT stemi_activations_last_known_well_clock CHECK (
    last_known_well_at IS NULL OR last_known_well_at <= activated_at
  ),
  CONSTRAINT stemi_activations_first_medical_contact_clock CHECK (
    first_medical_contact_at IS NULL OR first_medical_contact_at <= activated_at
  ),
  CONSTRAINT stemi_activations_door_clock CHECK (
    activation_source = 'prehospital_handover'
    OR (
      door_time_at IS NOT NULL
      AND door_time_at <= activated_at + INTERVAL '5 minutes'
    )
  ),
  CONSTRAINT stemi_activations_stand_down_reason_check CHECK (
    status <> 'stood_down'
    OR NULLIF(BTRIM(COALESCE(stand_down_reason, '')), '') IS NOT NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_stemi_activations_uid
  ON stemi_activations (tenant_id, activation_uid);

CREATE INDEX IF NOT EXISTS idx_stemi_activations_patient
  ON stemi_activations (tenant_id, patient_uid, activated_at DESC);

CREATE INDEX IF NOT EXISTS idx_stemi_activations_active
  ON stemi_activations (tenant_id, status, activated_at DESC)
  WHERE status NOT IN ('completed', 'stood_down');

CREATE UNIQUE INDEX IF NOT EXISTS ux_stemi_activations_one_active_patient
  ON stemi_activations (tenant_id, patient_uid)
  WHERE status NOT IN ('completed', 'stood_down');

CREATE INDEX IF NOT EXISTS idx_stemi_activations_encounter
  ON stemi_activations (tenant_id, encounter_id)
  WHERE encounter_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_stemi_activations_emergency_visit
  ON stemi_activations (tenant_id, emergency_visit_id)
  WHERE emergency_visit_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_stemi_activations_prehospital_handover
  ON stemi_activations (tenant_id, prehospital_handover_id)
  WHERE prehospital_handover_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_stemi_activations_cath_case
  ON stemi_activations (tenant_id, cath_case_id)
  WHERE cath_case_id IS NOT NULL;

ALTER TABLE stemi_activations ENABLE ROW LEVEL SECURITY;
ALTER TABLE stemi_activations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON stemi_activations;
CREATE POLICY tenant_isolation ON stemi_activations
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
