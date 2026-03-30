-- Migration 020: Add missing tables for canary checks, notification outbox, and clinical alerts
-- These tables were referenced in code but never had a migration file

-- Canary health check table
CREATE TABLE IF NOT EXISTS canary_checks (
  id SERIAL PRIMARY KEY,
  checked_at TIMESTAMP NOT NULL DEFAULT NOW(),
  status VARCHAR(20) NOT NULL DEFAULT 'ok',
  details JSONB
);
CREATE INDEX IF NOT EXISTS idx_canary_checks_checked_at ON canary_checks (checked_at DESC);

-- Notification outbox (persistent queue for retryable notifications)
CREATE TABLE IF NOT EXISTS notification_outbox (
  id SERIAL PRIMARY KEY,
  type VARCHAR(20) NOT NULL DEFAULT 'push',
  recipient_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  recipient_phone VARCHAR(20),
  title VARCHAR(255) NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  payload JSONB NOT NULL DEFAULT '{}',
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempted_at TIMESTAMP,
  sent_at TIMESTAMP,
  error_message TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notification_outbox_status ON notification_outbox (status, created_at);
CREATE INDEX IF NOT EXISTS idx_notification_outbox_recipient ON notification_outbox (recipient_id);

-- Clinical alerts (vital sign anomaly tracking)
CREATE TABLE IF NOT EXISTS clinical_alerts (
  id SERIAL PRIMARY KEY,
  patient_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  alert_type VARCHAR(50) NOT NULL DEFAULT 'VITAL_ANOMALY',
  vital_name VARCHAR(100),
  vital_value NUMERIC(10,4),
  severity VARCHAR(20) NOT NULL DEFAULT 'medium',
  message TEXT,
  acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
  acknowledged_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  acknowledged_at TIMESTAMP,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_clinical_alerts_patient ON clinical_alerts (patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clinical_alerts_severity ON clinical_alerts (severity, acknowledged);
