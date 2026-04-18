-- E-Prescription table (structured prescription from consultation)
CREATE TABLE IF NOT EXISTS e_prescriptions (
  id SERIAL PRIMARY KEY,
  prescription_number VARCHAR(30) UNIQUE,  -- auto: RX-2026-XXXX
  appointment_id INTEGER REFERENCES appointments(id),
  patient_id INTEGER REFERENCES users(id),
  doctor_id INTEGER REFERENCES users(id),
  
  -- Diagnosis
  diagnosis TEXT,
  clinical_notes TEXT,
  
  -- Medications (JSONB array)
  medications JSONB NOT NULL DEFAULT '[]',
  
  -- Follow-up
  follow_up_date DATE,
  follow_up_notes TEXT,
  
  -- Vitals at time of consultation (optional)
  vitals JSONB,
  
  -- Photo of handwritten prescription (original)
  handwritten_photo_key TEXT,
  
  -- Generated PDF
  pdf_key TEXT,
  
  -- Pharmacy link
  pharmacy_order_id INTEGER REFERENCES pharmacy_orders(id),
  pharmacy_opted BOOLEAN DEFAULT FALSE,
  pharmacy_opt_type VARCHAR(20),
  
  -- Status
  status VARCHAR(20) DEFAULT 'created',
  
  -- Metadata
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Auto-number trigger
CREATE OR REPLACE FUNCTION generate_rx_number()
RETURNS TRIGGER AS $$
DECLARE
  next_num INTEGER;
BEGIN
  SELECT COALESCE(MAX(CAST(SUBSTRING(prescription_number FROM 9) AS INTEGER)), 0) + 1
  INTO next_num
  FROM e_prescriptions
  WHERE prescription_number LIKE 'RX-' || EXTRACT(YEAR FROM NOW()) || '-%';
  
  NEW.prescription_number := 'RX-' || EXTRACT(YEAR FROM NOW()) || '-' || LPAD(next_num::TEXT, 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_rx_number ON e_prescriptions;
CREATE TRIGGER trg_rx_number
  BEFORE INSERT ON e_prescriptions
  FOR EACH ROW
  WHEN (NEW.prescription_number IS NULL)
  EXECUTE FUNCTION generate_rx_number();

CREATE INDEX IF NOT EXISTS idx_eprescription_patient ON e_prescriptions(patient_id);
CREATE INDEX IF NOT EXISTS idx_eprescription_doctor ON e_prescriptions(doctor_id);
CREATE INDEX IF NOT EXISTS idx_eprescription_appointment ON e_prescriptions(appointment_id);

-- Add unique constraint on pharmacy_catalog name for ON CONFLICT
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='idx_pharmacy_catalog_name') THEN
    CREATE UNIQUE INDEX idx_pharmacy_catalog_name ON pharmacy_catalog(name);
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

INSERT INTO pharmacy_catalog (name, generic_name, category, unit_price, pack_size, requires_prescription, in_stock, stock_quantity) VALUES
  -- ANTIBIOTICS
  ('Amoxicillin 500mg', 'Amoxicillin', 'antibiotics', 45.00, '10 capsules', true, true, 200),
  ('Azithral 500', 'Azithromycin 500mg', 'antibiotics', 120.00, '3 tablets', true, true, 150),
  ('Augmentin 625', 'Amoxicillin+Clavulanic Acid', 'antibiotics', 210.00, '10 tablets', true, true, 100),
  ('Cifran 500', 'Ciprofloxacin 500mg', 'antibiotics', 65.00, '10 tablets', true, true, 120),
  ('Cefixime 200', 'Cefixime 200mg', 'antibiotics', 95.00, '10 tablets', true, true, 100),
  ('Doxycycline 100', 'Doxycycline 100mg', 'antibiotics', 55.00, '10 capsules', true, true, 100),
  ('Metrogyl 400', 'Metronidazole 400mg', 'antibiotics', 25.00, '15 tablets', true, true, 200),
  ('Levoflox 500', 'Levofloxacin 500mg', 'antibiotics', 85.00, '10 tablets', true, true, 80),
  ('Clindamycin 300', 'Clindamycin 300mg', 'antibiotics', 120.00, '10 capsules', true, true, 60),
  ('Norflox 400', 'Norfloxacin 400mg', 'antibiotics', 35.00, '10 tablets', true, true, 100),
  -- ANALGESICS
  ('Dolo 650', 'Paracetamol 650mg', 'analgesics', 30.00, '15 tablets', false, true, 500),
  ('Crocin Advance', 'Paracetamol 500mg', 'analgesics', 25.00, '15 tablets', false, true, 400),
  ('Combiflam', 'Ibuprofen+Paracetamol', 'analgesics', 35.00, '20 tablets', false, true, 300),
  ('Voveran SR 100', 'Diclofenac 100mg', 'analgesics', 55.00, '10 tablets', true, true, 150),
  ('Brufenol 400', 'Ibuprofen 400mg', 'analgesics', 25.00, '10 tablets', false, true, 200),
  ('Ultracet', 'Tramadol+Paracetamol', 'analgesics', 95.00, '10 tablets', true, true, 80),
  ('Flexon MR', 'Ibuprofen+Paracetamol+Chlorzoxazone', 'analgesics', 65.00, '10 tablets', true, true, 100),
  ('Hifenac P', 'Aceclofenac+Paracetamol', 'analgesics', 55.00, '10 tablets', true, true, 120),
  ('Nimesulide 100', 'Nimesulide 100mg', 'analgesics', 20.00, '10 tablets', true, true, 150),
  ('Zerodol SP', 'Aceclofenac+Paracetamol+Serratiopeptidase', 'analgesics', 85.00, '10 tablets', true, true, 80),
  -- CARDIAC
  ('Ecosprin 75', 'Aspirin 75mg', 'cardiac', 18.00, '14 tablets', true, true, 300),
  ('Ecosprin AV 75/10', 'Aspirin+Atorvastatin', 'cardiac', 85.00, '10 capsules', true, true, 100),
  ('Atorva 10', 'Atorvastatin 10mg', 'cardiac', 85.00, '15 tablets', true, true, 200),
  ('Atorva 20', 'Atorvastatin 20mg', 'cardiac', 135.00, '15 tablets', true, true, 150),
  ('Telma 40', 'Telmisartan 40mg', 'cardiac', 115.00, '15 tablets', true, true, 200),
  ('Telma H', 'Telmisartan+Hydrochlorothiazide', 'cardiac', 145.00, '15 tablets', true, true, 100),
  ('Amlodac 5', 'Amlodipine 5mg', 'cardiac', 40.00, '15 tablets', true, true, 200),
  ('Amlodac 10', 'Amlodipine 10mg', 'cardiac', 65.00, '15 tablets', true, true, 100),
  ('Concor 5', 'Bisoprolol 5mg', 'cardiac', 95.00, '14 tablets', true, true, 80),
  ('Ramistar 5', 'Ramipril 5mg', 'cardiac', 75.00, '15 tablets', true, true, 100),
  ('Clopitab 75', 'Clopidogrel 75mg', 'cardiac', 45.00, '10 tablets', true, true, 150),
  ('Sorbitrate 5', 'Isosorbide Dinitrate 5mg', 'cardiac', 15.00, '50 tablets', true, true, 100),
  ('Nicardia Retard', 'Nifedipine 20mg', 'cardiac', 35.00, '20 tablets', true, true, 80),
  ('Dilzem 30', 'Diltiazem 30mg', 'cardiac', 25.00, '10 tablets', true, true, 60),
  ('Rosuvas 10', 'Rosuvastatin 10mg', 'cardiac', 155.00, '15 tablets', true, true, 100),
  -- DIABETES
  ('Metformin 500', 'Metformin 500mg', 'diabetes', 25.00, '20 tablets', true, true, 300),
  ('Metformin 1000', 'Metformin 1000mg', 'diabetes', 45.00, '15 tablets', true, true, 200),
  ('Glycomet GP2', 'Glimepiride 2mg+Metformin 500mg', 'diabetes', 165.00, '15 tablets', true, true, 150),
  ('Glycomet GP1', 'Glimepiride 1mg+Metformin 500mg', 'diabetes', 125.00, '15 tablets', true, true, 150),
  ('Amaryl 1', 'Glimepiride 1mg', 'diabetes', 55.00, '15 tablets', true, true, 100),
  ('Amaryl 2', 'Glimepiride 2mg', 'diabetes', 95.00, '15 tablets', true, true, 100),
  ('Januvia 100', 'Sitagliptin 100mg', 'diabetes', 450.00, '7 tablets', true, true, 50),
  ('Galvus Met 50/500', 'Vildagliptin+Metformin', 'diabetes', 380.00, '10 tablets', true, true, 60),
  ('Jardiance 10', 'Empagliflozin 10mg', 'diabetes', 520.00, '10 tablets', true, true, 40),
  ('Insulin Mixtard 30', 'Human Insulin 30/70', 'diabetes', 185.00, '1 vial', true, true, 30),
  ('Insulin Lantus', 'Insulin Glargine', 'diabetes', 950.00, '1 pen', true, true, 20),
  -- GASTRO
  ('Pan 40', 'Pantoprazole 40mg', 'gastro', 95.00, '15 tablets', true, true, 300),
  ('Pan D', 'Pantoprazole+Domperidone', 'gastro', 125.00, '15 capsules', true, true, 200),
  ('Rantac 150', 'Ranitidine 150mg', 'gastro', 25.00, '20 tablets', false, true, 200),
  ('Mucaine Gel', 'Aluminium Hydroxide+Magnesium+Oxetacaine', 'gastro', 95.00, '200ml', false, true, 100),
  ('Gelusil MPS', 'Antacid Suspension', 'gastro', 85.00, '200ml', false, true, 100),
  ('Librax', 'Chlordiazepoxide+Clidinium', 'gastro', 35.00, '10 capsules', true, true, 80),
  ('Duphalac', 'Lactulose', 'gastro', 145.00, '200ml', false, true, 60),
  ('Cremaffin Plus', 'Liquid Paraffin+Milk of Magnesia', 'gastro', 135.00, '225ml', false, true, 80),
  ('Nexpro 40', 'Esomeprazole 40mg', 'gastro', 145.00, '15 tablets', true, true, 100),
  ('Ondansetron 4', 'Ondansetron 4mg', 'gastro', 25.00, '10 tablets', true, true, 150),
  -- VITAMINS
  ('Shelcal 500', 'Calcium+Vitamin D3', 'vitamins', 155.00, '30 tablets', false, true, 200),
  ('Becosules Capsules', 'B-Complex+Vitamin C', 'vitamins', 35.00, '20 capsules', false, true, 300),
  ('Zincovit', 'Multivitamin+Multimineral', 'vitamins', 95.00, '15 tablets', false, true, 200),
  ('Limcee 500', 'Vitamin C 500mg', 'vitamins', 20.00, '15 tablets', false, true, 300),
  ('Evion 400', 'Vitamin E 400mg', 'vitamins', 55.00, '10 capsules', false, true, 150),
  ('Calcirol D3', 'Cholecalciferol 60000IU', 'vitamins', 30.00, '4 sachets', true, true, 100),
  ('Folvite 5', 'Folic Acid 5mg', 'vitamins', 10.00, '30 tablets', false, true, 200),
  ('Feronia XT', 'Iron+Folic Acid+Zinc', 'vitamins', 95.00, '10 tablets', false, true, 150),
  ('Neurobion Forte', 'Vitamin B1+B6+B12', 'vitamins', 35.00, '30 tablets', false, true, 200),
  ('Supradyn', 'Multivitamin+Multimineral', 'vitamins', 125.00, '15 tablets', false, true, 100),
  -- RESPIRATORY
  ('Montair LC', 'Montelukast+Levocetirizine', 'respiratory', 185.00, '15 tablets', true, true, 100),
  ('Asthalin Inhaler', 'Salbutamol 100mcg', 'respiratory', 115.00, '1 inhaler', true, true, 60),
  ('Budecort 200', 'Budesonide 200mcg Inhaler', 'respiratory', 235.00, '1 inhaler', true, true, 40),
  ('Seroflo 250', 'Salmeterol+Fluticasone', 'respiratory', 395.00, '1 inhaler', true, true, 30),
  ('Deriphyllin Retard 150', 'Theophylline 150mg', 'respiratory', 25.00, '15 tablets', true, true, 100),
  ('Mucinac 600', 'Acetylcysteine 600mg', 'respiratory', 95.00, '10 tablets', false, true, 100),
  ('Alex Cough Syrup', 'Dextromethorphan+CPM', 'respiratory', 65.00, '100ml', false, true, 80),
  ('Grilinctus BM', 'Bromhexine+Terbutaline+Guaifenesin', 'respiratory', 75.00, '100ml', true, true, 60),
  ('Foracort 200', 'Formoterol+Budesonide', 'respiratory', 350.00, '1 inhaler', true, true, 30),
  ('Tiotropium 18', 'Tiotropium 18mcg', 'respiratory', 280.00, '15 capsules', true, true, 40),
  -- ANTIHISTAMINES
  ('Cetrizine 10mg', 'Cetirizine 10mg', 'antihistamines', 20.00, '10 tablets', false, true, 300),
  ('Allegra 120', 'Fexofenadine 120mg', 'antihistamines', 95.00, '10 tablets', false, true, 150),
  ('Avil 25', 'Pheniramine 25mg', 'antihistamines', 10.00, '10 tablets', false, true, 200),
  ('Levocet 5', 'Levocetirizine 5mg', 'antihistamines', 35.00, '10 tablets', false, true, 200),
  ('Montair 10', 'Montelukast 10mg', 'antihistamines', 145.00, '15 tablets', true, true, 80),
  -- ANTIFUNGALS
  ('Fluconazole 150', 'Fluconazole 150mg', 'antifungals', 25.00, '1 tablet', true, true, 100),
  ('Itraconazole 100', 'Itraconazole 100mg', 'antifungals', 95.00, '4 capsules', true, true, 60),
  ('Candid Cream', 'Clotrimazole 1%', 'antifungals', 55.00, '15g tube', false, true, 80),
  ('Terbinafine 250', 'Terbinafine 250mg', 'antifungals', 85.00, '14 tablets', true, true, 60),
  -- HORMONES / THYROID
  ('Thyronorm 25', 'Levothyroxine 25mcg', 'hormones', 85.00, '120 tablets', true, true, 100),
  ('Thyronorm 50', 'Levothyroxine 50mcg', 'hormones', 105.00, '120 tablets', true, true, 100),
  ('Thyronorm 75', 'Levothyroxine 75mcg', 'hormones', 115.00, '120 tablets', true, true, 80),
  ('Thyronorm 100', 'Levothyroxine 100mcg', 'hormones', 125.00, '120 tablets', true, true, 60),
  ('Eltroxin 50', 'Levothyroxine 50mcg', 'hormones', 95.00, '100 tablets', true, true, 50),
  -- DERMATOLOGY
  ('Betnovate C Cream', 'Betamethasone+Clioquinol', 'dermatology', 45.00, '20g tube', true, true, 80),
  ('Clobetasol Cream', 'Clobetasol 0.05%', 'dermatology', 55.00, '15g tube', true, true, 60),
  ('Panderm Cream', 'Clobetasol+Neomycin+Miconazole', 'dermatology', 75.00, '15g tube', true, true, 60),
  ('Momate Cream', 'Mometasone 0.1%', 'dermatology', 85.00, '15g tube', true, true, 50),
  ('Candid B Cream', 'Clotrimazole+Beclomethasone', 'dermatology', 65.00, '15g tube', true, true, 80),
  ('Soframycin Cream', 'Framycetin', 'dermatology', 55.00, '30g tube', false, true, 100),
  ('Retino A 0.025%', 'Tretinoin 0.025%', 'dermatology', 95.00, '20g tube', true, true, 40),
  -- NEUROLOGICAL
  ('Nexito 10', 'Escitalopram 10mg', 'neurological', 95.00, '10 tablets', true, true, 60),
  ('Oleanz 5', 'Olanzapine 5mg', 'neurological', 55.00, '10 tablets', true, true, 40),
  ('Eptoin 100', 'Phenytoin 100mg', 'neurological', 15.00, '10 tablets', true, true, 80),
  ('Frisium 10', 'Clobazam 10mg', 'neurological', 45.00, '10 tablets', true, true, 40),
  ('Gabapin NT', 'Gabapentin+Nortriptyline', 'neurological', 135.00, '10 tablets', true, true, 50),
  ('Lonazep 0.5', 'Clonazepam 0.5mg', 'neurological', 25.00, '10 tablets', true, true, 60),
  ('Amitriptyline 10', 'Amitriptyline 10mg', 'neurological', 15.00, '10 tablets', true, true, 80),
  ('Vertin 16', 'Betahistine 16mg', 'neurological', 95.00, '15 tablets', true, true, 60),
  -- MUSCULOSKELETAL
  ('Voveran Gel', 'Diclofenac Gel', 'musculoskeletal', 65.00, '30g tube', false, true, 100),
  ('Myospaz Forte', 'Chlorzoxazone+Paracetamol', 'musculoskeletal', 45.00, '10 tablets', true, true, 100),
  ('Thiocolchicoside 4', 'Thiocolchicoside 4mg', 'musculoskeletal', 55.00, '10 capsules', true, true, 80),
  ('Volini Gel', 'Diclofenac+Linseed Oil+Methyl Salicylate', 'musculoskeletal', 95.00, '30g tube', false, true, 150),
  -- UROLOGY
  ('Urimax 0.4', 'Tamsulosin 0.4mg', 'urology', 105.00, '15 capsules', true, true, 60),
  ('Silodal 8', 'Silodosin 8mg', 'urology', 195.00, '10 capsules', true, true, 40),
  ('Dytor 10', 'Torasemide 10mg', 'urology', 45.00, '15 tablets', true, true, 80),
  -- GENERAL / OTC
  ('ORS Sachet', 'Oral Rehydration Salts', 'general', 15.00, '1 sachet', false, true, 500),
  ('Betadine Solution', 'Povidone Iodine', 'general', 55.00, '100ml', false, true, 100),
  ('Dettol Antiseptic', 'Chloroxylenol', 'general', 45.00, '60ml', false, true, 100),
  ('Band-Aid (box)', 'Adhesive Bandage', 'general', 35.00, '10 strips', false, true, 200),
  ('Cotton Roll', 'Absorbent Cotton', 'general', 25.00, '100g', false, true, 150),
  ('Vicks Vaporub', 'Menthol+Camphor+Eucalyptus', 'general', 95.00, '50g', false, true, 100),
  ('Strepsils', 'Amylmetacresol+Dichlorobenzyl', 'general', 45.00, '8 lozenges', false, true, 200),
  ('Electral Powder', 'ORS Flavoured', 'general', 20.00, '4 sachets', false, true, 300),
  -- EYE / ENT
  ('Moxifloxacin Eye Drops', 'Moxifloxacin 0.5%', 'eye_ent', 65.00, '5ml', true, true, 80),
  ('Tobramycin Eye Drops', 'Tobramycin 0.3%', 'eye_ent', 55.00, '5ml', true, true, 60),
  ('Otrivin Nasal Spray', 'Xylometazoline', 'eye_ent', 75.00, '10ml', false, true, 80),
  ('Nasivion Drops', 'Oxymetazoline', 'eye_ent', 65.00, '10ml', false, true, 60),
  ('Refresh Tears', 'Carboxymethylcellulose', 'eye_ent', 95.00, '10ml', false, true, 100)
ON CONFLICT (name) DO NOTHING;
