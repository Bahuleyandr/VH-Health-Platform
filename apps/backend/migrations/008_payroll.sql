-- 008_payroll.sql
-- Payroll & HR Compensation System
-- Staff salary configuration
-- One row per staff member, updated when salary changes
CREATE TABLE IF NOT EXISTS staff_salary (
  id SERIAL PRIMARY KEY,
  staff_uid UUID REFERENCES users(uid) UNIQUE NOT NULL,  -- FK to users.uid
  -- Salary components (monthly, in INR)
  basic_salary NUMERIC(12,2) NOT NULL DEFAULT 0,
  hra_pct NUMERIC(5,2) DEFAULT 40.00,        -- HRA as % of basic (40% default)
  da_pct NUMERIC(5,2) DEFAULT 10.00,         -- DA as % of basic
  special_allowance NUMERIC(12,2) DEFAULT 0, -- fixed monthly
  transport_allowance NUMERIC(12,2) DEFAULT 0,
  medical_allowance NUMERIC(12,2) DEFAULT 0,
  -- Deductions config
  pf_employee_pct NUMERIC(5,2) DEFAULT 12.00,  -- Employee PF (12% of basic)
  pf_employer_pct NUMERIC(5,2) DEFAULT 12.00,  -- Employer PF (for info)
  esi_applicable BOOLEAN DEFAULT false,          -- ESI if gross < 21000
  professional_tax NUMERIC(8,2) DEFAULT 200,     -- Monthly professional tax
  tds_monthly NUMERIC(12,2) DEFAULT 0,           -- Monthly TDS deduction
  -- Employment details (for payslip)
  designation VARCHAR(200),
  department VARCHAR(200),
  employee_id VARCHAR(50),
  date_of_joining DATE,
  pan_number VARCHAR(20),
  pf_uan VARCHAR(30),
  bank_account VARCHAR(50),
  bank_name VARCHAR(100),
  bank_ifsc VARCHAR(20),
  -- Meta
  effective_from DATE DEFAULT CURRENT_DATE,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Monthly payroll runs
CREATE TABLE IF NOT EXISTS payroll_runs (
  id SERIAL PRIMARY KEY,
  month INTEGER NOT NULL,      -- 1-12
  year INTEGER NOT NULL,
  status VARCHAR(20) DEFAULT 'draft',  -- draft | processing | completed | locked
  total_staff INTEGER DEFAULT 0,
  total_gross NUMERIC(14,2) DEFAULT 0,
  total_net NUMERIC(14,2) DEFAULT 0,
  total_deductions NUMERIC(14,2) DEFAULT 0,
  generated_by UUID REFERENCES users(uid),
  generated_at TIMESTAMP,
  locked_by UUID REFERENCES users(uid),
  locked_at TIMESTAMP,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(month, year)
);

-- Individual payslips (one per staff per month)
CREATE TABLE IF NOT EXISTS payslips (
  id SERIAL PRIMARY KEY,
  payroll_run_id INTEGER REFERENCES payroll_runs(id),
  staff_uid UUID REFERENCES users(uid),
  month INTEGER NOT NULL,
  year INTEGER NOT NULL,
  -- Working days
  total_working_days INTEGER DEFAULT 0,
  days_present INTEGER DEFAULT 0,
  days_absent INTEGER DEFAULT 0,
  days_leave INTEGER DEFAULT 0,
  days_half INTEGER DEFAULT 0,
  overtime_hours NUMERIC(6,2) DEFAULT 0,
  overtime_rate NUMERIC(10,2) DEFAULT 0,    -- per hour
  -- Earnings
  basic_earned NUMERIC(12,2) DEFAULT 0,     -- prorated basic
  hra_earned NUMERIC(12,2) DEFAULT 0,
  da_earned NUMERIC(12,2) DEFAULT 0,
  special_allowance_earned NUMERIC(12,2) DEFAULT 0,
  transport_allowance_earned NUMERIC(12,2) DEFAULT 0,
  medical_allowance_earned NUMERIC(12,2) DEFAULT 0,
  overtime_pay NUMERIC(12,2) DEFAULT 0,
  bonus_this_month NUMERIC(12,2) DEFAULT 0, -- one-time bonus if applicable
  gross_salary NUMERIC(12,2) DEFAULT 0,
  -- Deductions
  pf_employee NUMERIC(12,2) DEFAULT 0,
  esi_employee NUMERIC(12,2) DEFAULT 0,
  professional_tax NUMERIC(12,2) DEFAULT 0,
  tds NUMERIC(12,2) DEFAULT 0,
  other_deductions NUMERIC(12,2) DEFAULT 0,
  total_deductions NUMERIC(12,2) DEFAULT 0,
  -- Net
  net_salary NUMERIC(12,2) DEFAULT 0,
  -- PDF
  pdf_key TEXT,      -- R2 key for PDF payslip
  pdf_generated_at TIMESTAMP,
  -- Metadata
  status VARCHAR(20) DEFAULT 'draft',  -- draft | issued | viewed | downloaded
  viewed_at TIMESTAMP,
  downloaded_at TIMESTAMP,
  issued_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(staff_uid, month, year)
);

-- Salary increment / bonus proposals (dual countersign required)
CREATE TABLE IF NOT EXISTS salary_revisions (
  id SERIAL PRIMARY KEY,
  revision_number VARCHAR(30) UNIQUE NOT NULL,  -- REV-2026-0001
  staff_uid UUID REFERENCES users(uid),
  revision_type VARCHAR(20) NOT NULL,  -- increment | bonus | deduction_change | component_change
  -- Current vs proposed
  current_basic NUMERIC(12,2),
  proposed_basic NUMERIC(12,2),
  current_gross NUMERIC(12,2),
  proposed_gross NUMERIC(12,2),
  increment_amount NUMERIC(12,2),    -- for increment
  increment_pct NUMERIC(5,2),        -- percentage increase
  bonus_amount NUMERIC(12,2),        -- one-time bonus
  bonus_reason TEXT,
  other_changes JSONB,               -- changes to allowances/deductions
  effective_from DATE NOT NULL,
  reason TEXT NOT NULL,
  -- Dual countersign workflow
  proposed_by UUID REFERENCES users(uid),
  proposed_at TIMESTAMP DEFAULT NOW(),
  -- HR signature
  hr_signed_by UUID REFERENCES users(uid),
  hr_signed_at TIMESTAMP,
  hr_comment TEXT,
  -- Admin signature
  admin_signed_by UUID REFERENCES users(uid),
  admin_signed_at TIMESTAMP,
  admin_comment TEXT,
  -- Status
  status VARCHAR(30) DEFAULT 'pending_hr',
  -- pending_hr | pending_admin | approved | rejected | cancelled | applied
  rejected_by UUID REFERENCES users(uid),
  rejected_at TIMESTAMP,
  rejection_reason TEXT,
  applied_at TIMESTAMP,
  -- Integrity: store hash of final state to prevent tampering after sign
  signature_hash VARCHAR(64),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE SEQUENCE IF NOT EXISTS revision_number_seq START 1;
CREATE OR REPLACE FUNCTION generate_revision_number()
RETURNS TRIGGER AS $$
BEGIN
  NEW.revision_number := 'REV-' || TO_CHAR(NOW(), 'YYYY') || '-' || LPAD(nextval('revision_number_seq')::TEXT, 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS revision_number_trigger ON salary_revisions;
CREATE TRIGGER revision_number_trigger
  BEFORE INSERT ON salary_revisions
  FOR EACH ROW EXECUTE FUNCTION generate_revision_number();

-- Annual review reminder tracking
CREATE TABLE IF NOT EXISTS annual_review_reminders (
  id SERIAL PRIMARY KEY,
  staff_uid UUID REFERENCES users(uid),
  review_year INTEGER NOT NULL,
  reminder_sent_at TIMESTAMP,
  revision_id INTEGER REFERENCES salary_revisions(id),
  status VARCHAR(20) DEFAULT 'pending',  -- pending | initiated | completed | skipped
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(staff_uid, review_year)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_payslips_staff ON payslips(staff_uid);
CREATE INDEX IF NOT EXISTS idx_payslips_month ON payslips(month, year);
CREATE INDEX IF NOT EXISTS idx_revisions_staff ON salary_revisions(staff_uid);
CREATE INDEX IF NOT EXISTS idx_revisions_status ON salary_revisions(status);
CREATE INDEX IF NOT EXISTS idx_payroll_runs ON payroll_runs(month, year);
CREATE INDEX IF NOT EXISTS idx_staff_salary_uid ON staff_salary(staff_uid);
