-- 079_payroll_schema_port.sql
-- Consolidates the payroll schema from the legacy apps/backend/migrations/
-- tree (008, 009, 010, 027) into the canonical src/migrations/ tree.
--
-- Before this: /dashboard/my-payslips (+ HR payroll surfaces) 500'd on
-- dev/test DBs because the tables lived only in the legacy tree and
-- src/migrations/ runMigrations() never applied them.
--
-- All 14 tables are idempotent (IF NOT EXISTS) — prod / CI envs that
-- already ran the legacy migrations via ci-setup-db.mjs are unaffected.
-- Column ALTERs use ADD COLUMN IF NOT EXISTS, matching the same safety
-- contract.
--
-- Source-of-truth mapping (legacy → this file):
--   008_payroll.sql                 → §1 staff_salary, §2 payroll_runs,
--                                     §3 payslips, §4 salary_revisions,
--                                     §5 annual_review_reminders + trigger
--   009_payroll_complete.sql        → §6 salary_advances,
--                                     §7 advance_deductions,
--                                     §8 salary_arrears,
--                                     §9 annual_tax_summaries +
--                                     payslips extension
--   010_payroll_compliance.sql      → §10 full_final_settlements,
--                                     §11 investment_declarations,
--                                     §12 leave_encashments,
--                                     §13 payslip_queries,
--                                     §14 payslip_query_replies,
--                                     §15 bulk_revision_jobs +
--                                     staff_salary + users ALTERs
--   027_payroll_runs_missing_columns → payroll_runs + bulk_revision_jobs
--                                      + payslip_queries ALTERs

