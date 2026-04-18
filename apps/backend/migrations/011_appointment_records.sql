-- Migration 011: Appointment confirmation workflow, documents, audit trail
-- Add confirmation workflow columns to appointments
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS token_number INTEGER,
  ADD COLUMN IF NOT EXISTS confirmed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS confirmation_notes TEXT,
  ADD COLUMN IF NOT EXISTS no_show_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS cancellation_reason TEXT,
  ADD COLUMN IF NOT EXISTS reschedule_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sla_target_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS first_contact_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS department VARCHAR(255);

-- Auto-increment token per day (daily counter)
CREATE SEQUENCE IF NOT EXISTS appointment_daily_token_seq;

-- Appointment documents (prescriptions, reports uploaded by staff post-visit)
CREATE TABLE IF NOT EXISTS appointment_documents (
  id SERIAL PRIMARY KEY,
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE CASCADE,
  patient_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  doctor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  upload_role VARCHAR(20) NOT NULL DEFAULT 'staff',
  document_type VARCHAR(30) NOT NULL DEFAULT 'prescription',
  file_key TEXT NOT NULL,
  file_url TEXT,
  file_name VARCHAR(500),
  file_size INTEGER,
  file_mime VARCHAR(100),
  notes TEXT,
  is_visible_to_patient BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Patient-uploaded records (prior prescriptions, reports from other hospitals)
CREATE TABLE IF NOT EXISTS patient_records (
  id SERIAL PRIMARY KEY,
  patient_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  document_type VARCHAR(30) NOT NULL DEFAULT 'other',
  title VARCHAR(255) NOT NULL,
  file_key TEXT NOT NULL,
  file_url TEXT,
  file_name VARCHAR(500),
  file_size INTEGER,
  file_mime VARCHAR(100),
  source_hospital VARCHAR(255),
  record_date DATE,
  notes TEXT,
  is_verified BOOLEAN DEFAULT FALSE,
  verified_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  verified_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Appointment status history (full audit trail)
CREATE TABLE IF NOT EXISTS appointment_status_history (
  id SERIAL PRIMARY KEY,
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE CASCADE,
  from_status VARCHAR(50),
  to_status VARCHAR(50) NOT NULL,
  changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  changed_by_role VARCHAR(50),
  reason TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_appt_docs_appointment ON appointment_documents(appointment_id);
CREATE INDEX IF NOT EXISTS idx_appt_docs_patient ON appointment_documents(patient_id);
CREATE INDEX IF NOT EXISTS idx_patient_records_patient ON patient_records(patient_id);
CREATE INDEX IF NOT EXISTS idx_appt_status_hist ON appointment_status_history(appointment_id);
CREATE INDEX IF NOT EXISTS idx_appt_confirmed_at ON appointments(confirmed_at);
CREATE INDEX IF NOT EXISTS idx_appt_date_status ON appointments(appointment_date, status);
