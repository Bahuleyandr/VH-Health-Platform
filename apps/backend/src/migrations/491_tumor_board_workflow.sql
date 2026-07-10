-- NL-13 P3: tumor board meetings, cases, and recommendations.

BEGIN;

CREATE TABLE IF NOT EXISTS tumor_board_meetings (
  id                         BIGSERIAL PRIMARY KEY,
  tenant_id                  UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  service_line               VARCHAR(120) NOT NULL,
  meeting_date               TIMESTAMPTZ(6) NOT NULL,
  chair_uid                  UUID,
  attendee_uids              UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  external_attendees         JSONB NOT NULL DEFAULT '[]'::jsonb,
  quorum_reference           TEXT NOT NULL,
  status                     VARCHAR(24) NOT NULL DEFAULT 'scheduled',
  notes                      TEXT,
  created_by                 UUID,
  created_at                 TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                 TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_tumor_board_meetings_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT chk_tumor_board_meetings_status
    CHECK (status IN ('scheduled', 'in_session', 'completed', 'cancelled')),
  CONSTRAINT chk_tumor_board_meetings_external_array
    CHECK (jsonb_typeof(external_attendees) = 'array')
);

CREATE TABLE IF NOT EXISTS tumor_board_cases (
  id                         BIGSERIAL PRIMARY KEY,
  tenant_id                  UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  patient_uid                UUID NOT NULL,
  meeting_id                 BIGINT,
  diagnosis_id               BIGINT NOT NULL,
  staging_record_id          BIGINT,
  ap_report_id               BIGINT,
  radiology_order_id         INTEGER,
  question                   TEXT NOT NULL,
  priority                   VARCHAR(20) NOT NULL DEFAULT 'routine',
  discussion_state           VARCHAR(24) NOT NULL DEFAULT 'queued',
  discussion_summary         TEXT,
  presented_by               UUID,
  canonical_timeline_event_id UUID,
  created_by                 UUID,
  created_at                 TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                 TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_tumor_board_cases_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_tumor_board_cases_meeting
    FOREIGN KEY (meeting_id) REFERENCES tumor_board_meetings(id) ON DELETE SET NULL,
  CONSTRAINT fk_tumor_board_cases_diagnosis
    FOREIGN KEY (diagnosis_id) REFERENCES oncology_diagnoses(id) ON DELETE CASCADE,
  CONSTRAINT fk_tumor_board_cases_staging
    FOREIGN KEY (staging_record_id) REFERENCES oncology_staging_records(id) ON DELETE SET NULL,
  CONSTRAINT fk_tumor_board_cases_ap_report
    FOREIGN KEY (ap_report_id) REFERENCES ap_reports(id) ON DELETE SET NULL,
  CONSTRAINT fk_tumor_board_cases_radiology_order
    FOREIGN KEY (radiology_order_id) REFERENCES radiology_orders(id) ON DELETE SET NULL,
  CONSTRAINT fk_tumor_board_cases_timeline
    FOREIGN KEY (canonical_timeline_event_id) REFERENCES clinical_timeline_events(id) ON DELETE SET NULL,
  CONSTRAINT chk_tumor_board_cases_priority
    CHECK (priority IN ('routine', 'urgent', 'expedite')),
  CONSTRAINT chk_tumor_board_cases_state
    CHECK (discussion_state IN ('queued', 'in_review', 'recommended', 'deferred', 'cancelled'))
);

CREATE TABLE IF NOT EXISTS tumor_board_recommendations (
  id                         BIGSERIAL PRIMARY KEY,
  tenant_id                  UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  patient_uid                UUID NOT NULL,
  tumor_board_case_id        BIGINT NOT NULL,
  recommendation_type        VARCHAR(60) NOT NULL,
  recommendation_text        TEXT NOT NULL,
  responsible_owner_uid      UUID,
  due_date                   DATE,
  status                     VARCHAR(24) NOT NULL DEFAULT 'proposed',
  acceptance_note            TEXT,
  defer_reason               TEXT,
  chemo_plan_id              INTEGER,
  canonical_timeline_event_id UUID,
  created_by                 UUID,
  created_at                 TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                 TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_tumor_board_recommendations_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_tumor_board_recommendations_case
    FOREIGN KEY (tumor_board_case_id) REFERENCES tumor_board_cases(id) ON DELETE CASCADE,
  CONSTRAINT fk_tumor_board_recommendations_chemo_plan
    FOREIGN KEY (chemo_plan_id) REFERENCES chemo_treatment_plans(id) ON DELETE SET NULL,
  CONSTRAINT fk_tumor_board_recommendations_timeline
    FOREIGN KEY (canonical_timeline_event_id) REFERENCES clinical_timeline_events(id) ON DELETE SET NULL,
  CONSTRAINT chk_tumor_board_recommendations_status
    CHECK (status IN ('proposed', 'accepted', 'deferred', 'completed', 'cancelled')),
  CONSTRAINT chk_tumor_board_recommendations_type
    CHECK (recommendation_type IN ('systemic_therapy', 'radiation', 'surgery', 'diagnostics', 'palliative', 'surveillance', 'trial', 'supportive_care', 'other'))
);

CREATE INDEX IF NOT EXISTS idx_tumor_board_meetings_date
  ON tumor_board_meetings (tenant_id, meeting_date DESC);

CREATE INDEX IF NOT EXISTS idx_tumor_board_cases_queue
  ON tumor_board_cases (tenant_id, discussion_state, priority, created_at);

CREATE INDEX IF NOT EXISTS idx_tumor_board_cases_patient
  ON tumor_board_cases (tenant_id, patient_uid, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tumor_board_recommendations_case
  ON tumor_board_recommendations (tenant_id, tumor_board_case_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tumor_board_recommendations_due
  ON tumor_board_recommendations (tenant_id, due_date)
  WHERE due_date IS NOT NULL AND status IN ('proposed', 'accepted');

ALTER TABLE tumor_board_meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tumor_board_meetings FORCE ROW LEVEL SECURITY;
ALTER TABLE tumor_board_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE tumor_board_cases FORCE ROW LEVEL SECURITY;
ALTER TABLE tumor_board_recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tumor_board_recommendations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON tumor_board_meetings;
CREATE POLICY tenant_isolation ON tumor_board_meetings
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

DROP POLICY IF EXISTS tenant_isolation ON tumor_board_cases;
CREATE POLICY tenant_isolation ON tumor_board_cases
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

DROP POLICY IF EXISTS tenant_isolation ON tumor_board_recommendations;
CREATE POLICY tenant_isolation ON tumor_board_recommendations
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

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'ONCOLOGY_TUMOR_BOARD_WORKFLOW_APPLIED',
  'tumor_board_cases',
  '491_tumor_board_workflow.sql',
  jsonb_build_object(
    'migration', '491_tumor_board_workflow.sql',
    'suite', 'NL-13 P3 oncology completion'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'ONCOLOGY_TUMOR_BOARD_WORKFLOW_APPLIED'
    AND resource_id = '491_tumor_board_workflow.sql'
);

COMMIT;
