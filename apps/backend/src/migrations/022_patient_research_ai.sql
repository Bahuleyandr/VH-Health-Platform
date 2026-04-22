-- Batch 4: trial matcher + patient chatbot + RCA draft tables.
-- All tenant-scoped.

-- Clinical trial criteria catalog. A nightly scraper / manual-upload
-- populates this; the matcher queries it via pgvector if available.
CREATE TABLE IF NOT EXISTS clinical_trials_catalog (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nct_id VARCHAR(20) NOT NULL,
  title TEXT NOT NULL,
  phase VARCHAR(20),
  conditions TEXT[] NOT NULL DEFAULT '{}',
  eligibility_summary TEXT NOT NULL,
  age_min INTEGER,
  age_max INTEGER,
  gender VARCHAR(10) CHECK (gender IS NULL OR gender IN ('male', 'female', 'all')),
  location TEXT,
  status VARCHAR(30) NOT NULL DEFAULT 'recruiting',
  last_refreshed TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, nct_id)
);

CREATE INDEX IF NOT EXISTS idx_clinical_trials_tenant_status
  ON clinical_trials_catalog (tenant_id, status);

CREATE TABLE IF NOT EXISTS clinical_trial_match_results (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_uid UUID NOT NULL,
  admission_id INTEGER,
  trial_id INTEGER NOT NULL REFERENCES clinical_trials_catalog(id) ON DELETE CASCADE,
  match_score NUMERIC(5, 2) NOT NULL,
  match_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  coordinator_decision VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (coordinator_decision IN ('pending', 'offered', 'enrolled', 'declined', 'ineligible')),
  decided_by UUID,
  decided_at TIMESTAMPTZ,
  scored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, patient_uid, trial_id, scored_at)
);

CREATE INDEX IF NOT EXISTS idx_clinical_trial_matches_patient
  ON clinical_trial_match_results (tenant_id, patient_uid, scored_at DESC);
CREATE INDEX IF NOT EXISTS idx_clinical_trial_matches_pending
  ON clinical_trial_match_results (tenant_id)
  WHERE coordinator_decision = 'pending';

-- Patient-facing RAG chatbot conversations. Audit-logged and consent-
-- gated; every message is tied to the patient_uid and both sides of the
-- conversation are stored immutably for regulator review.
CREATE TABLE IF NOT EXISTS patient_chat_conversations (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_uid UUID NOT NULL,
  title VARCHAR(200),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'closed')),
  message_count INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  retention_until DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '365 days')
);

CREATE INDEX IF NOT EXISTS idx_patient_chat_conv_patient
  ON patient_chat_conversations (tenant_id, patient_uid, last_message_at DESC);

CREATE TABLE IF NOT EXISTS patient_chat_messages (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id INTEGER NOT NULL REFERENCES patient_chat_conversations(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL CHECK (role IN ('patient', 'assistant', 'system')),
  content TEXT NOT NULL,
  citations JSONB NOT NULL DEFAULT '[]'::jsonb,
  safety_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  provider VARCHAR(40),
  model VARCHAR(120),
  token_usage JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_patient_chat_msg_conv_time
  ON patient_chat_messages (conversation_id, created_at);

-- Mortality / RCA draft generator output.
CREATE TABLE IF NOT EXISTS clinical_ai_rca_drafts (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  admission_id INTEGER NOT NULL,
  patient_uid UUID,
  case_type VARCHAR(40) NOT NULL DEFAULT 'mortality'
    CHECK (case_type IN ('mortality', 'readmission', 'infection', 'never_event', 'complaint')),
  draft JSONB NOT NULL,
  citations JSONB NOT NULL DEFAULT '[]'::jsonb,
  reviewer_decision VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (reviewer_decision IN ('pending', 'accepted', 'revised', 'rejected')),
  reviewer_note TEXT,
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clinical_ai_rca_tenant_admission
  ON clinical_ai_rca_drafts (tenant_id, admission_id, created_at DESC);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('clinical_trial_matcher',
   'Clinical Trial Matcher',
   'Matches current admissions against a tenant catalog of trials, ranked by overlap of conditions + eligibility. Coordinator offers or rejects each match.',
   false,
   '{"surface":"research","risk":"medium","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["RESEARCH_COORDINATOR","ADMIN"],"outputSchema":{"type":"object","required":["matches"]},"retentionDays":365}'::jsonb),
  ('patient_record_chatbot',
   'Patient Record Chatbot',
   'Consent-gated RAG chatbot that answers patient questions from their OWN record. Multilingual via M4. Every message is audit-logged; no clinical advice, only record lookup + plain-language summary.',
   false,
   '{"surface":"patient","risk":"high","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["ADMIN"],"outputSchema":{"type":"object"},"retentionDays":365}'::jsonb),
  ('rca_draft_generator',
   'Mortality / RCA Draft Generator',
   'Auto-generates candidate RCA findings (mortality, readmission, infection, never-event, complaint) from the chart for the quality committee. Always draft; committee signs off.',
   false,
   '{"surface":"quality","risk":"medium","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["QUALITY_OFFICER","DOCTOR","ADMIN"],"outputSchema":{"type":"object","required":["timeline","candidate_findings","contributing_factors"]},"retentionDays":1825}'::jsonb)
ON CONFLICT (module_key)
DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  settings = clinical_ai_modules.settings || EXCLUDED.settings,
  updated_at = NOW();
