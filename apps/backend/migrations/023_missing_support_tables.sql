-- Migration 023: Remaining missing support tables
-- Second pass after full audit (2026-04-04)
-- All CREATE TABLE IF NOT EXISTS — safe to re-run

-- ===================================================================
-- 1. hipaa_access_log — PHI access audit (HIPAA compliance)
-- ===================================================================
CREATE TABLE IF NOT EXISTS hipaa_access_log (
  id             BIGSERIAL PRIMARY KEY,
  accessed_by    UUID,
  accessed_by_role VARCHAR(100),
  patient_id     UUID,
  record_type    VARCHAR(100),
  action         VARCHAR(100),
  ip_address     VARCHAR(45),
  request_id     VARCHAR(100),
  accessed_at    TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hipaa_log_patient ON hipaa_access_log(patient_id);
CREATE INDEX IF NOT EXISTS idx_hipaa_log_accessed_by ON hipaa_access_log(accessed_by);
CREATE INDEX IF NOT EXISTS idx_hipaa_log_accessed_at ON hipaa_access_log(accessed_at);


-- ===================================================================
-- 2. gdpr_erasure_log — GDPR / data erasure audit
-- ===================================================================
CREATE TABLE IF NOT EXISTS gdpr_erasure_log (
  id                SERIAL PRIMARY KEY,
  uid               UUID,
  phone_hash        VARCHAR(255),
  requested_by      UUID,
  reason            TEXT,
  ip                VARCHAR(45),
  tables_processed  TEXT[],
  completed_at      TIMESTAMP WITHOUT TIME ZONE,
  duration_ms       INTEGER,
  results           JSONB,
  created_at        TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_gdpr_erasure_uid ON gdpr_erasure_log(uid);
CREATE INDEX IF NOT EXISTS idx_gdpr_erasure_created_at ON gdpr_erasure_log(created_at);


-- ===================================================================
-- 3. legal_holds — GDPR legal hold — blocks data erasure
-- ===================================================================
CREATE TABLE IF NOT EXISTS legal_holds (
  id          SERIAL PRIMARY KEY,
  user_uid    UUID NOT NULL,
  reason      TEXT NOT NULL,
  held_by     UUID,
  released_at TIMESTAMP WITHOUT TIME ZONE,
  released_by UUID,
  created_at  TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_legal_holds_user_uid ON legal_holds(user_uid);
CREATE INDEX IF NOT EXISTS idx_legal_holds_released_at ON legal_holds(released_at);


-- ===================================================================
-- 4. cds_alerts — Clinical Decision Support alerts
-- ===================================================================
CREATE TABLE IF NOT EXISTS cds_alerts (
  id           SERIAL PRIMARY KEY,
  patient_uid  UUID NOT NULL,
  encounter_id VARCHAR(50),
  alert_type   VARCHAR(100) NOT NULL,
  severity     VARCHAR(20) NOT NULL,
  title        VARCHAR(255) NOT NULL,
  description  TEXT,
  source_data  JSONB,
  acknowledged BOOLEAN DEFAULT FALSE,
  ack_by       UUID,
  ack_at       TIMESTAMP WITHOUT TIME ZONE,
  created_at   TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cds_alerts_patient_uid ON cds_alerts(patient_uid);
CREATE INDEX IF NOT EXISTS idx_cds_alerts_severity ON cds_alerts(severity);
CREATE INDEX IF NOT EXISTS idx_cds_alerts_acknowledged ON cds_alerts(acknowledged);


-- ===================================================================
-- 5. drug_interactions — Drug-drug interaction reference data
-- ===================================================================
CREATE TABLE IF NOT EXISTS drug_interactions (
  id              SERIAL PRIMARY KEY,
  drug_a          VARCHAR(255) NOT NULL,
  drug_b          VARCHAR(255) NOT NULL,
  severity        VARCHAR(20) NOT NULL,
  description     TEXT,
  clinical_effect TEXT,
  management      TEXT,
  source          VARCHAR(100),
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_drug_interactions_drug_a ON drug_interactions(drug_a);
CREATE INDEX IF NOT EXISTS idx_drug_interactions_drug_b ON drug_interactions(drug_b);
CREATE UNIQUE INDEX IF NOT EXISTS idx_drug_interactions_pair ON drug_interactions(
  LEAST(drug_a, drug_b), GREATEST(drug_a, drug_b)
);


-- ===================================================================
-- 6. clinical_protocols — Clinical care protocols / guidelines
-- ===================================================================
CREATE TABLE IF NOT EXISTS clinical_protocols (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(255) NOT NULL,
  category    VARCHAR(100),
  description TEXT,
  steps       JSONB,
  is_active   BOOLEAN DEFAULT TRUE,
  version     VARCHAR(20),
  created_by  UUID,
  created_at  TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  updated_at  TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_clinical_protocols_category ON clinical_protocols(category);


-- ===================================================================
-- 7. order_sets — Pre-defined clinical order sets (CPOE)
-- ===================================================================
CREATE TABLE IF NOT EXISTS order_sets (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(255) NOT NULL,
  description TEXT,
  category    VARCHAR(100),
  orders      JSONB NOT NULL DEFAULT '[]',
  is_active   BOOLEAN DEFAULT TRUE,
  created_by  UUID,
  created_at  TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  updated_at  TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_order_sets_category ON order_sets(category);
CREATE INDEX IF NOT EXISTS idx_order_sets_active ON order_sets(is_active);


-- ===================================================================
-- 8. intake_output — Fluid I/O balance records
-- ===================================================================
CREATE TABLE IF NOT EXISTS intake_output (
  id          SERIAL PRIMARY KEY,
  patient_uid UUID NOT NULL,
  encounter_id VARCHAR(50),
  io_type     VARCHAR(20) NOT NULL,   -- intake / output
  category    VARCHAR(50) NOT NULL,   -- oral, iv, blood, urine, drain, etc.
  amount_ml   NUMERIC(8, 1) NOT NULL,
  description TEXT,
  recorded_by UUID,
  recorded_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  created_at  TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_intake_output_patient_uid ON intake_output(patient_uid);
CREATE INDEX IF NOT EXISTS idx_intake_output_encounter ON intake_output(encounter_id);
CREATE INDEX IF NOT EXISTS idx_intake_output_recorded_at ON intake_output(recorded_at);


-- ===================================================================
-- 9. nurse_handovers — Shift handover records
-- ===================================================================
CREATE TABLE IF NOT EXISTS nurse_handovers (
  id                   SERIAL PRIMARY KEY,
  patient_uid          UUID NOT NULL,
  ward                 VARCHAR(100),
  bed_number           VARCHAR(20),
  outgoing_nurse       UUID NOT NULL,
  incoming_nurse       UUID,
  shift                VARCHAR(50),
  patient_summary      TEXT,
  active_issues        JSONB,
  pending_tasks        JSONB,
  medications_due      JSONB,
  special_instructions TEXT,
  summary              TEXT,
  alerts               JSONB,
  acknowledged         BOOLEAN DEFAULT FALSE,
  acknowledged_at      TIMESTAMP WITHOUT TIME ZONE,
  status               VARCHAR(20) DEFAULT 'pending',
  created_at           TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_nurse_handovers_patient_uid ON nurse_handovers(patient_uid);
CREATE INDEX IF NOT EXISTS idx_nurse_handovers_incoming_nurse ON nurse_handovers(incoming_nurse);
CREATE INDEX IF NOT EXISTS idx_nurse_handovers_status ON nurse_handovers(status);


-- ===================================================================
-- 10. prescriptions — Prescription records
--     (used by cdsEngine for active med checks, abdmService for FHIR export)
-- ===================================================================
CREATE TABLE IF NOT EXISTS prescriptions (
  id              SERIAL PRIMARY KEY,
  patient_uid     UUID NOT NULL,
  encounter_id    VARCHAR(50),
  doctor_uid      UUID,
  medication_name VARCHAR(255) NOT NULL,
  dosage          VARCHAR(100),
  frequency       VARCHAR(100),
  route           VARCHAR(50),
  duration_days   INTEGER,
  quantity        INTEGER,
  refills         INTEGER DEFAULT 0,
  instructions    TEXT,
  status          VARCHAR(50) DEFAULT 'active',
  issued_at       TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  expires_at      TIMESTAMP WITHOUT TIME ZONE,
  dispensed_at    TIMESTAMP WITHOUT TIME ZONE,
  created_at      TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  updated_at      TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_prescriptions_patient_uid ON prescriptions(patient_uid);
CREATE INDEX IF NOT EXISTS idx_prescriptions_status ON prescriptions(status);
CREATE INDEX IF NOT EXISTS idx_prescriptions_issued_at ON prescriptions(issued_at);


-- ===================================================================
-- 11. allergies — Patient allergy records (FHIR AllergyIntolerance)
-- ===================================================================
CREATE TABLE IF NOT EXISTS allergies (
  id          SERIAL PRIMARY KEY,
  patient_uid UUID NOT NULL,
  allergen    VARCHAR(255) NOT NULL,
  name        VARCHAR(255),
  allergy_type VARCHAR(50) DEFAULT 'medication',
  severity    VARCHAR(20),
  reaction    TEXT,
  status      VARCHAR(20) DEFAULT 'active',
  recorded_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  created_at  TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_allergies_patient_uid ON allergies(patient_uid);


-- ===================================================================
-- 12. patient_allergies — Allergy lookup for prescription safety checks
--     (used by prescriptionSafetyCheck with patient_id int FK)
-- ===================================================================
CREATE TABLE IF NOT EXISTS patient_allergies (
  id           SERIAL PRIMARY KEY,
  patient_id   INTEGER,               -- FK to users.id (int)
  patient_uid  UUID,
  allergy_name VARCHAR(255) NOT NULL,
  severity     VARCHAR(20) DEFAULT 'unknown',
  reaction     TEXT,
  is_active    BOOLEAN DEFAULT TRUE,
  created_at   TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_patient_allergies_patient_id ON patient_allergies(patient_id);
CREATE INDEX IF NOT EXISTS idx_patient_allergies_patient_uid ON patient_allergies(patient_uid);
CREATE INDEX IF NOT EXISTS idx_patient_allergies_active ON patient_allergies(patient_id, is_active);


-- ===================================================================
-- 13. vital_signs — FHIR-style observation store (fhirRoutes)
-- ===================================================================
CREATE TABLE IF NOT EXISTS vital_signs (
  id            SERIAL PRIMARY KEY,
  patient_uid   UUID NOT NULL,
  type          VARCHAR(100) NOT NULL,
  value         NUMERIC,
  unit          VARCHAR(50),
  recorded_date TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  recorded_by   UUID,
  encounter_id  VARCHAR(50),
  created_at    TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vital_signs_patient_uid ON vital_signs(patient_uid);
CREATE INDEX IF NOT EXISTS idx_vital_signs_recorded_date ON vital_signs(recorded_date);
CREATE INDEX IF NOT EXISTS idx_vital_signs_type ON vital_signs(type);


-- ===================================================================
-- 14. discharge_summaries — Discharge summary documents
-- ===================================================================
CREATE TABLE IF NOT EXISTS discharge_summaries (
  id              SERIAL PRIMARY KEY,
  patient_uid     UUID NOT NULL,
  encounter_id    VARCHAR(50),
  admission_id    INTEGER REFERENCES admissions(id) ON DELETE SET NULL,
  attending_doctor UUID,
  summary_text    TEXT,
  discharge_date  DATE,
  follow_up       TEXT,
  medications     JSONB,
  created_by      UUID,
  created_at      TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  updated_at      TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_discharge_summaries_patient_uid ON discharge_summaries(patient_uid);
CREATE INDEX IF NOT EXISTS idx_discharge_summaries_encounter ON discharge_summaries(encounter_id);


-- ===================================================================
-- 15. immunizations — Vaccination records (FHIR Immunization)
-- ===================================================================
CREATE TABLE IF NOT EXISTS immunizations (
  id             SERIAL PRIMARY KEY,
  patient_uid    UUID NOT NULL,
  vaccine_name   VARCHAR(255) NOT NULL,
  vaccine_code   VARCHAR(50),
  dose_number    INTEGER,
  administered_at TIMESTAMP WITHOUT TIME ZONE,
  administered_by UUID,
  lot_number     VARCHAR(100),
  site           VARCHAR(50),
  route          VARCHAR(50),
  notes          TEXT,
  created_at     TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_immunizations_patient_uid ON immunizations(patient_uid);


-- ===================================================================
-- 16. abdm_data_requests — ABDM health data fetch requests
-- ===================================================================
CREATE TABLE IF NOT EXISTS abdm_data_requests (
  id               SERIAL PRIMARY KEY,
  transaction_id   VARCHAR(100) UNIQUE,
  consent_id       VARCHAR(100),
  patient_uid      UUID,
  hi_types         TEXT[],
  date_range_from  DATE,
  date_range_to    DATE,
  key_material     JSONB,
  status           VARCHAR(50) DEFAULT 'PROCESSING',
  delivered_at     TIMESTAMP WITHOUT TIME ZONE,
  created_at       TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  updated_at       TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_abdm_data_requests_transaction ON abdm_data_requests(transaction_id);
CREATE INDEX IF NOT EXISTS idx_abdm_data_requests_patient ON abdm_data_requests(patient_uid);


-- ===================================================================
-- 17. feature_flags — Runtime feature toggle management
-- ===================================================================
CREATE TABLE IF NOT EXISTS feature_flags (
  id                 SERIAL PRIMARY KEY,
  name               VARCHAR(100) UNIQUE NOT NULL,
  description        TEXT,
  is_enabled         BOOLEAN DEFAULT FALSE,
  enabled            BOOLEAN DEFAULT FALSE,
  rollout_percentage INTEGER DEFAULT 0,
  allowed_roles      TEXT[],
  created_at         TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  updated_at         TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_feature_flags_name ON feature_flags(name);


-- ===================================================================
-- 18. system_settings — Key-value config store
-- ===================================================================
CREATE TABLE IF NOT EXISTS system_settings (
  id         SERIAL PRIMARY KEY,
  key        VARCHAR(255) UNIQUE NOT NULL,
  value      JSONB,
  updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_system_settings_key ON system_settings(key);


-- ===================================================================
-- 19. totp_challenges — TOTP / 2FA challenge tokens for admins
-- ===================================================================
CREATE TABLE IF NOT EXISTS totp_challenges (
  id              SERIAL PRIMARY KEY,
  admin_id        INTEGER NOT NULL,
  challenge_token VARCHAR(255) NOT NULL,
  expires_at      TIMESTAMP WITHOUT TIME ZONE NOT NULL,
  used            BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_totp_challenges_admin_id ON totp_challenges(admin_id);
CREATE INDEX IF NOT EXISTS idx_totp_challenges_expires_at ON totp_challenges(expires_at);


-- ===================================================================
-- 20. quarantined_files — Files flagged by AV scan / content policy
-- ===================================================================
CREATE TABLE IF NOT EXISTS quarantined_files (
  id              SERIAL PRIMARY KEY,
  file_name       VARCHAR(255),
  storage_key     TEXT,
  file_size       BIGINT,
  uploaded_by     UUID,
  quarantine_reason TEXT,
  scan_result     TEXT,
  is_reviewed     BOOLEAN DEFAULT FALSE,
  reviewed_by     UUID,
  reviewed_at     TIMESTAMP WITHOUT TIME ZONE,
  created_at      TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_quarantined_files_created_at ON quarantined_files(created_at);


-- ===================================================================
-- 21. feedback_responses — Staff responses to patient feedback
-- ===================================================================
CREATE TABLE IF NOT EXISTS feedback_responses (
  id            SERIAL PRIMARY KEY,
  feedback_id   INTEGER REFERENCES feedback(id) ON DELETE CASCADE,
  responder_uid UUID,
  response_text TEXT NOT NULL,
  created_at    TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_feedback_responses_feedback_id ON feedback_responses(feedback_id);


-- ===================================================================
-- 22. admin_actions — Admin audit log for sensitive operations
-- ===================================================================
CREATE TABLE IF NOT EXISTS admin_actions (
  id          SERIAL PRIMARY KEY,
  admin_uid   UUID,
  action_type VARCHAR(100) NOT NULL,
  target_type VARCHAR(100),
  target_id   VARCHAR(100),
  reason      TEXT,
  details     JSONB,
  ip_address  VARCHAR(45),
  created_at  TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_actions_admin_uid ON admin_actions(admin_uid);
CREATE INDEX IF NOT EXISTS idx_admin_actions_target ON admin_actions(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_admin_actions_created_at ON admin_actions(created_at);


-- ===================================================================
-- 23. appointment_archive — Soft-delete archive for appointments
-- ===================================================================
CREATE TABLE IF NOT EXISTS appointment_archive (
  id               SERIAL PRIMARY KEY,
  original_id      INTEGER,
  patient_id       INTEGER,
  doctor_id        INTEGER,
  appointment_date DATE,
  status           VARCHAR(50),
  reason           TEXT,
  notes            TEXT,
  deleted_by       UUID,
  deleted_at       TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  deletion_reason  TEXT
);
CREATE INDEX IF NOT EXISTS idx_appointment_archive_original_id ON appointment_archive(original_id);
CREATE INDEX IF NOT EXISTS idx_appointment_archive_patient_id ON appointment_archive(patient_id);


-- ===================================================================
-- 24. onboarding_tasks — Staff onboarding checklist (used in HR controller)
--     Note: staff_onboarding_tasks exists but uses different column names
--     staffAdminHRController uses onboarding_tasks with completed boolean
-- ===================================================================
CREATE TABLE IF NOT EXISTS onboarding_tasks (
  id           SERIAL PRIMARY KEY,
  staff_id     INTEGER NOT NULL,
  task_name    VARCHAR(255),
  description  TEXT,
  completed    BOOLEAN DEFAULT FALSE,
  completed_at TIMESTAMP WITHOUT TIME ZONE,
  due_date     DATE,
  created_at   TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_onboarding_tasks_staff_id ON onboarding_tasks(staff_id);


-- ===================================================================
-- 25. leave_requests — Leave request workflow (attendanceAuditController)
--     Note: leave_applications exists but attendanceAuditController uses leave_requests
-- ===================================================================
CREATE TABLE IF NOT EXISTS leave_requests (
  id           SERIAL PRIMARY KEY,
  staff_id     INTEGER,
  leave_type   VARCHAR(50),
  start_date   DATE NOT NULL,
  end_date     DATE NOT NULL,
  reason       TEXT,
  status       VARCHAR(50) DEFAULT 'pending',
  approved_by  UUID,
  approved_at  TIMESTAMP WITHOUT TIME ZONE,
  notes        TEXT,
  created_at   TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  updated_at   TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_leave_requests_staff_id ON leave_requests(staff_id);
CREATE INDEX IF NOT EXISTS idx_leave_requests_status ON leave_requests(status);
CREATE INDEX IF NOT EXISTS idx_leave_requests_created_at ON leave_requests(created_at);


-- ===================================================================
-- ALTER TABLE: feedback — add responded_at and response_status columns
-- ===================================================================
ALTER TABLE feedback
  ADD COLUMN IF NOT EXISTS responded_at TIMESTAMP WITHOUT TIME ZONE,
  ADD COLUMN IF NOT EXISTS response_status VARCHAR(50);
