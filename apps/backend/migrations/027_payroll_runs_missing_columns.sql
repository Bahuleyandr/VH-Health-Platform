-- Migration 027: Add missing columns to payroll_runs
-- These columns exist in the controller/API layer but were never added to the initial payroll_runs table (008_payroll.sql)

ALTER TABLE payroll_runs
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS employee_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hr_approved_by UUID,
  ADD COLUMN IF NOT EXISTS hr_approved_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS hr_comment TEXT,
  ADD COLUMN IF NOT EXISTS admin_approved_by UUID,
  ADD COLUMN IF NOT EXISTS admin_approved_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS admin_comment TEXT,
  ADD COLUMN IF NOT EXISTS approval_hash TEXT;

-- bulk_revision_jobs: add missing columns the controller references
ALTER TABLE bulk_revision_jobs
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

-- annual_review_reminders: ensure table exists with full schema (it may not if 008 was not fully applied)
CREATE TABLE IF NOT EXISTS annual_review_reminders (
  id SERIAL PRIMARY KEY,
  staff_uid UUID REFERENCES users(uid),
  review_year INTEGER NOT NULL,
  reminder_sent_at TIMESTAMP,
  revision_id INTEGER REFERENCES salary_revisions(id),
  status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(staff_uid, review_year)
);

-- payslip_queries: ensure reply column exists (used in queries)
ALTER TABLE payslip_queries
  ADD COLUMN IF NOT EXISTS resolved_by UUID,
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS resolution_note TEXT;

-- payslip_query_replies: ensure table exists
CREATE TABLE IF NOT EXISTS payslip_query_replies (
  id SERIAL PRIMARY KEY,
  query_id INTEGER REFERENCES payslip_queries(id),
  author_uid UUID NOT NULL,
  author_role VARCHAR(20) NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- salary_revisions: add proposed_by_name alias column (the controller joins on proposed_by → users.name)
-- No schema change needed — this is resolved via JOIN in queries

-- Indexes
CREATE INDEX IF NOT EXISTS idx_payroll_runs_status ON payroll_runs(status);
CREATE INDEX IF NOT EXISTS idx_annual_review_year ON annual_review_reminders(review_year);
