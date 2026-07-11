-- NL-13 P5: Perfusion records and required sign-offs.

CREATE TABLE IF NOT EXISTS perfusion_records (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  ctvs_case_overlay_id INTEGER REFERENCES ctvs_case_overlays(id) ON DELETE SET NULL,
  ot_schedule_id INTEGER NOT NULL REFERENCES ot_schedules(id) ON DELETE CASCADE,
  patient_uid UUID NOT NULL REFERENCES users(uid) ON DELETE RESTRICT,
  anesthesia_record_id INTEGER REFERENCES anesthesia_records(id) ON DELETE SET NULL,
  perfusionist_uid UUID REFERENCES users(uid) ON DELETE SET NULL,
  bypass_started_at TIMESTAMPTZ(6),
  bypass_ended_at TIMESTAMPTZ(6),
  bypass_time_minutes NUMERIC(8,2),
  cross_clamp_started_at TIMESTAMPTZ(6),
  cross_clamp_ended_at TIMESTAMPTZ(6),
  cross_clamp_time_minutes NUMERIC(8,2),
  act_baseline_seconds NUMERIC(8,2),
  act_peak_seconds NUMERIC(8,2),
  act_last_seconds NUMERIC(8,2),
  temperature_min_c NUMERIC(5,2),
  temperature_max_c NUMERIC(5,2),
  act_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  temperature_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  fluids_products_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  complications TEXT,
  status VARCHAR(24) NOT NULL DEFAULT 'recorded',
  evidence_owner_uid UUID REFERENCES users(uid) ON DELETE SET NULL,
  record_policy_source_label VARCHAR(180),
  record_policy_source_version VARCHAR(80),
  source_document_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  attachment_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_by UUID REFERENCES users(uid) ON DELETE SET NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_perfusion_records_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT perfusion_records_status_check
    CHECK (status IN ('draft', 'recorded', 'amended', 'voided')),
  CONSTRAINT perfusion_records_bypass_order
    CHECK (bypass_ended_at IS NULL OR (bypass_started_at IS NOT NULL AND bypass_ended_at >= bypass_started_at)),
  CONSTRAINT perfusion_records_cross_clamp_order
    CHECK (cross_clamp_ended_at IS NULL OR (cross_clamp_started_at IS NOT NULL AND cross_clamp_ended_at >= cross_clamp_started_at)),
  CONSTRAINT perfusion_records_cross_clamp_inside_bypass
    CHECK (
      bypass_started_at IS NULL
      OR cross_clamp_started_at IS NULL
      OR cross_clamp_started_at >= bypass_started_at
    ),
  CONSTRAINT perfusion_records_cross_clamp_end_inside_bypass
    CHECK (
      bypass_ended_at IS NULL
      OR cross_clamp_ended_at IS NULL
      OR cross_clamp_ended_at <= bypass_ended_at
    ),
  CONSTRAINT perfusion_records_act_summary_object
    CHECK (jsonb_typeof(act_summary) = 'object'),
  CONSTRAINT perfusion_records_temperature_summary_object
    CHECK (jsonb_typeof(temperature_summary) = 'object'),
  CONSTRAINT perfusion_records_fluids_summary_object
    CHECK (jsonb_typeof(fluids_products_summary) = 'object'),
  CONSTRAINT perfusion_records_source_refs_array
    CHECK (jsonb_typeof(source_document_refs) = 'array'),
  CONSTRAINT perfusion_records_attachment_refs_array
    CHECK (jsonb_typeof(attachment_refs) = 'array'),
  UNIQUE (tenant_id, ot_schedule_id)
);

