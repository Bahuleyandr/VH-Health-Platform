-- NL-13 P2: structured NIHSS assessments.
-- Sign-off is application-gated on owner source/version metadata; the table
-- stores the exact version used for audit and patient-timeline traceability.

CREATE TABLE IF NOT EXISTS stroke_nihss_assessments (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  activation_id BIGINT NOT NULL,
  patient_uid UUID NOT NULL,
  encounter_id UUID,
  assessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assessor_uid UUID,
  item_scores JSONB NOT NULL DEFAULT '[]'::jsonb,
  total_score INTEGER NOT NULL,
  nihss_source TEXT,
  nihss_version TEXT,
  source_owner_uid UUID,
  source_attachment_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  signoff_status VARCHAR(20) NOT NULL DEFAULT 'draft',
  signed_off_by UUID,
  signed_off_at TIMESTAMPTZ,
  canonical_timeline_event_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_stroke_nihss_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_stroke_nihss_activation
    FOREIGN KEY (activation_id) REFERENCES stroke_activations(id) ON DELETE CASCADE,
  CONSTRAINT fk_stroke_nihss_patient
    FOREIGN KEY (patient_uid) REFERENCES users(uid) ON DELETE RESTRICT,
  CONSTRAINT fk_stroke_nihss_encounter
    FOREIGN KEY (encounter_id) REFERENCES patient_encounters(id) ON DELETE SET NULL,
  CONSTRAINT fk_stroke_nihss_timeline
    FOREIGN KEY (canonical_timeline_event_id) REFERENCES clinical_timeline_events(id) ON DELETE SET NULL,
  CONSTRAINT stroke_nihss_total_check
    CHECK (total_score BETWEEN 0 AND 42),
  CONSTRAINT stroke_nihss_items_json
    CHECK (jsonb_typeof(item_scores) IN ('array', 'object')),
  CONSTRAINT stroke_nihss_attachments_json
    CHECK (jsonb_typeof(source_attachment_refs) = 'array'),
  CONSTRAINT stroke_nihss_metadata_object
    CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT stroke_nihss_signoff_status_check
    CHECK (signoff_status IN ('draft', 'signed', 'amended', 'cancelled')),
  CONSTRAINT stroke_nihss_signed_metadata_check
    CHECK (
      signoff_status <> 'signed'
      OR (
        NULLIF(BTRIM(COALESCE(nihss_source, '')), '') IS NOT NULL
        AND NULLIF(BTRIM(COALESCE(nihss_version, '')), '') IS NOT NULL
        AND signed_off_by IS NOT NULL
        AND signed_off_at IS NOT NULL
      )
    )
);

CREATE INDEX IF NOT EXISTS idx_stroke_nihss_activation
  ON stroke_nihss_assessments (tenant_id, activation_id, assessed_at DESC);

CREATE INDEX IF NOT EXISTS idx_stroke_nihss_patient
  ON stroke_nihss_assessments (tenant_id, patient_uid, assessed_at DESC);

ALTER TABLE stroke_nihss_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE stroke_nihss_assessments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON stroke_nihss_assessments;
CREATE POLICY tenant_isolation ON stroke_nihss_assessments
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
