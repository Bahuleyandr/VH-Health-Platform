-- 001_create_beds_wards.sql
CREATE TABLE IF NOT EXISTS wards (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  floor INTEGER DEFAULT 1,
  department_id INTEGER REFERENCES departments(id),
  total_beds INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS beds (
  id SERIAL PRIMARY KEY,
  ward_id INTEGER REFERENCES wards(id) ON DELETE CASCADE,
  bed_number VARCHAR(20) NOT NULL,
  status VARCHAR(20) DEFAULT 'available' CHECK (status IN ('available', 'occupied', 'reserved', 'maintenance')),
  patient_id INTEGER REFERENCES users(id),
  patient_name VARCHAR(100),
  admitted_at TIMESTAMP,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_beds_ward_id ON beds(ward_id);
CREATE INDEX IF NOT EXISTS idx_beds_status ON beds(status);
CREATE INDEX IF NOT EXISTS idx_beds_patient_id ON beds(patient_id);
