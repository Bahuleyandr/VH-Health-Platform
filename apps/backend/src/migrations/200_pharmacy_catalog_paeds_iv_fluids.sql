-- 200_pharmacy_catalog_paeds_iv_fluids.sql
--
-- Wave-3 batch-1 — pharmacy catalog seed. Closes:
--   2026-05-09-pediatric-opd-pharmacy-paed-syrup-missing-catalog
--   2026-05-10-inpatient-admission-pharmacy-pantoprazole-injection-missing-catalog
--   2026-05-10-inpatient-admission-pharmacy-normal-saline-missing-catalog
--
-- The original seed in 191_seed_essentials.sql only carries adult tablet
-- formulations of these molecules. IPD IV-fluid orders and paediatric OPD
-- syrup orders have no matching catalog row, so:
--   (a) the order-from-prescription path can't price the line item, and
--   (b) the stock-decrement loop in markCounterDispensed/markDelivered
--       has nothing to UPDATE.
--
-- Idempotent: every INSERT guards with `WHERE NOT EXISTS` on LOWER(name).

BEGIN;

INSERT INTO pharmacy_catalog
  (name, generic_name, category, unit_price, price, pack_size,
   requires_prescription, in_stock, is_active, is_available,
   stock_quantity, stock, reorder_level, description)
SELECT v.name, v.gen, v.cat, v.price, v.price, v.pack,
       v.rx, true, true, true,
       v.qty, v.qty, v.reorder, v.descr
FROM (VALUES
  -- Paediatric oral formulations. 60 ml is the standard local pack;
  -- 187.5 mg per 7.5 ml is the typical paediatric dose for a 12.5 kg
  -- child at 15 mg/kg, so the pharmacist can dispense whole bottles.
  ('Paracetamol Syrup 125mg/5ml',    'Paracetamol',  'analgesic',         35.0, '60 ml bottle',  false, 100, 20, 'Paediatric antipyretic; 10-15 mg/kg per dose, max 4 doses/day'),
  ('Paracetamol Drops 100mg/ml',     'Paracetamol',  'analgesic',         30.0, '15 ml bottle',  false, 60,  15, 'Infant antipyretic; weight-based dosing'),
  ('Ibuprofen Syrup 100mg/5ml',      'Ibuprofen',    'analgesic',         55.0, '60 ml bottle',  true,  60,  15, 'Paediatric NSAID; 5-10 mg/kg per dose'),
  ('Amoxicillin Syrup 125mg/5ml',    'Amoxicillin',  'antibiotic',        65.0, '60 ml bottle',  true,  40,  10, 'Paediatric antibiotic; 20-40 mg/kg/day divided'),
  ('Cefixime Syrup 100mg/5ml',       'Cefixime',     'antibiotic',        90.0, '30 ml bottle',  true,  40,  10, 'Paediatric oral cephalosporin'),
  ('Ondansetron Syrup 2mg/5ml',      'Ondansetron',  'antiemetic',        85.0, '30 ml bottle',  true,  40,  10, 'Paediatric antiemetic; 0.1-0.15 mg/kg per dose'),
  ('Cetirizine Syrup 5mg/5ml',       'Cetirizine',   'antihistamine',     45.0, '60 ml bottle',  false, 60,  15, 'Paediatric antihistamine'),

  -- Injectable formulations for IPD. Stocked per vial.
  ('Pantoprazole 40mg Injection',    'Pantoprazole', 'ppi',               45.0, '1 vial',        true,  80,  20, 'IV PPI; stress-ulcer prophylaxis / acute GI bleed'),
  ('Ondansetron 4mg Injection',      'Ondansetron',  'antiemetic',        15.0, '1 ampoule',     true,  80,  20, 'IV antiemetic; pre-op / chemotherapy'),
  ('Paracetamol 1g Injection',       'Paracetamol',  'analgesic',         55.0, '100 ml vial',   true,  60,  20, 'IV antipyretic / analgesic'),
  ('Diclofenac 75mg Injection',      'Diclofenac',   'analgesic',         12.0, '3 ml ampoule',  true,  60,  20, 'IM/IV NSAID'),
  ('Tramadol 100mg Injection',       'Tramadol',     'analgesic',         18.0, '2 ml ampoule',  true,  60,  20, 'Opioid analgesic; moderate-severe pain'),

  -- IV fluids. 1 L bag is the standard issue unit.
  ('Normal Saline 0.9% 500ml',       'Sodium Chloride 0.9%',   'iv_fluid', 35.0,  '500 ml bag',   false, 200, 50, 'Isotonic crystalloid'),
  ('Normal Saline 0.9% 1000ml',      'Sodium Chloride 0.9%',   'iv_fluid', 55.0,  '1 L bag',      false, 200, 50, 'Isotonic crystalloid; maintenance + resuscitation'),
  ('Ringer Lactate 500ml',           'Compound Sodium Lactate','iv_fluid', 40.0,  '500 ml bag',   false, 200, 50, 'Balanced crystalloid'),
  ('Ringer Lactate 1000ml',          'Compound Sodium Lactate','iv_fluid', 60.0,  '1 L bag',      false, 200, 50, 'Balanced crystalloid; trauma / surgery'),
  ('Dextrose 5% 500ml',              'Dextrose 5% in water',   'iv_fluid', 35.0,  '500 ml bag',   false, 120, 30, 'Maintenance hydration; hypoglycaemia carrier'),
  ('DNS 500ml',                      'Dextrose-Normal Saline', 'iv_fluid', 40.0,  '500 ml bag',   false, 120, 30, 'Dextrose + saline; paediatric / post-op'),
  ('Sterile Water for Injection',    'Water for Injection',    'iv_fluid', 8.0,   '10 ml ampoule',false, 200, 50, 'Diluent for injectables')
) AS v(name, gen, cat, price, pack, rx, qty, reorder, descr)
WHERE NOT EXISTS (
  SELECT 1 FROM pharmacy_catalog pc WHERE LOWER(pc.name) = LOWER(v.name)
);

COMMIT;
