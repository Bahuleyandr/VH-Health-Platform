-- Compatibility table for /api/v1/pharmacy/catalog.
-- The pharmacy catalog controller uses this table directly; without it the
-- staff/admin pharmacy catalog route 500s on a clean migrated database.

CREATE TABLE IF NOT EXISTS pharmacy_catalog (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  generic_name VARCHAR(255),
  category VARCHAR(100) DEFAULT 'other',
  manufacturer VARCHAR(255),
  unit_price NUMERIC(12,2),
  price NUMERIC(12,2) DEFAULT 0,
  pack_size VARCHAR(100),
  requires_prescription BOOLEAN DEFAULT TRUE,
  in_stock BOOLEAN DEFAULT TRUE,
  is_active BOOLEAN DEFAULT TRUE,
  is_available BOOLEAN DEFAULT TRUE,
  stock_quantity INTEGER DEFAULT 0,
  stock INTEGER DEFAULT 0,
  reorder_level INTEGER DEFAULT 10,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE pharmacy_catalog
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;

UPDATE pharmacy_catalog
SET is_active = TRUE
WHERE is_active IS NULL;

CREATE INDEX IF NOT EXISTS idx_pharmacy_catalog_active
  ON pharmacy_catalog(is_active, is_available, in_stock);

CREATE INDEX IF NOT EXISTS idx_pharmacy_catalog_category
  ON pharmacy_catalog(category);

INSERT INTO pharmacy_catalog
  (name, generic_name, category, manufacturer, unit_price, price, pack_size,
   requires_prescription, in_stock, is_active, is_available, stock_quantity, stock,
   reorder_level, description)
SELECT *
FROM (
  VALUES
    ('Paracetamol 500mg', 'Paracetamol', 'analgesic', 'Seed Pharma', 12.00::NUMERIC, 12.00::NUMERIC,
     '10 tablets', FALSE, TRUE, TRUE, TRUE, 500, 500, 50, 'Seed fever and pain medication'),
    ('Amlodipine 5mg', 'Amlodipine', 'cardiology', 'Seed Pharma', 18.00::NUMERIC, 18.00::NUMERIC,
     '10 tablets', TRUE, TRUE, TRUE, TRUE, 250, 250, 25, 'Seed antihypertensive medication')
) AS seed
  (name, generic_name, category, manufacturer, unit_price, price, pack_size,
   requires_prescription, in_stock, is_active, is_available, stock_quantity, stock,
   reorder_level, description)
WHERE NOT EXISTS (
  SELECT 1
  FROM pharmacy_catalog existing
  WHERE existing.name = seed.name
);
