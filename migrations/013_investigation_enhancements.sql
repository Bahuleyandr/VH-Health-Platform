ALTER TABLE investigations
  ADD COLUMN IF NOT EXISTS turnaround_target_hours INTEGER DEFAULT 24,
  ADD COLUMN IF NOT EXISTS result_uploaded_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS urgent_alert_sent BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS patient_notified_at TIMESTAMP;

ALTER TABLE investigation_files
  ADD COLUMN IF NOT EXISTS uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS is_result BOOLEAN DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS investigation_test_catalog (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  code VARCHAR(50),
  category VARCHAR(100),
  description TEXT,
  normal_range TEXT,
  unit VARCHAR(50),
  default_cost NUMERIC(10,2),
  turnaround_hours INTEGER DEFAULT 24,
  requires_fasting BOOLEAN DEFAULT FALSE,
  patient_instructions TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO investigation_test_catalog (name, code, category, default_cost, turnaround_hours) VALUES
  ('CBC (Complete Blood Count)', 'CBC', 'blood', 150.00, 4),
  ('Lipid Panel', 'LIPID', 'blood', 350.00, 4),
  ('HbA1c', 'HBA1C', 'blood', 400.00, 8),
  ('Thyroid Profile (T3, T4, TSH)', 'THYROID', 'blood', 650.00, 8),
  ('Liver Function Test (LFT)', 'LFT', 'blood', 500.00, 4),
  ('Kidney Function Test (KFT)', 'KFT', 'blood', 400.00, 4),
  ('Blood Glucose (Fasting)', 'FBS', 'blood', 60.00, 2),
  ('Blood Glucose (Post-prandial)', 'PPBS', 'blood', 60.00, 2),
  ('Urine Routine & Microscopy', 'URINE_RM', 'urine', 100.00, 2),
  ('Urine Culture & Sensitivity', 'URINE_CS', 'urine', 400.00, 48),
  ('X-Ray Chest PA', 'XRAY_CHEST', 'radiology', 300.00, 2),
  ('X-Ray (Other)', 'XRAY_OTHER', 'radiology', 250.00, 2),
  ('CT Scan Brain', 'CT_BRAIN', 'radiology', 3500.00, 4),
  ('CT Scan Abdomen', 'CT_ABD', 'radiology', 4000.00, 4),
  ('MRI Brain', 'MRI_BRAIN', 'radiology', 6000.00, 8),
  ('Ultrasound Abdomen', 'USG_ABD', 'radiology', 800.00, 2),
  ('ECG (12-Lead)', 'ECG', 'cardiac', 200.00, 1),
  ('Echocardiogram', 'ECHO', 'cardiac', 2500.00, 4),
  ('Sputum Culture', 'SPUTUM', 'microbiology', 500.00, 72),
  ('Blood Culture', 'BLOOD_CS', 'microbiology', 600.00, 72),
  ('COVID-19 Antigen', 'COVID_AG', 'blood', 300.00, 1),
  ('COVID-19 PCR', 'COVID_PCR', 'blood', 700.00, 6),
  ('Biopsy (FNAC)', 'FNAC', 'pathology', 1200.00, 24),
  ('Pap Smear', 'PAP', 'pathology', 500.00, 24)
ON CONFLICT DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_inv_status ON investigations(status);
CREATE INDEX IF NOT EXISTS idx_inv_priority ON investigations(priority);
CREATE INDEX IF NOT EXISTS idx_inv_patient ON investigations(patient_id);
