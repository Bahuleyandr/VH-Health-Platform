-- Migration 010: Payroll Compliance Features
-- Full & Final Settlements, Investment Declarations, Leave Encashments,
-- Payslip Queries, Bulk Revision Jobs

CREATE TABLE IF NOT EXISTS full_final_settlements (
  id SERIAL PRIMARY KEY,
  staff_uid UUID REFERENCES users(uid),
  separation_type VARCHAR(30) NOT NULL,
  last_working_day DATE NOT NULL,
  last_month_days_worked INTEGER,
  last_month_basic NUMERIC(12,2) DEFAULT 0,
  last_month_allowances NUMERIC(12,2) DEFAULT 0,
  earned_leave_balance INTEGER DEFAULT 0,
  leave_encashment_amount NUMERIC(12,2) DEFAULT 0,
  notice_period_days INTEGER DEFAULT 0,
  notice_shortfall_days INTEGER DEFAULT 0,
  notice_recovery_amount NUMERIC(12,2) DEFAULT 0,
  years_of_service NUMERIC(5,2) DEFAULT 0,
  gratuity_eligible BOOLEAN DEFAULT FALSE,
  gratuity_amount NUMERIC(12,2) DEFAULT 0,
  bonus_payable NUMERIC(12,2) DEFAULT 0,
  other_deductions NUMERIC(12,2) DEFAULT 0,
  other_deductions_reason TEXT,
  gross_payable NUMERIC(12,2) DEFAULT 0,
  total_deductions NUMERIC(12,2) DEFAULT 0,
  net_payable NUMERIC(12,2) DEFAULT 0,
  status VARCHAR(20) DEFAULT 'draft',
  hr_approved_by UUID,
  hr_approved_at TIMESTAMP,
  admin_approved_by UUID,
  admin_approved_at TIMESTAMP,
  payment_date DATE,
  payment_reference TEXT,
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS investment_declarations (
  id SERIAL PRIMARY KEY,
  staff_uid UUID REFERENCES users(uid),
  financial_year VARCHAR(10) NOT NULL,
  ppf NUMERIC(10,2) DEFAULT 0,
  epf_voluntary NUMERIC(10,2) DEFAULT 0,
  elss NUMERIC(10,2) DEFAULT 0,
  lic_premium NUMERIC(10,2) DEFAULT 0,
  nsc NUMERIC(10,2) DEFAULT 0,
  home_loan_principal NUMERIC(10,2) DEFAULT 0,
  tuition_fees NUMERIC(10,2) DEFAULT 0,
  other_80c NUMERIC(10,2) DEFAULT 0,
  health_insurance_self NUMERIC(10,2) DEFAULT 0,
  health_insurance_parents NUMERIC(10,2) DEFAULT 0,
  education_loan_interest NUMERIC(10,2) DEFAULT 0,
  rent_paid_monthly NUMERIC(10,2) DEFAULT 0,
  rent_receipt_provided BOOLEAN DEFAULT FALSE,
  home_loan_interest NUMERIC(10,2) DEFAULT 0,
  nps_contribution NUMERIC(10,2) DEFAULT 0,
  status VARCHAR(20) DEFAULT 'draft',
  submitted_at TIMESTAMP,
  approved_by UUID,
  approved_at TIMESTAMP,
  proof_submitted BOOLEAN DEFAULT FALSE,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(staff_uid, financial_year)
);

CREATE TABLE IF NOT EXISTS leave_encashments (
  id SERIAL PRIMARY KEY,
  staff_uid UUID REFERENCES users(uid),
  encashment_type VARCHAR(20) NOT NULL,
  leave_days INTEGER NOT NULL,
  daily_rate NUMERIC(10,2) NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  financial_year VARCHAR(10),
  payslip_id INTEGER REFERENCES payslips(id),
  fnf_id INTEGER REFERENCES full_final_settlements(id),
  approved_by UUID,
  approved_at TIMESTAMP,
  status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payslip_queries (
  id SERIAL PRIMARY KEY,
  payslip_id INTEGER REFERENCES payslips(id),
  staff_uid UUID NOT NULL,
  subject VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  category VARCHAR(30) DEFAULT 'general',
  status VARCHAR(20) DEFAULT 'open',
  resolved_by UUID,
  resolved_at TIMESTAMP,
  resolution_note TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payslip_query_replies (
  id SERIAL PRIMARY KEY,
  query_id INTEGER REFERENCES payslip_queries(id),
  author_uid UUID NOT NULL,
  author_role VARCHAR(20) NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bulk_revision_jobs (
  id SERIAL PRIMARY KEY,
  description TEXT NOT NULL,
  revision_type VARCHAR(20) NOT NULL,
  target_type VARCHAR(20) NOT NULL,
  target_value VARCHAR(100),
  increment_type VARCHAR(10),
  increment_value NUMERIC(10,2),
  bonus_amount NUMERIC(10,2),
  effective_from DATE NOT NULL,
  staff_count INTEGER DEFAULT 0,
  processed_count INTEGER DEFAULT 0,
  status VARCHAR(20) DEFAULT 'draft',
  approved_by UUID,
  approved_at TIMESTAMP,
  completed_at TIMESTAMP,
  error_log TEXT,
  created_by UUID,
  created_at TIMESTAMP DEFAULT NOW()
);

-- staff_salary already has date_of_joining and pan_number; add missing columns
ALTER TABLE staff_salary
  ADD COLUMN IF NOT EXISTS notice_period_days INTEGER DEFAULT 30,
  ADD COLUMN IF NOT EXISTS dob DATE;

-- users table already has birthday; add pan_number if missing
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS pan_number VARCHAR(20);

CREATE INDEX IF NOT EXISTS idx_fnf_staff ON full_final_settlements(staff_uid);
CREATE INDEX IF NOT EXISTS idx_declarations_staff ON investment_declarations(staff_uid, financial_year);
CREATE INDEX IF NOT EXISTS idx_pq_payslip ON payslip_queries(payslip_id);
CREATE INDEX IF NOT EXISTS idx_pq_staff ON payslip_queries(staff_uid);
CREATE INDEX IF NOT EXISTS idx_bulk_rev ON bulk_revision_jobs(status);
