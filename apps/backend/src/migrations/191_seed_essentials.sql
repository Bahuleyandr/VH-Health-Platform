-- 191_seed_essentials.sql
--
-- E-13 — seed sweep. Closes:
--   2026-05-08-emergency-walk-in-admission-no-icu-bed-infrastructure
--   2026-05-08-inpatient-admission-pharmacy-empty-drug-master
--   2026-05-08-dynamic-acute-abdomen-admission-no-allocatable-beds
--
-- Idempotent: every INSERT uses WHERE NOT EXISTS so re-running leaves
-- already-seeded environments untouched.

BEGIN;

-- ── 1. ICU + CCU + semi-private + private + deluxe wards + beds ─────
INSERT INTO wards (name, floor, total_beds, attendant_pass_color, attendant_pass_screening_level)
SELECT v.name, v.floor, v.beds, v.color, v.screening
FROM (VALUES
  ('ICU',           3, 4, 'red',    'strict'),
  ('CCU',           3, 2, 'red',    'strict'),
  ('Semi-Private',  2, 8, 'green',  'standard'),
  ('Private',       2, 6, 'blue',   'standard'),
  ('Deluxe',        4, 4, 'gold',   'relaxed'),
  ('Day Care',      1, 6, 'yellow', 'standard')
) AS v(name, floor, beds, color, screening)
WHERE NOT EXISTS (SELECT 1 FROM wards w WHERE LOWER(w.name) = LOWER(v.name));

-- ── 2. Beds for each newly-seeded ward ──────────────────────────────
DO $$
DECLARE
  ward_rec RECORD;
  bed_count INTEGER;
  i INTEGER;
  prefix TEXT;
  bed_type_val TEXT;
BEGIN
  FOR ward_rec IN
    SELECT id, name, total_beds FROM wards
     WHERE LOWER(name) IN ('icu','ccu','semi-private','private','deluxe','day care')
  LOOP
    -- Count existing beds in this ward to skip if already seeded.
    SELECT COUNT(*) INTO bed_count FROM beds WHERE ward_id = ward_rec.id;
    IF bed_count > 0 THEN CONTINUE; END IF;

    -- Bed-number prefix and bed_type per ward.
    IF LOWER(ward_rec.name) = 'icu' THEN
      prefix := 'ICU'; bed_type_val := 'icu';
    ELSIF LOWER(ward_rec.name) = 'ccu' THEN
      prefix := 'CCU'; bed_type_val := 'icu';
    ELSIF LOWER(ward_rec.name) = 'semi-private' THEN
      prefix := 'SP'; bed_type_val := 'semi_private';
    ELSIF LOWER(ward_rec.name) = 'private' THEN
      prefix := 'PR'; bed_type_val := 'private';
    ELSIF LOWER(ward_rec.name) = 'deluxe' THEN
      prefix := 'DLX'; bed_type_val := 'deluxe';
    ELSE
      prefix := 'DC'; bed_type_val := 'day_care';
    END IF;

    FOR i IN 1..ward_rec.total_beds LOOP
      INSERT INTO beds (ward_id, ward_name, bed_number, status, bed_type, floor)
      VALUES (ward_rec.id, ward_rec.name,
              prefix || '-' || LPAD(i::text, 3, '0'),
              'available', bed_type_val, 1);
    END LOOP;
  END LOOP;
END $$;

-- ── 3. Pharmacy catalog — common drugs seed ─────────────────────────
INSERT INTO pharmacy_catalog
  (name, generic_name, category, unit_price, price, pack_size,
   requires_prescription, in_stock, is_active, is_available,
   stock_quantity, stock, reorder_level, description)
SELECT v.name, v.gen, v.cat, v.price, v.price, v.pack,
       v.rx, true, true, true,
       100, 100, 20, v.descr