-- ══════════ §1. staff_salary ══════════
CREATE TABLE IF NOT EXISTS staff_salary (
  id SERIAL PRIMARY KEY,
  staff_uid UUID REFERENCES users(uid) UNIQUE NOT NULL,
  basic_salary NUMERIC(12,2) NOT NULL DEFAULT 0,
  hra_pct NUMERIC(5,2) DEFAULT 40.00,
  da_pct NUMERIC(5,2) DEFAULT 10.00,
  special_allowance NUMERIC(12,2) DEFAULT 0,
  transport_allowance NUMERIC(12,2) DEFAULT 0,
  medical_allowance NUMERIC(12,2) DEFAULT 0,
  pf_employee_pct NUMERIC(5,2) DEFAULT 12.00,
  pf_employer_pct NUMERIC(5,2) DEFAULT 12.00,
  esi_applicable BOOLEAN DEFAULT FALSE,
  professional_tax NUMERIC(8,2) DEFAULT 200,
  tds_monthly NUMERIC(12,2) DEFAULT 0,
  designation VARCHAR(200),
  department VARCHAR(200),
  employee_id VARCHAR(50),
  date_of_joining DATE,
  pan_number VARCHAR(20),
  pf_uan VARCHAR(30),
  bank_account VARCHAR(50),
  bank_name VARCHAR(100),
  bank_ifsc VARCHAR(20),
  effective_from DATE DEFAULT CURRENT_DATE,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 010-era additions to staff_salary
ALTER TABLE staff_salary
  ADD COLUMN IF NOT EXISTS notice_period_days INTEGER DEFAULT 30,
  ADD COLUMN IF NOT EXISTS dob DATE;

CREATE INDEX IF NOT EXISTS idx_staff_salary_uid ON staff_salary(staff_uid);

-- ══════════ §2. payroll_runs ══════════
CREATE TABLE IF NOT EXISTS payroll_runs (
  id SERIAL PRIMARY KEY,
  month INTEGER NOT NULL,
  year INTEGER NOT NULL,
  status VARCHAR(20) DEFAULT 'draft',
  total_staff INTEGER DEFAULT 0,
  total_gross NUMERIC(14,2) DEFAULT 0,
  total_net NUMERIC(14,2) DEFAULT 0,
  total_deductions NUMERIC(14,2) DEFAULT 0,
  generated_by UUID REFERENCES users(uid),
  generated_at TIMESTAMPTZ,
  locked_by UUID REFERENCES users(uid),
  locked_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(month, year)
);

-- 027-era additions to payroll_runs
ALTER TABLE payroll_runs
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS employee_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hr_approved_by UUID,
  ADD COLUMN IF NOT EXISTS hr_approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS hr_comment TEXT,
  ADD COLUMN IF NOT EXISTS admin_approved_by UUID,
  ADD COLUMN IF NOT EXISTS admin_approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS admin_comment TEXT,
  ADD COLUMN IF NOT EXISTS approval_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_payroll_runs ON payroll_runs(month, year);
CREATE INDEX IF NOT EXISTS idx_payroll_runs_status ON payroll_runs(status);

-- ══════════ §3. payslips ══════════
CREATE TABLE IF NOT EXISTS payslips (
  id SERIAL PRIMARY KEY,
  payroll_run_id INTEGER REFERENCES payroll_runs(id),
  staff_uid UUID REFERENCES users(uid),
  month INTEGER NOT NULL,
  year INTEGER NOT NULL,
  total_working_days INTEGER DEFAULT 0,
  days_present INTEGER DEFAULT 0,
  days_absent INTEGER DEFAULT 0,
  days_leave INTEGER DEFAULT 0,
  days_half INTEGER DEFAULT 0,
  overtime_hours NUMERIC(6,2) DEFAULT 0,
  overtime_rate NUMERIC(10,2) DEFAULT 0,
  basic_earned NUMERIC(12,2) DEFAULT 0,
  hra_earned NUMERIC(12,2) DEFAULT 0,
  da_earned NUMERIC(12,2) DEFAULT 0,
  special_allowance_earned NUMERIC(12,2) DEFAULT 0,
  transport_allowance_earned NUMERIC(12,2) DEFAULT 0,
  medical_allowance_earned NUMERIC(12,2) DEFAULT 0,
  overtime_pay NUMERIC(12,2) DEFAULT 0,
  bonus_this_month NUMERIC(12,2) DEFAULT 0,
  gross_salary NUMERIC(12,2) DEFAULT 0,
  pf_employee NUMERIC(12,2) DEFAULT 0,
  esi_employee NUMERIC(12,2) DEFAULT 0,
  professional_tax NUMERIC(12,2) DEFAULT 0,
  tds NUMERIC(12,2) DEFAULT 0,
  other_deductions NUMERIC(12,2) DEFAULT 0,
  total_deductions NUMERIC(12,2) DEFAULT 0,
  net_salary NUMERIC(12,2) DEFAULT 0,
  pdf_key TEXT,
  pdf_generated_at TIMESTAMPTZ,
  status VARCHAR(20) DEFAULT 'draft',
  viewed_at TIMESTAMPTZ,
  downloaded_at TIMESTAMPTZ,
  issued_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(staff_uid, month, year)
);

-- 009-era additions to payslips
ALTER TABLE payslips
  ADD COLUMN IF NOT EXISTS lop_days NUMERIC(5,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lop_deduction NUMERIC(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS arrears_amount NUMERIC(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS advance_deduction NUMERIC(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS revision_note TEXT;

CREATE INDEX IF NOT EXISTS idx_payslips_staff ON payslips(staff_uid);
CREATE INDEX IF NOT EXISTS idx_payslips_month ON payslips(month, year);

-- ══════════ §4. salary_revisions + revision-number trigger ══════════
CREATE TABLE IF NOT EXISTS salary_revisions (
  id SERIAL PRIMARY KEY,
  revision_number VARCHAR(30) UNIQUE NOT NULL,
  staff_uid UUID REFERENCES users(uid),
  revision_type VARCHAR(20) NOT NULL,
  current_basic NUMERIC(12,2),
  proposed_basic NUMERIC(12,2),
  current_gross NUMERIC(12,2),
  proposed_gross NUMERIC(12,2),
  increment_amount NUMERIC(12,2),
  increment_pct NUMERIC(5,2),
  bonus_amount NUMERIC(12,2),
  bonus_reason TEXT,
  other_changes JSONB,
  effective_from DATE NOT NULL,
  reason TEXT NOT NULL,
  proposed_by UUID REFERENCES users(uid),
  proposed_at TIMESTAMPTZ DEFAULT NOW(),
  hr_signed_by UUID REFERENCES users(uid),
  hr_signed_at TIMESTAMPTZ,
  hr_comment TEXT,
  admin_signed_by UUID REFERENCES users(uid),
  admin_signed_at TIMESTAMPTZ,
  admin_comment TEXT,
  status VARCHAR(30) DEFAULT 'pending_hr',
  rejected_by UUID REFERENCES users(uid),
  rejected_at TIMESTAMPTZ,
  rejection_reason TEXT,
  applied_at TIMESTAMPTZ,
  signature_hash VARCHAR(64),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- revision_number auto-generator: REV-YYYY-NNNN
CREATE SEQUENCE IF NOT EXISTS revision_number_seq START 1;

CREATE OR REPLACE FUNCTION generate_revision_number()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.revision_number IS NULL OR NEW.revision_number = '' THEN
    NEW.revision_number := 'REV-' || TO_CHAR(NOW(), 'YYYY') || '-'
      || LPAD(nextval('revision_number_seq')::TEXT, 4, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS revision_number_trigger ON salary_revisions;
CREATE TRIGGER revision_number_trigger
  BEFORE INSERT ON salary_revisions
  FOR EACH ROW EXECUTE FUNCTION generate_revision_number();

CREATE INDEX IF NOT EXISTS idx_revisions_staff ON salary_revisions(staff_uid);
CREATE INDEX IF NOT EXISTS idx_revisions_status ON salary_revisions(status);

-- ══════════ §5. annual_review_reminders ══════════
CREATE TABLE IF NOT EXISTS annual_review_reminders (
  id SERIAL PRIMARY KEY,
  staff_uid UUID REFERENCES users(uid),
  review_year INTEGER NOT NULL,
  reminder_sent_at TIMESTAMPTZ,
  revision_id INTEGER REFERENCES salary_revisions(id),
  status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(staff_uid, review_year)
);
CREATE INDEX IF NOT EXISTS idx_annual_review_year ON annual_review_reminders(review_year);

-- ══════════ §6. salary_advances ══════════
CREATE TABLE IF NOT EXISTS salary_advances (
  id SERIAL PRIMARY KEY,
  staff_uid UUID REFERENCES users(uid),
  amount NUMERIC(12,2) NOT NULL,
  reason TEXT NOT NULL,
  approved_by UUID REFERENCES users(uid),
  approved_at TIMESTAMPTZ,
  status VARCHAR(20) DEFAULT 'pending',
  monthly_deduction NUMERIC(10,2) NOT NULL,
  total_deducted NUMERIC(12,2) DEFAULT 0,
  months_remaining INTEGER,
  deduction_start_month INTEGER,
  deduction_start_year INTEGER,
  fully_cleared_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_advances_staff ON salary_advances(staff_uid);

-- ══════════ §7. advance_deductions ══════════
CREATE TABLE IF NOT EXISTS advance_deductions (
  id SERIAL PRIMARY KEY,
  advance_id INTEGER REFERENCES salary_advances(id),
  payslip_id INTEGER REFERENCES payslips(id),
  staff_uid UUID,
  month INTEGER,
  year INTEGER,
  amount_deducted NUMERIC(10,2),
  balance_after NUMERIC(12,2),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ══════════ §8. salary_arrears ══════════
CREATE TABLE IF NOT EXISTS salary_arrears (
  id SERIAL PRIMARY KEY,
  staff_uid UUID REFERENCES users(uid),
  revision_id INTEGER REFERENCES salary_revisions(id),
  from_month INTEGER NOT NULL,
  from_year INTEGER NOT NULL,
  to_month INTEGER NOT NULL,
  to_year INTEGER NOT NULL,
  arrears_amount NUMERIC(12,2) NOT NULL,
  paid_in_month INTEGER,
  paid_in_year INTEGER,
  payslip_id INTEGER REFERENCES payslips(id),
  status VARCHAR(20) DEFAULT 'pending',
  calculated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_arrears_staff ON salary_arrears(staff_uid);

-- ══════════ §9. annual_tax_summaries ══════════
CREATE TABLE IF NOT EXISTS annual_tax_summaries (
  id SERIAL PRIMARY KEY,
  staff_uid UUID REFERENCES users(uid),
  financial_year VARCHAR(10) NOT NULL,
  total_basic NUMERIC(14,2) DEFAULT 0,
  total_hra NUMERIC(14,2) DEFAULT 0,
  total_da NUMERIC(14,2) DEFAULT 0,
  total_special_allowance NUMERIC(14,2) DEFAULT 0,
  total_transport_allowance NUMERIC(14,2) DEFAULT 0,
  total_medical_allowance NUMERIC(14,2) DEFAULT 0,
  total_overtime NUMERIC(14,2) DEFAULT 0,
  total_bonus NUMERIC(14,2) DEFAULT 0,
  total_arrears NUMERIC(14,2) DEFAULT 0,
  total_gross NUMERIC(14,2) DEFAULT 0,
  total_pf NUMERIC(14,2) DEFAULT 0,
  total_esi NUMERIC(14,2) DEFAULT 0,
  total_professional_tax NUMERIC(14,2) DEFAULT 0,
  total_tds NUMERIC(14,2) DEFAULT 0,
  total_advance_deductions NUMERIC(14,2) DEFAULT 0,
  total_deductions NUMERIC(14,2) DEFAULT 0,
  total_net NUMERIC(14,2) DEFAULT 0,
  taxable_income NUMERIC(14,2) DEFAULT 0,
  tax_payable NUMERIC(14,2) DEFAULT 0,
  months_included INTEGER DEFAULT 0,
  generated_at TIMESTAMPTZ,
  pdf_key TEXT,
  status VARCHAR(20) DEFAULT 'draft',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(staff_uid, financial_year)
);
CREATE INDEX IF NOT EXISTS idx_tax_summaries ON annual_tax_summaries(staff_uid, financial_year);

-- ══════════ §10. full_final_settlements ══════════
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
  hr_approved_at TIMESTAMPTZ,
  admin_approved_by UUID,
  admin_approved_at TIMESTAMPTZ,
  payment_date DATE,
  payment_reference TEXT,
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fnf_staff ON full_final_settlements(staff_uid);

-- ══════════ §11. investment_declarations ══════════
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
  submitted_at TIMESTAMPTZ,
  approved_by UUID,
  approved_at TIMESTAMPTZ,
  proof_submitted BOOLEAN DEFAULT FALSE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(staff_uid, financial_year)
);
CREATE INDEX IF NOT EXISTS idx_declarations_staff ON investment_declarations(staff_uid, financial_year);

-- ══════════ §12. leave_encashments ══════════
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
  approved_at TIMESTAMPTZ,
  status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ══════════ §13. payslip_queries ══════════
CREATE TABLE IF NOT EXISTS payslip_queries (
  id SERIAL PRIMARY KEY,
  payslip_id INTEGER REFERENCES payslips(id),
  staff_uid UUID NOT NULL,
  subject VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  category VARCHAR(30) DEFAULT 'general',
  status VARCHAR(20) DEFAULT 'open',
  resolved_by UUID,
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 027-era guards (the columns already exist in the CREATE TABLE above —
-- kept as ALTERs for DBs that got the older shape first).
ALTER TABLE payslip_queries
  ADD COLUMN IF NOT EXISTS resolved_by UUID,
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolution_note TEXT;

CREATE INDEX IF NOT EXISTS idx_pq_payslip ON payslip_queries(payslip_id);
CREATE INDEX IF NOT EXISTS idx_pq_staff ON payslip_queries(staff_uid);

-- ══════════ §14. payslip_query_replies ══════════
CREATE TABLE IF NOT EXISTS payslip_query_replies (
  id SERIAL PRIMARY KEY,
  query_id INTEGER REFERENCES payslip_queries(id),
  author_uid UUID NOT NULL,
  author_role VARCHAR(20) NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ══════════ §15. bulk_revision_jobs ══════════
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
  approved_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_log TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE bulk_revision_jobs
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
CREATE INDEX IF NOT EXISTS idx_bulk_rev ON bulk_revision_jobs(status);

-- ══════════ §16. users.pan_number ══════════
-- 010-era additive: Indian tax compliance references pan_number from
-- users. It's independent of the payroll tables but ported alongside
-- because the same legacy migration added it.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS pan_number VARCHAR(20);
