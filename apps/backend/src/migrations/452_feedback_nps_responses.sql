-- 452_feedback_nps_responses.sql
-- NL9-P2: dedicated NPS response ledger. Keep NPS separate from 1-5 star
-- feedback so legacy rating flows are not overloaded or reinterpreted.

BEGIN;

CREATE TABLE IF NOT EXISTS feedback_nps_responses (
  id                           BIGSERIAL PRIMARY KEY,
  tenant_id                    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_uid                  UUID NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  feedback_id                  INTEGER REFERENCES feedback(id) ON DELETE SET NULL,
  appointment_id               INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  encounter_type               VARCHAR(40) NOT NULL DEFAULT 'appointment'
    CHECK (encounter_type IN ('appointment', 'teleconsult', 'admission', 'rpm_episode', 'manual', 'other')),
  encounter_ref                VARCHAR(120),
  score                        SMALLINT NOT NULL CHECK (score BETWEEN 0 AND 10),
  nps_bucket                   VARCHAR(20) NOT NULL
    CHECK (nps_bucket IN ('detractor', 'passive', 'promoter')),
  channel                      VARCHAR(30) NOT NULL DEFAULT 'app'
    CHECK (channel IN ('app', 'web', 'sms', 'whatsapp', 'email', 'voice', 'kiosk', 'manual', 'other')),
  consent_id                   INTEGER REFERENCES patient_consents(id) ON DELETE SET NULL,
  comment                      TEXT,
  comment_redaction_status     VARCHAR(30) NOT NULL DEFAULT 'not_reviewed'
    CHECK (comment_redaction_status IN ('not_reviewed', 'safe', 'redacted', 'requires_review')),
  comment_redaction_metadata   JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_campaign_recipient_id BIGINT,
  dedupe_key                   VARCHAR(160) NOT NULL,
  department_id                INTEGER,
  department_display_name      VARCHAR(255),
  doctor_id                    INTEGER,
  doctor_display_name          VARCHAR(255),
  service_line                 VARCHAR(120),
  submitted_at                 TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  created_by                   UUID,
  created_at                   TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at                   TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT feedback_nps_bucket_score_ck CHECK (
    (score BETWEEN 0 AND 6 AND nps_bucket = 'detractor')
    OR (score BETWEEN 7 AND 8 AND nps_bucket = 'passive')
    OR (score BETWEEN 9 AND 10 AND nps_bucket = 'promoter')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_feedback_nps_responses_dedupe
  ON feedback_nps_responses (tenant_id, dedupe_key);

CREATE INDEX IF NOT EXISTS idx_feedback_nps_tenant_submitted
  ON feedback_nps_responses (tenant_id, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_nps_patient
  ON feedback_nps_responses (tenant_id, patient_uid, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_nps_score_bucket
  ON feedback_nps_responses (tenant_id, nps_bucket, score, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_nps_department
  ON feedback_nps_responses (tenant_id, department_id, submitted_at DESC)
  WHERE department_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_feedback_nps_doctor
  ON feedback_nps_responses (tenant_id, doctor_id, submitted_at DESC)
  WHERE doctor_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_feedback_nps_appointment
  ON feedback_nps_responses (tenant_id, appointment_id)
  WHERE appointment_id IS NOT NULL;

ALTER TABLE feedback_nps_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback_nps_responses FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON feedback_nps_responses;
CREATE POLICY tenant_isolation ON feedback_nps_responses
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
