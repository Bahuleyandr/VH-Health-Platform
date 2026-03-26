-- 015_pharmacy_orders_enhanced.sql
-- Add lifecycle columns to pharmacy_orders

ALTER TABLE pharmacy_orders
  ADD COLUMN IF NOT EXISTS order_number VARCHAR(30) UNIQUE,
  ADD COLUMN IF NOT EXISTS patient_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS prescription_photo_key TEXT,
  ADD COLUMN IF NOT EXISTS prescription_photo_url TEXT,
  ADD COLUMN IF NOT EXISTS delivery_type VARCHAR(20) DEFAULT 'delivery',
  ADD COLUMN IF NOT EXISTS delivery_address TEXT,
  ADD COLUMN IF NOT EXISTS delivery_landmark TEXT,
  ADD COLUMN IF NOT EXISTS delivery_lat NUMERIC(10,7),
  ADD COLUMN IF NOT EXISTS delivery_lng NUMERIC(10,7),
  ADD COLUMN IF NOT EXISTS delivery_phone VARCHAR(20),
  ADD COLUMN IF NOT EXISTS confirmed_by INTEGER REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS confirmation_notes TEXT,
  ADD COLUMN IF NOT EXISTS items_list JSONB,
  ADD COLUMN IF NOT EXISTS preparing_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS dispatched_by INTEGER REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS delivery_person VARCHAR(255),
  ADD COLUMN IF NOT EXISTS delivery_person_phone VARCHAR(20),
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS delivery_otp VARCHAR(6),
  ADD COLUMN IF NOT EXISTS cancellation_reason TEXT,
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS patient_notified_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS sla_confirm_target TIMESTAMP,
  ADD COLUMN IF NOT EXISTS sla_dispatch_target TIMESTAMP,
  ADD COLUMN IF NOT EXISTS sla_delivery_target TIMESTAMP;

-- Order status history
CREATE TABLE IF NOT EXISTS pharmacy_order_history (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES pharmacy_orders(id) ON DELETE CASCADE,
  from_status VARCHAR(30),
  to_status VARCHAR(30) NOT NULL,
  changed_by INTEGER REFERENCES users(id),
  changed_by_role VARCHAR(30),
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Medicine catalog (admin-managed)
CREATE TABLE IF NOT EXISTS pharmacy_catalog (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  generic_name VARCHAR(255),
  category VARCHAR(100),
  manufacturer VARCHAR(255),
  unit_price NUMERIC(10,2),
  pack_size VARCHAR(50),
  requires_prescription BOOLEAN DEFAULT TRUE,
  in_stock BOOLEAN DEFAULT TRUE,
  stock_quantity INTEGER DEFAULT 0,
  reorder_level INTEGER DEFAULT 10,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Auto-number trigger for order_number
CREATE OR REPLACE FUNCTION generate_pharmacy_order_number()
RETURNS TRIGGER AS $$
DECLARE
  next_num INTEGER;
BEGIN
  SELECT COALESCE(MAX(CAST(SUBSTRING(order_number FROM 10) AS INTEGER)), 0) + 1
  INTO next_num
  FROM pharmacy_orders
  WHERE order_number LIKE 'PHR-' || EXTRACT(YEAR FROM NOW()) || '-%';
  
  NEW.order_number := 'PHR-' || EXTRACT(YEAR FROM NOW()) || '-' || LPAD(next_num::TEXT, 4, '0');
  NEW.sla_confirm_target := COALESCE(NEW.created_at, NOW()) + INTERVAL '15 minutes';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pharmacy_order_number ON pharmacy_orders;
CREATE TRIGGER trg_pharmacy_order_number
  BEFORE INSERT ON pharmacy_orders
  FOR EACH ROW
  WHEN (NEW.order_number IS NULL)
  EXECUTE FUNCTION generate_pharmacy_order_number();

-- Seed common medicines
INSERT INTO pharmacy_catalog (name, generic_name, category, unit_price, pack_size, requires_prescription) VALUES
  ('Dolo 650', 'Paracetamol 650mg', 'analgesics', 30.00, '15 tablets', false),
  ('Crocin Advance', 'Paracetamol 500mg', 'analgesics', 25.00, '15 tablets', false),
  ('Pan 40', 'Pantoprazole 40mg', 'antacids', 95.00, '15 tablets', true),
  ('Azithral 500', 'Azithromycin 500mg', 'antibiotics', 120.00, '3 tablets', true),
  ('Augmentin 625', 'Amoxicillin+Clavulanic', 'antibiotics', 210.00, '10 tablets', true),
  ('Shelcal 500', 'Calcium+Vitamin D3', 'vitamins', 155.00, '30 tablets', false),
  ('Ecosprin 75', 'Aspirin 75mg', 'cardiac', 18.00, '14 tablets', true),
  ('Metformin 500', 'Metformin 500mg', 'diabetes', 25.00, '20 tablets', true),
  ('Glycomet GP2', 'Glimepiride+Metformin', 'diabetes', 165.00, '15 tablets', true),
  ('Telma 40', 'Telmisartan 40mg', 'cardiac', 115.00, '15 tablets', true),
  ('Atorva 10', 'Atorvastatin 10mg', 'cardiac', 85.00, '15 tablets', true),
  ('Thyronorm 50', 'Levothyroxine 50mcg', 'hormones', 105.00, '120 tablets', true),
  ('Cetrizine 10mg', 'Cetirizine', 'antihistamines', 20.00, '10 tablets', false),
  ('Montair LC', 'Montelukast+Levocetirizine', 'respiratory', 185.00, '15 tablets', true),
  ('ORS Sachet', 'Oral Rehydration Salts', 'general', 15.00, '1 sachet', false)
ON CONFLICT DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_pharm_orders_status ON pharmacy_orders(status);
CREATE INDEX IF NOT EXISTS idx_pharm_orders_patient ON pharmacy_orders(patient_id);
CREATE INDEX IF NOT EXISTS idx_pharm_order_hist ON pharmacy_order_history(order_id);
CREATE INDEX IF NOT EXISTS idx_pharm_catalog_cat ON pharmacy_catalog(category);