CREATE INDEX IF NOT EXISTS idx_perfusion_records_patient
  ON perfusion_records (tenant_id, patient_uid, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_perfusion_records_case
  ON perfusion_records (tenant_id, ot_schedule_id);

CREATE INDEX IF NOT EXISTS idx_perfusion_records_perfusionist
  ON perfusion_records (tenant_id, perfusionist_uid, created_at DESC)
  WHERE perfusionist_uid IS NOT NULL;

ALTER TABLE perfusion_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE perfusion_records FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON perfusion_records;
CREATE POLICY tenant_isolation ON perfusion_records
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

CREATE TABLE IF NOT EXISTS perfusion_signoffs (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  perfusion_record_id INTEGER NOT NULL REFERENCES perfusion_records(id) ON DELETE CASCADE,
  ot_schedule_id INTEGER NOT NULL REFERENCES ot_schedules(id) ON DELETE CASCADE,
  patient_uid UUID NOT NULL REFERENCES users(uid) ON DELETE RESTRICT,
  perfusionist_signed_by UUID REFERENCES users(uid) ON DELETE SET NULL,
  perfusionist_signed_at TIMESTAMPTZ(6),
  surgeon_reviewed_by UUID REFERENCES users(uid) ON DELETE SET NULL,
  surgeon_reviewed_at TIMESTAMPTZ(6),
  anesthesia_reviewed_by UUID REFERENCES users(uid) ON DELETE SET NULL,
  anesthesia_reviewed_at TIMESTAMPTZ(6),
  status VARCHAR(32) NOT NULL DEFAULT 'draft',
  finalized_by UUID REFERENCES users(uid) ON DELETE SET NULL,
  finalized_at TIMESTAMPTZ(6),
  evidence_owner_uid UUID REFERENCES users(uid) ON DELETE SET NULL,
  signoff_policy_source_label VARCHAR(180),
  signoff_policy_source_version VARCHAR(80),
  source_document_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  attachment_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_perfusion_signoffs_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT perfusion_signoffs_status_check
    CHECK (status IN ('draft', 'perfusionist_signed', 'surgeon_reviewed', 'anesthesia_reviewed', 'ready_for_finalize', 'finalized')),
  CONSTRAINT perfusion_signoffs_perfusionist_pair
    CHECK ((perfusionist_signed_by IS NULL AND perfusionist_signed_at IS NULL) OR (perfusionist_signed_by IS NOT NULL AND perfusionist_signed_at IS NOT NULL)),
  CONSTRAINT perfusion_signoffs_surgeon_pair
    CHECK ((surgeon_reviewed_by IS NULL AND surgeon_reviewed_at IS NULL) OR (surgeon_reviewed_by IS NOT NULL AND surgeon_reviewed_at IS NOT NULL)),
  CONSTRAINT perfusion_signoffs_anesthesia_pair
    CHECK ((anesthesia_reviewed_by IS NULL AND anesthesia_reviewed_at IS NULL) OR (anesthesia_reviewed_by IS NOT NULL AND anesthesia_reviewed_at IS NOT NULL)),
  CONSTRAINT perfusion_signoffs_finalize_requires_reviews
    CHECK (
      finalized_at IS NULL
      OR (
        perfusionist_signed_by IS NOT NULL
        AND surgeon_reviewed_by IS NOT NULL
        AND anesthesia_reviewed_by IS NOT NULL
        AND finalized_by IS NOT NULL
      )
    ),
  CONSTRAINT perfusion_signoffs_source_refs_array
    CHECK (jsonb_typeof(source_document_refs) = 'array'),
  CONSTRAINT perfusion_signoffs_attachment_refs_array
    CHECK (jsonb_typeof(attachment_refs) = 'array'),
  UNIQUE (tenant_id, perfusion_record_id)
);

CREATE INDEX IF NOT EXISTS idx_perfusion_signoffs_patient
  ON perfusion_signoffs (tenant_id, patient_uid, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_perfusion_signoffs_case
  ON perfusion_signoffs (tenant_id, ot_schedule_id);

ALTER TABLE perfusion_signoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE perfusion_signoffs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON perfusion_signoffs;
CREATE POLICY tenant_isolation ON perfusion_signoffs
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
