-- NL-14 P2: MLC completeness gate and audit trail.
-- Assistant drafts may prefill fields, but only reviewed completeness rows can
-- unblock certification.

BEGIN;

CREATE TABLE IF NOT EXISTS mlc_completeness_reviews (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  mlc_record_id INTEGER NOT NULL REFERENCES mlc_records(id) ON DELETE CASCADE,
  emergency_visit_id INTEGER REFERENCES emergency_visits(id) ON DELETE SET NULL,
  patient_uid UUID REFERENCES users(uid) ON DELETE RESTRICT,
  alleged_history TEXT,
  injury_description TEXT,
  injury_diagram_complete BOOLEAN NOT NULL DEFAULT FALSE,
  police_notification_complete BOOLEAN NOT NULL DEFAULT FALSE,
  certificate_signer_uid UUID REFERENCES users(uid) ON DELETE RESTRICT,
  chain_of_custody_complete BOOLEAN NOT NULL DEFAULT FALSE,
  closure_requirements JSONB NOT NULL DEFAULT '{}'::jsonb,
  assistant_prefill_output_id INTEGER,
  assistant_prefill_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  missing_required_fields TEXT[] NOT NULL DEFAULT '{}',
  completeness_status VARCHAR(24) NOT NULL DEFAULT 'incomplete',
  reviewed_by_uid UUID REFERENCES users(uid) ON DELETE RESTRICT,
  reviewed_at TIMESTAMPTZ(6),
  certification_blocked BOOLEAN NOT NULL DEFAULT TRUE,
  timeline_event_id UUID REFERENCES clinical_timeline_events(id) ON DELETE SET NULL,
  audit_event_id UUID REFERENCES clinical_audit_events(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT mlc_completeness_reviews_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT mlc_completeness_status_check CHECK (
    completeness_status IN ('incomplete', 'complete', 'certified', 'closed')
  ),
  CONSTRAINT mlc_completeness_complete_requires_human_review CHECK (
    completeness_status <> 'complete'
    OR (
      alleged_history IS NOT NULL
      AND injury_description IS NOT NULL
      AND injury_diagram_complete = TRUE
      AND police_notification_complete = TRUE
      AND certificate_signer_uid IS NOT NULL
      AND chain_of_custody_complete = TRUE
      AND cardinality(missing_required_fields) = 0
      AND certification_blocked = FALSE
      AND reviewed_by_uid IS NOT NULL
      AND reviewed_at IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_mlc_completeness_latest_record
  ON mlc_completeness_reviews (tenant_id, mlc_record_id);

CREATE INDEX IF NOT EXISTS idx_mlc_completeness_status
  ON mlc_completeness_reviews (tenant_id, completeness_status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_mlc_completeness_patient
  ON mlc_completeness_reviews (tenant_id, patient_uid, updated_at DESC)
  WHERE patient_uid IS NOT NULL;

CREATE TABLE IF NOT EXISTS mlc_completeness_audit_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  mlc_completeness_review_id BIGINT NOT NULL REFERENCES mlc_completeness_reviews(id) ON DELETE CASCADE,
  mlc_record_id INTEGER NOT NULL REFERENCES mlc_records(id) ON DELETE CASCADE,
  patient_uid UUID REFERENCES users(uid) ON DELETE RESTRICT,
  action VARCHAR(60) NOT NULL,
  actor_uid UUID REFERENCES users(uid) ON DELETE SET NULL,
  before_state JSONB,
  after_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT mlc_completeness_audit_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT mlc_completeness_audit_action_check CHECK (
    action IN ('prefilled', 'reviewed', 'completed', 'certification_blocked', 'certified', 'closed')
  )
);

CREATE INDEX IF NOT EXISTS idx_mlc_completeness_audit_review
  ON mlc_completeness_audit_events (tenant_id, mlc_completeness_review_id, occurred_at DESC);

ALTER TABLE mlc_completeness_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE mlc_completeness_reviews FORCE ROW LEVEL SECURITY;
ALTER TABLE mlc_completeness_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE mlc_completeness_audit_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON mlc_completeness_reviews;
CREATE POLICY tenant_isolation ON mlc_completeness_reviews
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

DROP POLICY IF EXISTS tenant_isolation ON mlc_completeness_audit_events;
CREATE POLICY tenant_isolation ON mlc_completeness_audit_events
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
