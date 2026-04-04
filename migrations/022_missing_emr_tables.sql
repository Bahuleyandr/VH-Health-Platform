-- Migration 022: Missing EMR, clinical, and supporting tables
-- All tables referenced in code but absent from DB (discovered 2026-04-04 full audit)
-- All CREATE TABLE statements use IF NOT EXISTS — safe to re-run
-- All ALTER TABLE statements use IF NOT EXISTS — safe to re-run

-- ===================================================================
-- 1. wards — Hospital ward definitions (used by beds + bedService)
-- ===================================================================
CREATE TABLE IF NOT EXISTS wards (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(100) NOT NULL,
  floor         INTEGER DEFAULT 1,
  department_id INTEGER,
  total_beds    INTEGER DEFAULT 0,
  created_at    TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  updated_at    TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wards_department ON wards(department_id);


-- ===================================================================
-- 2. beds — Individual bed inventory (used by bedService, bedManagementService)
-- ===================================================================
CREATE TABLE IF NOT EXISTS beds (
  id                  SERIAL PRIMARY KEY,
  ward_id             INTEGER REFERENCES wards(id) ON DELETE SET NULL,
  ward_name           VARCHAR(100),
  bed_number          VARCHAR(20) NOT NULL,
  bed_type            VARCHAR(50) DEFAULT 'general',
  floor               VARCHAR(20),
  status              VARCHAR(20) NOT NULL DEFAULT 'available',
  patient_uid         UUID,
  patient_id          INTEGER,
  patient_name        VARCHAR(255),
  admission_id        INTEGER,
  admitted_at         TIMESTAMP WITHOUT TIME ZONE,
  expected_discharge  TIMESTAMP WITHOUT TIME ZONE,
  notes               TEXT,
  created_at          TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  updated_at          TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_beds_ward_id ON beds(ward_id);
CREATE INDEX IF NOT EXISTS idx_beds_status ON beds(status);
CREATE INDEX IF NOT EXISTS idx_beds_patient_uid ON beds(patient_uid);


-- ===================================================================
-- 3. admissions — Patient admission/discharge/transfer (ADT)
-- ===================================================================
CREATE TABLE IF NOT EXISTS admissions (
  id                 SERIAL PRIMARY KEY,
  encounter_id       VARCHAR(50) UNIQUE DEFAULT 'ENC-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || LPAD(nextval('admissions_id_seq')::TEXT, 4, '0'),
  patient_uid        UUID NOT NULL,
  admitting_doctor   UUID,
  attending_doctor   UUID,
  department         VARCHAR(100),
  ward               VARCHAR(100),
  bed_id             INTEGER REFERENCES beds(id) ON DELETE SET NULL,
  bed_number         VARCHAR(20),
  chief_complaint    TEXT,
  admitting_diagnosis TEXT,
  discharge_diagnosis TEXT,
  admission_type     VARCHAR(50) DEFAULT 'elective',
  status             VARCHAR(50) NOT NULL DEFAULT 'admitted',
  priority           VARCHAR(20) DEFAULT 'routine',
  code_status        VARCHAR(50) DEFAULT 'full_code',
  insurance_info     JSONB,
  emergency_contact  JSONB,
  allergies          TEXT[],
  expected_los_days  INTEGER,
  discharge_type     VARCHAR(50),
  discharge_summary  TEXT,
  discharge_notes    TEXT,
  reason             TEXT,
  admitted_at        TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  discharged_at      TIMESTAMP WITHOUT TIME ZONE,
  created_by         UUID,
  created_at         TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  updated_at         TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admissions_patient_uid ON admissions(patient_uid);
CREATE INDEX IF NOT EXISTS idx_admissions_status ON admissions(status);
CREATE INDEX IF NOT EXISTS idx_admissions_encounter_id ON admissions(encounter_id);
CREATE INDEX IF NOT EXISTS idx_admissions_admitted_at ON admissions(admitted_at);


-- ===================================================================
-- 4. bed_transfers — Bed movement audit log
-- ===================================================================
CREATE TABLE IF NOT EXISTS bed_transfers (
  id              SERIAL PRIMARY KEY,
  patient_uid     UUID,
  admission_id    INTEGER REFERENCES admissions(id) ON DELETE SET NULL,
  from_bed_id     INTEGER REFERENCES beds(id) ON DELETE SET NULL,
  to_bed_id       INTEGER REFERENCES beds(id) ON DELETE SET NULL,
  reason          TEXT,
  transferred_by  UUID,
  transferred_at  TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  created_at      TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bed_transfers_patient_uid ON bed_transfers(patient_uid);
CREATE INDEX IF NOT EXISTS idx_bed_transfers_transferred_at ON bed_transfers(transferred_at);


-- ===================================================================
-- 5. clinical_notes — SOAP / progress / discharge notes
-- ===================================================================
CREATE TABLE IF NOT EXISTS clinical_notes (
  id              SERIAL PRIMARY KEY,
  encounter_id    VARCHAR(50),
  patient_uid     UUID NOT NULL,
  author_uid      UUID NOT NULL,
  author_role     VARCHAR(100),
  note_type       VARCHAR(50) NOT NULL,
  content         JSONB NOT NULL,
  version         INTEGER DEFAULT 1,
  parent_note_id  INTEGER REFERENCES clinical_notes(id) ON DELETE SET NULL,
  is_addendum     BOOLEAN DEFAULT FALSE,
  is_signed       BOOLEAN DEFAULT FALSE,
  signed_at       TIMESTAMP WITHOUT TIME ZONE,
  signed_by       UUID,
  created_at      TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  updated_at      TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_clinical_notes_patient_uid ON clinical_notes(patient_uid);
CREATE INDEX IF NOT EXISTS idx_clinical_notes_encounter_id ON clinical_notes(encounter_id);
CREATE INDEX IF NOT EXISTS idx_clinical_notes_author_uid ON clinical_notes(author_uid);
CREATE INDEX IF NOT EXISTS idx_clinical_notes_type ON clinical_notes(note_type);


-- ===================================================================
-- 6. diagnoses — Problem list / ICD-10 diagnosis records
-- ===================================================================
CREATE TABLE IF NOT EXISTS diagnoses (
  id                SERIAL PRIMARY KEY,
  patient_uid       UUID NOT NULL,
  encounter_id      VARCHAR(50),
  icd10_code        VARCHAR(20),
  icd10_description TEXT,
  description       TEXT NOT NULL,
  diagnosis_type    VARCHAR(50) DEFAULT 'primary',
  status            VARCHAR(50) DEFAULT 'active',
  onset_date        DATE,
  resolved_date     DATE,
  severity          VARCHAR(20),
  diagnosed_by      UUID,
  notes             TEXT,
  created_at        TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  updated_at        TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_diagnoses_patient_uid ON diagnoses(patient_uid);
CREATE INDEX IF NOT EXISTS idx_diagnoses_encounter_id ON diagnoses(encounter_id);
CREATE INDEX IF NOT EXISTS idx_diagnoses_icd10 ON diagnoses(icd10_code);
CREATE INDEX IF NOT EXISTS idx_diagnoses_status ON diagnoses(status);


-- ===================================================================
-- 7. vitals_chart — Vitals observations per encounter
-- ===================================================================
CREATE TABLE IF NOT EXISTS vitals_chart (
  id                SERIAL PRIMARY KEY,
  patient_uid       UUID NOT NULL,
  encounter_id      VARCHAR(50),
  heart_rate        NUMERIC(6, 1),
  systolic_bp       NUMERIC(6, 1),
  diastolic_bp      NUMERIC(6, 1),
  temperature       NUMERIC(5, 2),
  spo2              NUMERIC(5, 2),
  respiratory_rate  NUMERIC(5, 1),
  blood_glucose     NUMERIC(6, 1),
  pain_score        NUMERIC(4, 1),
  weight_kg         NUMERIC(7, 2),
  height_cm         NUMERIC(6, 1),
  gcs_score         SMALLINT,
  supplemental_o2   BOOLEAN DEFAULT FALSE,
  o2_flow_rate      NUMERIC(5, 1),
  consciousness     VARCHAR(5),
  notes             TEXT,
  recorded_by       UUID,
  recorded_at       TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  created_at        TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vitals_patient_uid ON vitals_chart(patient_uid);
CREATE INDEX IF NOT EXISTS idx_vitals_encounter_id ON vitals_chart(encounter_id);
CREATE INDEX IF NOT EXISTS idx_vitals_recorded_at ON vitals_chart(recorded_at);


-- ===================================================================
-- 8. clinical_orders — CPOE order entry (medication, investigation, nursing, etc.)
-- ===================================================================
CREATE TABLE IF NOT EXISTS clinical_orders (
  id           SERIAL PRIMARY KEY,
  order_number VARCHAR(30) UNIQUE,
  encounter_id VARCHAR(50),
  patient_uid  UUID NOT NULL,
  order_type   VARCHAR(50) NOT NULL,
  priority     VARCHAR(20) DEFAULT 'routine',
  details      JSONB NOT NULL DEFAULT '{}',
  status       VARCHAR(50) DEFAULT 'ordered',
  ordered_by   UUID,
  verified_by  UUID,
  start_date   DATE,
  end_date     DATE,
  notes        TEXT,
  created_at   TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  updated_at   TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_clinical_orders_patient_uid ON clinical_orders(patient_uid);
CREATE INDEX IF NOT EXISTS idx_clinical_orders_encounter_id ON clinical_orders(encounter_id);
CREATE INDEX IF NOT EXISTS idx_clinical_orders_status ON clinical_orders(status);
CREATE INDEX IF NOT EXISTS idx_clinical_orders_type ON clinical_orders(order_type);


-- ===================================================================
-- 9. medication_administrations — MAR: medication administration records
-- ===================================================================
CREATE TABLE IF NOT EXISTS medication_administrations (
  id               SERIAL PRIMARY KEY,
  patient_uid      UUID NOT NULL,
  prescription_id  INTEGER,
  order_id         INTEGER REFERENCES clinical_orders(id) ON DELETE SET NULL,
  medication_name  VARCHAR(255) NOT NULL,
  dose             VARCHAR(100),
  dosage           VARCHAR(100),
  route            VARCHAR(50),
  scheduled_time   TIMESTAMP WITHOUT TIME ZONE,
  administered_at  TIMESTAMP WITHOUT TIME ZONE,
  administered_by  UUID,
  status           VARCHAR(50) DEFAULT 'scheduled',
  notes            TEXT,
  created_at       TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_med_admin_patient_uid ON medication_administrations(patient_uid);
CREATE INDEX IF NOT EXISTS idx_med_admin_status ON medication_administrations(status);
CREATE INDEX IF NOT EXISTS idx_med_admin_scheduled_time ON medication_administrations(scheduled_time);


-- ===================================================================
-- 10. referrals — Internal/external patient referrals
-- ===================================================================
CREATE TABLE IF NOT EXISTS referrals (
  id                     SERIAL PRIMARY KEY,
  referral_number        VARCHAR(30) UNIQUE,
  patient_uid            UUID NOT NULL,
  encounter_id           VARCHAR(50),
  referring_doctor       UUID NOT NULL,
  referred_to_doctor     UUID,
  referred_to_department VARCHAR(100) NOT NULL,
  referral_type          VARCHAR(20) DEFAULT 'internal',
  reason                 TEXT NOT NULL,
  urgency                VARCHAR(20) DEFAULT 'routine',
  clinical_summary       TEXT,
  status                 VARCHAR(50) DEFAULT 'pending',
  response_notes         TEXT,
  responded_at           TIMESTAMP WITHOUT TIME ZONE,
  created_at             TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  updated_at             TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_referrals_patient_uid ON referrals(patient_uid);
CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals(status);
CREATE INDEX IF NOT EXISTS idx_referrals_referring_doctor ON referrals(referring_doctor);


-- ===================================================================
-- 11. radiology_orders — Radiology requests
-- ===================================================================
CREATE TABLE IF NOT EXISTS radiology_orders (
  id                   SERIAL PRIMARY KEY,
  patient_uid          UUID NOT NULL,
  encounter_id         VARCHAR(50),
  modality             VARCHAR(50) NOT NULL,
  body_part            VARCHAR(100) NOT NULL,
  clinical_indication  TEXT NOT NULL,
  priority             VARCHAR(20) DEFAULT 'routine',
  status               VARCHAR(50) DEFAULT 'ordered',
  ordered_by           UUID,
  radiologist          UUID,
  report               TEXT,
  report_completed_at  TIMESTAMP WITHOUT TIME ZONE,
  notes                TEXT,
  created_at           TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  updated_at           TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_radiology_patient_uid ON radiology_orders(patient_uid);
CREATE INDEX IF NOT EXISTS idx_radiology_status ON radiology_orders(status);
CREATE INDEX IF NOT EXISTS idx_radiology_modality ON radiology_orders(modality);


-- ===================================================================
-- 12. ot_schedules — Operation theatre scheduling
-- ===================================================================
CREATE TABLE IF NOT EXISTS ot_schedules (
  id                  SERIAL PRIMARY KEY,
  patient_uid         UUID NOT NULL,
  encounter_id        VARCHAR(50),
  surgeon             UUID NOT NULL,
  anesthetist         UUID,
  procedure_name      VARCHAR(255) NOT NULL,
  procedure_code      VARCHAR(50),
  ot_room             VARCHAR(50),
  scheduled_date      DATE NOT NULL,
  scheduled_time      TIME,
  estimated_duration  INTEGER,
  actual_duration     INTEGER,
  status              VARCHAR(50) DEFAULT 'scheduled',
  pre_op_checklist    JSONB,
  equipment_needed    TEXT[],
  blood_arranged      BOOLEAN DEFAULT FALSE,
  consent_obtained    BOOLEAN DEFAULT FALSE,
  post_op_notes       TEXT,
  complications       TEXT,
  created_at          TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  updated_at          TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ot_schedules_patient_uid ON ot_schedules(patient_uid);
CREATE INDEX IF NOT EXISTS idx_ot_schedules_scheduled_date ON ot_schedules(scheduled_date);
CREATE INDEX IF NOT EXISTS idx_ot_schedules_status ON ot_schedules(status);
CREATE INDEX IF NOT EXISTS idx_ot_schedules_surgeon ON ot_schedules(surgeon);


-- ===================================================================
-- 13. blood_requests — Blood bank requests
-- ===================================================================
CREATE TABLE IF NOT EXISTS blood_requests (
  id                  SERIAL PRIMARY KEY,
  patient_uid         UUID NOT NULL,
  encounter_id        VARCHAR(50),
  blood_group         VARCHAR(5) NOT NULL,
  component           VARCHAR(50) NOT NULL,
  units               INTEGER NOT NULL,
  urgency             VARCHAR(20) DEFAULT 'routine',
  clinical_indication TEXT NOT NULL,
  cross_match_status  VARCHAR(20) DEFAULT 'pending',
  status              VARCHAR(50) DEFAULT 'requested',
  ordered_by          UUID NOT NULL,
  cross_matched_by    UUID,
  cross_matched_at    TIMESTAMP WITHOUT TIME ZONE,
  issued_by           UUID,
  issued_at           TIMESTAMP WITHOUT TIME ZONE,
  transfused_at       TIMESTAMP WITHOUT TIME ZONE,
  notes               TEXT,
  created_at          TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  updated_at          TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_blood_requests_patient_uid ON blood_requests(patient_uid);
CREATE INDEX IF NOT EXISTS idx_blood_requests_status ON blood_requests(status);
CREATE INDEX IF NOT EXISTS idx_blood_requests_blood_group ON blood_requests(blood_group);


-- ===================================================================
-- 14. diet_orders — Dietary orders per patient
-- ===================================================================
CREATE TABLE IF NOT EXISTS diet_orders (
  id                   SERIAL PRIMARY KEY,
  patient_uid          UUID NOT NULL,
  encounter_id         VARCHAR(50),
  diet_type            VARCHAR(50) NOT NULL,
  restrictions         TEXT[],
  allergies            TEXT[],
  meal_preferences     TEXT,
  calories_target      INTEGER,
  special_instructions TEXT,
  status               VARCHAR(20) DEFAULT 'active',
  ordered_by           UUID NOT NULL,
  reviewed_by          UUID,
  created_at           TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  updated_at           TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_diet_orders_patient_uid ON diet_orders(patient_uid);
CREATE INDEX IF NOT EXISTS idx_diet_orders_status ON diet_orders(status);


-- ===================================================================
-- 15. quality_incidents — Quality / safety incident reports
-- ===================================================================
CREATE TABLE IF NOT EXISTS quality_incidents (
  id              SERIAL PRIMARY KEY,
  incident_number VARCHAR(30) UNIQUE,
  reported_by     UUID NOT NULL,
  patient_uid     UUID,
  incident_type   VARCHAR(50) NOT NULL,
  severity        VARCHAR(20) NOT NULL,
  description     TEXT NOT NULL,
  location        VARCHAR(255),
  date_occurred   DATE NOT NULL,
  status          VARCHAR(50) DEFAULT 'reported',
  investigation   TEXT,
  corrective_action TEXT,
  resolved_by     UUID,
  resolved_at     TIMESTAMP WITHOUT TIME ZONE,
  created_at      TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  updated_at      TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_quality_incidents_type ON quality_incidents(incident_type);
CREATE INDEX IF NOT EXISTS idx_quality_incidents_status ON quality_incidents(status);
CREATE INDEX IF NOT EXISTS idx_quality_incidents_date ON quality_incidents(date_occurred);


-- ===================================================================
-- 16. infection_cases — Hospital infection control tracking
-- ===================================================================
CREATE TABLE IF NOT EXISTS infection_cases (
  id                SERIAL PRIMARY KEY,
  patient_uid       UUID NOT NULL,
  encounter_id      VARCHAR(50),
  infection_site    VARCHAR(50) NOT NULL,
  pathogen          VARCHAR(255),
  isolation_type    VARCHAR(50),
  status            VARCHAR(50) DEFAULT 'active',
  identified_at     TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  resolved_at       TIMESTAMP WITHOUT TIME ZONE,
  reported_by       UUID,
  notes             TEXT,
  created_at        TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_infection_cases_patient_uid ON infection_cases(patient_uid);
CREATE INDEX IF NOT EXISTS idx_infection_cases_status ON infection_cases(status);


-- ===================================================================
-- 17. abdm_consents — ABDM / ABHA consent management
-- ===================================================================
CREATE TABLE IF NOT EXISTS abdm_consents (
  id              SERIAL PRIMARY KEY,
  consent_id      VARCHAR(100) UNIQUE,
  patient_uid     UUID NOT NULL,
  hip_id          VARCHAR(100),
  hiu_id          VARCHAR(100),
  purpose         VARCHAR(100),
  hi_types        TEXT[],
  date_range_from DATE,
  date_range_to   DATE,
  expiry_date     DATE,
  status          VARCHAR(50) DEFAULT 'REQUESTED',
  requester_name  VARCHAR(255),
  created_at      TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  updated_at      TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_abdm_consents_patient_uid ON abdm_consents(patient_uid);
CREATE INDEX IF NOT EXISTS idx_abdm_consents_status ON abdm_consents(status);


-- ===================================================================
-- 18. data_breaches — Compliance breach reporting (DPDP / HIPAA)
-- ===================================================================
CREATE TABLE IF NOT EXISTS data_breaches (
  id                    SERIAL PRIMARY KEY,
  breach_id             VARCHAR(30) UNIQUE DEFAULT 'BRH-' || TO_CHAR(NOW(), 'YYYYMM') || '-' || LPAD(nextval('data_breaches_id_seq')::TEXT, 4, '0'),
  severity              VARCHAR(20) NOT NULL,
  description           TEXT NOT NULL,
  affected_records      INTEGER DEFAULT 0,
  affected_patient_uids UUID[],
  discovered_at         TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  reported_by           UUID,
  status                VARCHAR(50) DEFAULT 'open',
  resolution_notes      TEXT,
  resolved_at           TIMESTAMP WITHOUT TIME ZONE,
  created_at            TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  updated_at            TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_data_breaches_status ON data_breaches(status);
CREATE INDEX IF NOT EXISTS idx_data_breaches_severity ON data_breaches(severity);


-- ===================================================================
-- 19. staff_messages — Internal staff messaging
-- ===================================================================
CREATE TABLE IF NOT EXISTS staff_messages (
  id             SERIAL PRIMARY KEY,
  sender_uid     UUID NOT NULL,
  recipient_uid  UUID NOT NULL,
  patient_uid    UUID,
  subject        VARCHAR(255),
  body           TEXT NOT NULL,
  priority       VARCHAR(20) DEFAULT 'normal',
  is_read        BOOLEAN DEFAULT FALSE,
  read_at        TIMESTAMP WITHOUT TIME ZONE,
  created_at     TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_staff_messages_sender ON staff_messages(sender_uid);
CREATE INDEX IF NOT EXISTS idx_staff_messages_recipient ON staff_messages(recipient_uid);
CREATE INDEX IF NOT EXISTS idx_staff_messages_unread ON staff_messages(recipient_uid, is_read);


-- ===================================================================
-- 20. performance_reviews — Staff performance review workflow
--     (separate from staff_performance_reviews which stores completed review data)
-- ===================================================================
CREATE TABLE IF NOT EXISTS performance_reviews (
  id          SERIAL PRIMARY KEY,
  staff_id    INTEGER NOT NULL,
  reviewer_id UUID,
  review_type VARCHAR(50) DEFAULT 'annual',
  period      VARCHAR(50),
  status      VARCHAR(50) DEFAULT 'pending',
  due_date    DATE,
  completed_at TIMESTAMP WITHOUT TIME ZONE,
  notes       TEXT,
  created_at  TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  updated_at  TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_performance_reviews_staff_id ON performance_reviews(staff_id);
CREATE INDEX IF NOT EXISTS idx_performance_reviews_status ON performance_reviews(status);


-- ===================================================================
-- 21. patient_consents — Patient treatment/research consent records
-- ===================================================================
CREATE TABLE IF NOT EXISTS patient_consents (
  id           SERIAL PRIMARY KEY,
  patient_uid  UUID NOT NULL,
  consent_type VARCHAR(100) NOT NULL,
  granted      BOOLEAN NOT NULL DEFAULT TRUE,
  granted_at   TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  granted_by   UUID,
  revoked_at   TIMESTAMP WITHOUT TIME ZONE,
  revoked_by   UUID,
  ip_address   VARCHAR(45),
  notes        TEXT,
  status       VARCHAR(20) DEFAULT 'active',
  created_at   TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_patient_consents_patient_uid ON patient_consents(patient_uid);
CREATE INDEX IF NOT EXISTS idx_patient_consents_type ON patient_consents(consent_type);
CREATE INDEX IF NOT EXISTS idx_patient_consents_status ON patient_consents(status);


-- ===================================================================
-- 22. otp_codes — Dev/alternative OTP store (referenced by otpDevRoutes)
-- ===================================================================
CREATE TABLE IF NOT EXISTS otp_codes (
  id         SERIAL PRIMARY KEY,
  phone      VARCHAR(20) NOT NULL,
  otp_code   VARCHAR(10),
  code       VARCHAR(10),
  purpose    VARCHAR(50) DEFAULT 'login',
  expires_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
  used       BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_otp_codes_phone ON otp_codes(phone);
CREATE INDEX IF NOT EXISTS idx_otp_codes_expires_at ON otp_codes(expires_at);


-- ===================================================================
-- 23. medication_reminders — Patient medication reminder schedules
-- ===================================================================
CREATE TABLE IF NOT EXISTS medication_reminders (
  id              SERIAL PRIMARY KEY,
  patient_uid     UUID NOT NULL,
  medication_name VARCHAR(255) NOT NULL,
  dosage          VARCHAR(100),
  frequency       VARCHAR(100),
  reminder_times  JSONB,
  start_date      DATE,
  end_date        DATE,
  is_active       BOOLEAN DEFAULT TRUE,
  notes           TEXT,
  created_at      TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  updated_at      TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_med_reminders_patient_uid ON medication_reminders(patient_uid);
CREATE INDEX IF NOT EXISTS idx_med_reminders_active ON medication_reminders(patient_uid, is_active);


-- ===================================================================
-- 24. user_roles — Role metadata / permissions lookup for users
-- ===================================================================
CREATE TABLE IF NOT EXISTS user_roles (
  id               SERIAL PRIMARY KEY,
  role_name        VARCHAR(50) UNIQUE NOT NULL,
  role_description TEXT,
  permissions      JSONB,
  is_active        BOOLEAN DEFAULT TRUE,
  created_at       TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  updated_at       TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
-- Seed core roles
INSERT INTO user_roles (role_name, role_description, permissions) VALUES
  ('PATIENT',   'Patient account',       '["read:own"]'),
  ('DOCTOR',    'Medical doctor',        '["read:patient","write:medical","read:schedule"]'),
  ('STAFF',     'Hospital staff',        '["read:patient","write:staff"]'),
  ('ADMIN',     'System administrator',  '["*"]'),
  ('HR',        'HR staff',              '["read:staff","write:hr"]'),
  ('PHARMACIST','Pharmacy staff',        '["read:patient","write:pharmacy"]'),
  ('LAB',       'Laboratory staff',      '["read:patient","write:lab"]')
ON CONFLICT (role_name) DO NOTHING;


-- ===================================================================
-- 25. failed_notifications — Retry queue for push/SMS failures
-- ===================================================================
CREATE TABLE IF NOT EXISTS failed_notifications (
  id            SERIAL PRIMARY KEY,
  user_id       UUID,
  type          VARCHAR(20) NOT NULL DEFAULT 'push',
  phone         VARCHAR(20),
  device_token  TEXT,
  title         VARCHAR(255),
  body          TEXT,
  data          JSONB,
  error_message TEXT,
  retry_count   INTEGER DEFAULT 0,
  max_retries   INTEGER DEFAULT 4,
  last_retry_at TIMESTAMP WITHOUT TIME ZONE,
  next_retry_at TIMESTAMP WITHOUT TIME ZONE,
  status        VARCHAR(20) DEFAULT 'pending',
  created_at    TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_failed_notifications_status ON failed_notifications(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_failed_notifications_user ON failed_notifications(user_id);


-- ===================================================================
-- ALTER TABLE additions for existing tables
-- ===================================================================

-- users: abha_number + abha_address (used by abdmService)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS abha_number VARCHAR(20),
  ADD COLUMN IF NOT EXISTS abha_address VARCHAR(255),
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS device_token TEXT,
  ADD COLUMN IF NOT EXISTS created_by UUID,
  ADD COLUMN IF NOT EXISTS updated_by UUID;

CREATE INDEX IF NOT EXISTS idx_users_abha_number ON users(abha_number) WHERE abha_number IS NOT NULL;

-- staff: performance_rating + last_review_date (used by performanceService)
ALTER TABLE staff
  ADD COLUMN IF NOT EXISTS performance_rating NUMERIC(3, 1),
  ADD COLUMN IF NOT EXISTS last_review_date DATE;

-- icd10_codes: referenced by diagnosisService for code lookups
-- (lightweight reference table — ~70k rows in production, seeded separately)
CREATE TABLE IF NOT EXISTS icd10_codes (
  id          SERIAL PRIMARY KEY,
  code        VARCHAR(10) UNIQUE NOT NULL,
  description TEXT NOT NULL,
  category    VARCHAR(100),
  is_active   BOOLEAN DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_icd10_codes_code ON icd10_codes(code);
