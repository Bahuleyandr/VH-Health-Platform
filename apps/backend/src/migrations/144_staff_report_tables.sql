-- Staff incident and grievance reporting tables.
--
-- These controllers have existed for both staff self-service and admin review,
-- but the tables only existed in the historical schema dump. Keep reporter and
-- assignee references UUID-based because staff JWTs carry users.uid in `sub`.

CREATE TABLE IF NOT EXISTS incident_reports (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid
    REFERENCES tenants(id) ON DELETE CASCADE,
  report_number VARCHAR(30) NOT NULL UNIQUE
    DEFAULT ('INC-' || to_char(now(), 'YYYYMMDD') || '-' || substr(gen_random_uuid()::text, 1, 8)),
  reporter_id UUID REFERENCES users(uid) ON DELETE SET NULL,
  incident_type VARCHAR(50) NOT NULL,
  severity VARCHAR(20) NOT NULL DEFAULT 'moderate'
    CHECK (severity IN ('low', 'moderate', 'severe', 'sentinel')),
  title VARCHAR(200) NOT NULL,
  description TEXT NOT NULL,
  location VARCHAR(200),
  incident_date TIMESTAMPTZ NOT NULL,
  patient_involved BOOLEAN NOT NULL DEFAULT false,
  patient_uid UUID REFERENCES users(uid) ON DELETE SET NULL,
  patient_name VARCHAR(200),
  witnesses TEXT,
  immediate_action_taken TEXT,
  status VARCHAR(30) NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'under_review', 'investigating', 'resolved', 'closed')),
  assigned_to UUID REFERENCES users(uid) ON DELETE SET NULL,
  priority VARCHAR(20) NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('normal', 'high', 'urgent')),
  admin_notes TEXT,
  resolution TEXT,
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES users(uid) ON DELETE SET NULL,
  is_anonymous BOOLEAN NOT NULL DEFAULT false,
  attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_incident_reports_reporter_created
  ON incident_reports(reporter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_incident_reports_status_priority
  ON incident_reports(status, priority, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_incident_reports_type_created
  ON incident_reports(incident_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_incident_reports_tenant_created
  ON incident_reports(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS staff_grievances (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid
    REFERENCES tenants(id) ON DELETE CASCADE,
  grievance_number VARCHAR(30) NOT NULL UNIQUE
    DEFAULT ('GRV-' || to_char(now(), 'YYYYMMDD') || '-' || substr(gen_random_uuid()::text, 1, 8)),
  reporter_id UUID REFERENCES users(uid) ON DELETE SET NULL,
  grievance_type VARCHAR(50) NOT NULL,
  subject VARCHAR(200) NOT NULL,
  description TEXT NOT NULL,
  against_whom VARCHAR(200),
  department VARCHAR(100),
  incident_date DATE,
  is_anonymous BOOLEAN NOT NULL DEFAULT false,
  status VARCHAR(30) NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'acknowledged', 'under_review', 'mediation', 'resolved', 'closed', 'escalated')),
  priority VARCHAR(20) NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('normal', 'high', 'urgent')),
  assigned_to UUID REFERENCES users(uid) ON DELETE SET NULL,
  confidential BOOLEAN NOT NULL DEFAULT true,
  hr_notes TEXT,
  resolution TEXT,
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES users(uid) ON DELETE SET NULL,
  acknowledgement_sent BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_staff_grievances_reporter_created
  ON staff_grievances(reporter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_staff_grievances_status_priority
  ON staff_grievances(status, priority, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_staff_grievances_type_created
  ON staff_grievances(grievance_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_staff_grievances_tenant_created
  ON staff_grievances(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS report_updates (
  id SERIAL PRIMARY KEY,
  report_type VARCHAR(20) NOT NULL CHECK (report_type IN ('incident', 'grievance')),
  report_id INTEGER NOT NULL,
  author_id UUID REFERENCES users(uid) ON DELETE SET NULL,
  author_role VARCHAR(50),
  message TEXT NOT NULL,
  is_internal BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_report_updates_report
  ON report_updates(report_type, report_id, created_at);
