-- NL-13 P2: owner-sourced thrombolysis decision records.
-- Protocol criteria, exclusions, and dose content are tenant-owner supplied;
-- the application never seeds or infers drug criteria from model memory.

CREATE TABLE IF NOT EXISTS stroke_thrombolysis_decisions (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  activation_id BIGINT NOT NULL,
  patient_uid UUID NOT NULL,
  encounter_id UUID,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decision_status VARCHAR(30) NOT NULL DEFAULT 'draft',
  eligibility_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  contraindication_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  dose_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  decision_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  protocol_source TEXT,
  protocol_version TEXT,
  protocol_attachment_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  patient_family_documentation JSONB NOT NULL DEFAULT '{}'::jsonb,
  approver_uid UUID,
  approver_privilege_key VARCHAR(120),
  approved_at TIMESTAMPTZ,
  canonical_timeline_event_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_stroke_thrombolysis_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_stroke_thrombolysis_activation
    FOREIGN KEY (activation_id) REFERENCES stroke_activations(id) ON DELETE CASCADE,
  CONSTRAINT fk_stroke_thrombolysis_patient
    FOREIGN KEY (patient_uid) REFERENCES users(uid) ON DELETE RESTRICT,
  CONSTRAINT fk_stroke_thrombolysis_encounter
    FOREIGN KEY (encounter_id) REFERENCES patient_encounters(id) ON DELETE SET NULL,
  CONSTRAINT fk_stroke_thrombolysis_timeline
    FOREIGN KEY (canonical_timeline_event_id) REFERENCES clinical_timeline_events(id) ON DELETE SET NULL,
  CONSTRAINT stroke_thrombolysis_status_check
    CHECK (decision_status IN ('draft', 'pending_approval', 'approved', 'withheld', 'rejected', 'administered', 'cancelled')),
  CONSTRAINT stroke_thrombolysis_payloads_object
    CHECK (
      jsonb_typeof(eligibility_payload) = 'object'
      AND jsonb_typeof(contraindication_payload) = 'object'
      AND jsonb_typeof(dose_payload) = 'object'
      AND jsonb_typeof(decision_payload) = 'object'
      AND jsonb_typeof(patient_family_documentation) = 'object'
      AND jsonb_typeof(metadata) = 'object'
    ),
  CONSTRAINT stroke_thrombolysis_attachments_array
    CHECK (jsonb_typeof(protocol_attachment_refs) = 'array'),
  CONSTRAINT stroke_thrombolysis_approval_metadata_check
    CHECK (
      decision_status NOT IN ('approved', 'administered')
      OR (
        NULLIF(BTRIM(COALESCE(protocol_source, '')), '') IS NOT NULL
        AND NULLIF(BTRIM(COALESCE(protocol_version, '')), '') IS NOT NULL
        AND approver_uid IS NOT NULL
        AND approved_at IS NOT NULL
        AND NULLIF(BTRIM(COALESCE(approver_privilege_key, '')), '') IS NOT NULL
      )
    )
);

CREATE INDEX IF NOT EXISTS idx_stroke_thrombolysis_activation
  ON stroke_thrombolysis_decisions (tenant_id, activation_id, decided_at DESC);

CREATE INDEX IF NOT EXISTS idx_stroke_thrombolysis_patient
  ON stroke_thrombolysis_decisions (tenant_id, patient_uid, decided_at DESC);

CREATE INDEX IF NOT EXISTS idx_stroke_thrombolysis_status
  ON stroke_thrombolysis_decisions (tenant_id, decision_status, decided_at DESC);

ALTER TABLE stroke_thrombolysis_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE stroke_thrombolysis_decisions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON stroke_thrombolysis_decisions;
CREATE POLICY tenant_isolation ON stroke_thrombolysis_decisions
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
