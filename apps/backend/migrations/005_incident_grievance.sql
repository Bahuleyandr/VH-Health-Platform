-- Incident Reports
CREATE TABLE IF NOT EXISTS incident_reports (
  id SERIAL PRIMARY KEY,
  report_number VARCHAR(20) UNIQUE NOT NULL,
  reporter_id INTEGER REFERENCES users(id),
  incident_type VARCHAR(50) NOT NULL,
  severity VARCHAR(20) NOT NULL DEFAULT 'moderate',
  title VARCHAR(200) NOT NULL,
  description TEXT NOT NULL,
  location VARCHAR(200),
  incident_date TIMESTAMP NOT NULL,
  patient_involved BOOLEAN DEFAULT false,
  patient_id INTEGER REFERENCES users(id),
  patient_name VARCHAR(200),
  witnesses TEXT,
  immediate_action_taken TEXT,
  status VARCHAR(20) DEFAULT 'submitted',
  assigned_to INTEGER REFERENCES users(id),
  priority VARCHAR(20) DEFAULT 'normal',
  admin_notes TEXT,
  resolution TEXT,
  resolved_at TIMESTAMP,
  resolved_by INTEGER REFERENCES users(id),
  is_anonymous BOOLEAN DEFAULT false,
  attachments TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE SEQUENCE IF NOT EXISTS incident_number_seq START 1;

CREATE OR REPLACE FUNCTION generate_incident_number()
RETURNS TRIGGER AS $$
BEGIN
  NEW.report_number := 'INC-' || TO_CHAR(NOW(), 'YYYY') || '-' || LPAD(nextval('incident_number_seq')::TEXT, 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS incident_number_trigger ON incident_reports;
CREATE TRIGGER incident_number_trigger
  BEFORE INSERT ON incident_reports
  FOR EACH ROW EXECUTE FUNCTION generate_incident_number();

-- Staff Grievances
CREATE TABLE IF NOT EXISTS staff_grievances (
  id SERIAL PRIMARY KEY,
  grievance_number VARCHAR(20) UNIQUE NOT NULL,
  reporter_id INTEGER REFERENCES users(id),
  grievance_type VARCHAR(50) NOT NULL,
  subject VARCHAR(200) NOT NULL,
  description TEXT NOT NULL,
  against_whom VARCHAR(200),
  department VARCHAR(100),
  incident_date DATE,
  is_anonymous BOOLEAN DEFAULT false,
  status VARCHAR(20) DEFAULT 'submitted',
  priority VARCHAR(20) DEFAULT 'normal',
  assigned_to INTEGER REFERENCES users(id),
  confidential BOOLEAN DEFAULT true,
  hr_notes TEXT,
  resolution TEXT,
  resolved_at TIMESTAMP,
  resolved_by INTEGER REFERENCES users(id),
  acknowledgement_sent BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE SEQUENCE IF NOT EXISTS grievance_number_seq START 1;

CREATE OR REPLACE FUNCTION generate_grievance_number()
RETURNS TRIGGER AS $$
BEGIN
  NEW.grievance_number := 'GRV-' || TO_CHAR(NOW(), 'YYYY') || '-' || LPAD(nextval('grievance_number_seq')::TEXT, 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS grievance_number_trigger ON staff_grievances;
CREATE TRIGGER grievance_number_trigger
  BEFORE INSERT ON staff_grievances
  FOR EACH ROW EXECUTE FUNCTION generate_grievance_number();

-- Status updates / comments thread for both
CREATE TABLE IF NOT EXISTS report_updates (
  id SERIAL PRIMARY KEY,
  report_type VARCHAR(20) NOT NULL,
  report_id INTEGER NOT NULL,
  author_id INTEGER REFERENCES users(id),
  author_role VARCHAR(50),
  message TEXT NOT NULL,
  is_internal BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_incident_reporter ON incident_reports(reporter_id);
CREATE INDEX IF NOT EXISTS idx_incident_status ON incident_reports(status);
CREATE INDEX IF NOT EXISTS idx_incident_severity ON incident_reports(severity);
CREATE INDEX IF NOT EXISTS idx_grievance_reporter ON staff_grievances(reporter_id);
CREATE INDEX IF NOT EXISTS idx_grievance_status ON staff_grievances(status);
CREATE INDEX IF NOT EXISTS idx_report_updates ON report_updates(report_type, report_id);