FROM (VALUES
  ('Paracetamol 500mg',         'Paracetamol',           'analgesic',   2.5,  '10 tabs', false, 'Mild-moderate pain, fever'),
  ('Aspirin 75mg',              'Acetylsalicylic acid',  'antiplatelet',1.5,  '14 tabs', true,  'Antiplatelet; cardiac prophylaxis'),
  ('Aspirin 325mg',             'Acetylsalicylic acid',  'antiplatelet',2.0,  '10 tabs', true,  'STEMI loading dose'),
  ('Clopidogrel 75mg',          'Clopidogrel',           'antiplatelet',8.0,  '10 tabs', true,  'P2Y12 inhibitor; ACS'),
  ('Atorvastatin 20mg',         'Atorvastatin',          'statin',      4.0,  '10 tabs', true,  'Hyperlipidaemia'),
  ('Atorvastatin 40mg',         'Atorvastatin',          'statin',      6.0,  '10 tabs', true,  'High-intensity statin'),
  ('Amoxicillin 500mg',         'Amoxicillin',           'antibiotic',  5.0,  '10 caps', true,  'Beta-lactam; respiratory + dental'),
  ('Amoxicillin-Clavulanate 625', 'Amoxicillin+Clav',    'antibiotic', 12.0,  '10 tabs', true,  'Augmented; bacterial infections'),
  ('Azithromycin 500mg',        'Azithromycin',          'antibiotic',  9.0,  '5 tabs',  true,  'Macrolide; respiratory'),
  ('Ceftriaxone 1g IV',         'Ceftriaxone',           'antibiotic', 35.0,  '1 vial',  true,  '3rd gen cephalosporin; IV'),
  ('Metformin 500mg',           'Metformin',             'antidiabetic',1.5,  '10 tabs', true,  'Type 2 DM first-line'),
  ('Metformin 1000mg',          'Metformin',             'antidiabetic',2.5,  '10 tabs', true,  'Type 2 DM; titration'),
  ('Glimepiride 2mg',           'Glimepiride',           'antidiabetic',3.0,  '10 tabs', true,  'Sulfonylurea'),
  ('Insulin Regular 100IU/ml',  'Insulin (regular)',     'antidiabetic',150.0,'1 vial',  true,  'Short-acting insulin'),
  ('Insulin NPH 100IU/ml',      'Insulin (NPH)',         'antidiabetic',180.0,'1 vial',  true,  'Intermediate-acting'),
  ('Amlodipine 5mg',            'Amlodipine',            'antihypertensive',2.0,'10 tabs',true,'CCB'),
  ('Telmisartan 40mg',          'Telmisartan',           'antihypertensive',6.0,'10 tabs',true,'ARB'),
  ('Losartan 50mg',             'Losartan',              'antihypertensive',4.0,'10 tabs',true,'ARB'),
  ('Atenolol 50mg',             'Atenolol',              'antihypertensive',2.5,'10 tabs',true,'Beta-blocker'),
  ('Metoprolol 25mg',           'Metoprolol',            'antihypertensive',3.5,'10 tabs',true,'Cardioselective BB'),
  ('Furosemide 40mg',           'Furosemide',            'diuretic',    1.5,  '10 tabs', true,  'Loop diuretic'),
  ('Glyceryl Trinitrate 0.5mg SL','GTN',                 'cardiac',     10.0, '10 tabs', true,  'Sublingual; angina'),
  ('Heparin 5000IU IV',         'Heparin (UFH)',         'anticoagulant',45.0,'1 vial',  true,  'Anticoagulation'),
  ('Iron + Folic Acid',         'FeSO4+Folic acid',      'supplement',  1.0,  '10 tabs', false, 'Antenatal + anaemia'),
  ('Calcium 500mg + Vit D',     'Calcium carbonate+D3',  'supplement',  3.0,  '10 tabs', false, 'Antenatal + osteoporosis'),
  ('Vitamin B Complex',         'B-complex',             'supplement',  1.5,  '10 tabs', false, 'General supplementation'),
  ('Pantoprazole 40mg',         'Pantoprazole',          'ppi',         3.5,  '10 tabs', true,  'PPI; GERD'),
  ('Ondansetron 4mg',           'Ondansetron',           'antiemetic',  4.0,  '10 tabs', true,  'Anti-nausea'),
  ('Salbutamol Inhaler 100mcg', 'Salbutamol',            'bronchodilator',95.0,'1 inh',  true,  'Asthma rescue'),
  ('ORS Sachet',                'Oral Rehydration Salts','electrolyte', 8.0,  '1 sachet',false, 'Rehydration'),
  ('Diclofenac 50mg',           'Diclofenac',            'analgesic',   2.5,  '10 tabs', true,  'NSAID'),
  ('Ibuprofen 400mg',           'Ibuprofen',             'analgesic',   2.0,  '10 tabs', true,  'NSAID')
) AS v(name, gen, cat, price, pack, rx, descr)
WHERE NOT EXISTS (
  SELECT 1 FROM pharmacy_catalog pc WHERE LOWER(pc.name) = LOWER(v.name)
);

COMMIT;
