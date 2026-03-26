-- Migration 006: Universal Audit Log Table
-- Captures every API request automatically via middleware

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  -- Who
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_name VARCHAR(200),
  user_role VARCHAR(100),
  ip_address VARCHAR(50),
  -- What
  method VARCHAR(10) NOT NULL,
  path TEXT NOT NULL,
  module VARCHAR(50),      -- derived: attendance | leave | incidents | shifts | users | doctors | etc
  action VARCHAR(100),     -- derived: create_leave | approve_leave | submit_incident | etc
  -- Request
  query_params JSONB,
  request_summary TEXT,    -- sanitised body summary (no passwords/tokens)
  -- Response
  status_code INTEGER,
  response_time_ms INTEGER,
  success BOOLEAN,
  error_message TEXT,
  -- Meta
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for fast admin queries
CREATE INDEX IF NOT EXISTS idx_audit_user    ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_module  ON audit_log(module);
CREATE INDEX IF NOT EXISTS idx_audit_ts      ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_status  ON audit_log(status_code);
CREATE INDEX IF NOT EXISTS idx_audit_method  ON audit_log(method);

-- Note: Add a cron to DELETE FROM audit_log WHERE created_at < NOW() - INTERVAL '90 days'
-- This is handled in scheduler.js
