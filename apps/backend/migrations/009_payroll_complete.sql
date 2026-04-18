-- Salary advances / loans
CREATE TABLE IF NOT EXISTS salary_advances (
  id SERIAL PRIMARY KEY,
  staff_uid UUID REFERENCES users(uid),
  amount NUMERIC(12,2) NOT NULL,
  reason TEXT NOT NULL,
  approved_by UUID REFERENCES users(uid),
  approved_at TIMESTAMP,
  status VARCHAR(20) DEFAULT 'pending',
  monthly_deduction NUMERIC(10,2) NOT NULL,
  total_deducted NUMERIC(12,2) DEFAULT 0,
  months_remaining INTEGER,
  deduction_start_month INTEGER,
  deduction_start_year INTEGER,
  fully_cleared_at TIMESTAMP,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Track per-payslip advance deductions
CREATE TABLE IF NOT EXISTS advance_deductions (
  id SERIAL PRIMARY KEY,
  advance_id INTEGER REFERENCES salary_advances(id),
  payslip_id INTEGER REFERENCES payslips(id),
  staff_uid UUID,
  month INTEGER,
  year INTEGER,
  amount_deducted NUMERIC(10,2),
  balance_after NUMERIC(12,2),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Arrears records
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
  calculated_at TIMESTAMP DEFAULT NOW()
);

-- Annual tax summary (Form 16 basis)
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
  generated_at TIMESTAMP,
  pdf_key TEXT,
  status VARCHAR(20) DEFAULT 'draft',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(staff_uid, financial_year)
);

-- Add LOP and arrears columns to payslips
ALTER TABLE payslips
  ADD COLUMN IF NOT EXISTS lop_days NUMERIC(5,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lop_deduction NUMERIC(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS arrears_amount NUMERIC(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS advance_deduction NUMERIC(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS revision_note TEXT;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_advances_staff ON salary_advances(staff_uid);
CREATE INDEX IF NOT EXISTS idx_arrears_staff ON salary_arrears(staff_uid);
CREATE INDEX IF NOT EXISTS idx_tax_summaries ON annual_tax_summaries(staff_uid, financial_year);
