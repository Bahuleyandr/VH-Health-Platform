-- Migration 102: seed investigation_test_catalog with the 30 most
-- commonly-ordered diagnostic investigations at an Indian general
-- hospital. Pricing is roughly aligned to Chennai metro retail rates
-- (Apollo / Vijaya / private lab averages 2024-2026); customise for
-- prod tariffs when the hospital sets its own pricing.
--
-- Idempotent — `ON CONFLICT (code) DO NOTHING` so re-running is safe
-- and you can layer additional inserts in later migrations without
-- worrying about duplicate-key violations.
--
-- Categories used: HEMATOLOGY, BIOCHEMISTRY, ENDOCRINOLOGY,
-- CARDIOLOGY, MICROBIOLOGY, SEROLOGY, VITAMIN, PREGNANCY.

BEGIN;

INSERT INTO investigation_test_catalog
  (name, code, category, description, normal_range, unit, default_cost,
   home_collection_surcharge, turnaround_hours, requires_fasting,
   patient_instructions, sample_type, is_active)
VALUES
  -- ── Hematology ──────────────────────────────────────────────────
  ('Complete Blood Count', 'CBC', 'HEMATOLOGY',
   'Hemoglobin, RBC, WBC differential, platelet count and indices.',
   'Hb 12-17 g/dL, WBC 4-11k/μL, Plt 150-450k/μL', 'mixed', 250,
   50, 6, FALSE,
   'No special preparation required.', 'Whole blood (EDTA)', TRUE),

  ('Erythrocyte Sedimentation Rate', 'ESR', 'HEMATOLOGY',
   'Non-specific marker of inflammation.',
   '0-20 mm/hr (Westergren)', 'mm/hr', 100,
   50, 4, FALSE,
   'No special preparation required.', 'Whole blood (EDTA)', TRUE),

  ('Platelet Count', 'PLT', 'HEMATOLOGY',
   'Standalone platelet count, separate from CBC.',
   '150-450 × 10^3/μL', '× 10^3/μL', 120,
   50, 4, FALSE,
   'No special preparation.', 'Whole blood (EDTA)', TRUE),

  ('Peripheral Blood Smear', 'PBS', 'HEMATOLOGY',
   'Microscopic exam of blood film for cell morphology.',
   'Reported descriptively', 'qualitative', 300,
   50, 24, FALSE,
   'No special preparation.', 'Whole blood (EDTA)', TRUE),

  -- ── Biochemistry ───────────────────────────────────────────────
  ('Fasting Blood Sugar', 'FBS', 'BIOCHEMISTRY',
   'Plasma glucose after 8-12 hours of fasting.',
   '70-100 mg/dL (fasting)', 'mg/dL', 100,
   50, 4, TRUE,
   'Fast 8-12 hours; only water permitted. Take morning insulin AFTER sample.',
   'Plasma (fluoride)', TRUE),

  ('Postprandial Blood Sugar', 'PPBS', 'BIOCHEMISTRY',
   'Plasma glucose 2 hours after a meal.',
   '< 140 mg/dL (2-hr postprandial)', 'mg/dL', 100,
   50, 4, FALSE,
   'Eat your normal meal; sample drawn exactly 2 hours after first bite.',
   'Plasma (fluoride)', TRUE),

  ('Random Blood Sugar', 'RBS', 'BIOCHEMISTRY',
   'Single plasma glucose reading regardless of meals.',
   '< 200 mg/dL (random)', 'mg/dL', 80,
   50, 2, FALSE,
   'No preparation required; useful for screening.',
   'Plasma (fluoride)', TRUE),

  ('Glycated Hemoglobin', 'HBA1C', 'BIOCHEMISTRY',
   'Average blood sugar over the past 2-3 months. Diabetic monitoring.',
   '< 5.7% (normal), 5.7-6.4% (pre-DM), ≥ 6.5% (DM)', '%', 450,
   50, 24, FALSE,
   'No fasting needed. Reflects 3-month average glucose.',
   'Whole blood (EDTA)', TRUE),

  ('Lipid Profile', 'LIPID', 'BIOCHEMISTRY',
   'Total cholesterol, HDL, LDL, VLDL, triglycerides.',
   'TC < 200, LDL < 100, HDL > 40, TG < 150 mg/dL', 'mg/dL', 600,
   50, 12, TRUE,
   'Fast 9-12 hours; water and prescription medicines OK.',
   'Serum', TRUE),

  ('Liver Function Test', 'LFT', 'BIOCHEMISTRY',
   'Bilirubin (total/direct), SGPT, SGOT, ALP, total protein, albumin.',
   'SGPT 7-56 U/L, SGOT 10-40 U/L, Bilirubin < 1.2 mg/dL', 'mixed', 650,
   50, 12, FALSE,
   'Avoid alcohol 24 hours before sample.', 'Serum', TRUE),

  ('Kidney Function Test', 'KFT', 'BIOCHEMISTRY',
   'Urea, creatinine, uric acid, eGFR; assesses renal function.',
   'Creatinine 0.6-1.3 mg/dL, Urea 15-40 mg/dL', 'mixed', 500,
   50, 12, FALSE,
   'No special preparation; stay well hydrated.', 'Serum', TRUE),

  ('Serum Electrolytes', 'ELECTROLYTES', 'BIOCHEMISTRY',
   'Sodium, potassium, chloride.',
   'Na 135-145, K 3.5-5.0, Cl 96-106 mEq/L', 'mEq/L', 400,
   50, 6, FALSE,
   'No preparation required.', 'Serum', TRUE),

  ('Serum Calcium', 'CALCIUM', 'BIOCHEMISTRY',
   'Total calcium; combine with albumin for ionised correction.',
   '8.5-10.5 mg/dL', 'mg/dL', 200,
   50, 12, FALSE,
   'No preparation required.', 'Serum', TRUE),

  ('Serum Uric Acid', 'URICACID', 'BIOCHEMISTRY',
   'Marker for gout, renal function, metabolic disorders.',
   'M 3.4-7.0, F 2.4-6.0 mg/dL', 'mg/dL', 200,
   50, 12, FALSE,
   'Avoid high-purine meals (red meat, beer) 24h prior.', 'Serum', TRUE),

  ('Serum Creatinine', 'CREATININE', 'BIOCHEMISTRY',
   'Standalone creatinine; renal function indicator.',
   '0.6-1.3 mg/dL (adult)', 'mg/dL', 180,
   50, 6, FALSE,
   'Stay hydrated; no special preparation otherwise.', 'Serum', TRUE),

  -- ── Endocrinology ──────────────────────────────────────────────
  ('Thyroid Stimulating Hormone', 'TSH', 'ENDOCRINOLOGY',
   'Pituitary thyroid-axis screen.',
   '0.4-4.0 mIU/L (adult)', 'mIU/L', 300,
   50, 24, FALSE,
   'Take morning samples for consistency; mention thyroid medications.',
   'Serum', TRUE),

  ('Total T3 & T4', 'T3T4', 'ENDOCRINOLOGY',
   'Total triiodothyronine + thyroxine; usually paired with TSH.',
   'T3 80-200 ng/dL, T4 5-12 μg/dL', 'mixed', 600,
   50, 24, FALSE,
   'Mention thyroid medication doses on the requisition.',
   'Serum', TRUE),

  ('Cortisol (Morning)', 'CORTISOL', 'ENDOCRINOLOGY',
   '8 AM serum cortisol; adrenal screen.',
   '5-25 μg/dL (8 AM)', 'μg/dL', 800,
   50, 24, FALSE,
   'Sample MUST be drawn between 7 AM and 9 AM.',
   'Serum', TRUE),

  -- ── Vitamin ────────────────────────────────────────────────────
  ('Vitamin D, 25-Hydroxy', 'VITD25', 'VITAMIN',
   '25-OH cholecalciferol; the vitamin D pool reservoir.',
   '30-100 ng/mL (sufficient)', 'ng/mL', 1200,
   50, 48, FALSE,
   'No preparation required.', 'Serum', TRUE),

  ('Vitamin B12', 'VITB12', 'VITAMIN',
   'Cobalamin level; deficiency causes anaemia + neuropathy.',
   '200-900 pg/mL', 'pg/mL', 800,
   50, 48, FALSE,
   'Mention any oral B12 supplements; pause 48h prior if possible.',
   'Serum', TRUE),

  -- ── Microbiology ───────────────────────────────────────────────
  ('Urine Routine & Microscopy', 'URINE_RM', 'MICROBIOLOGY',
   'Physical, chemical, microscopic exam of urine.',
   'Reported descriptively', 'qualitative', 150,
   30, 4, FALSE,
   'Mid-stream clean-catch sample preferred. Bring own container if walk-in.',
   'Urine', TRUE),

  ('Urine Culture', 'URINE_CS', 'MICROBIOLOGY',
   'Bacterial culture + sensitivity for UTI.',
   'No growth (sterile)', 'qualitative', 400,
   30, 72, FALSE,
   'Sterile mid-stream catch. Refrigerate if delivery > 1 hour.',
   'Urine (sterile)', TRUE),

  ('Blood Culture', 'BLOOD_CS', 'MICROBIOLOGY',
   'Aerobic + anaerobic; suspected bacteraemia / sepsis.',
   'No growth (sterile)', 'qualitative', 600,
   100, 120, FALSE,
   'Drawn before antibiotics if possible; two separate sites preferred.',
   'Blood (culture bottles)', TRUE),

  ('Stool Routine & Microscopy', 'STOOL_RM', 'MICROBIOLOGY',
   'Macroscopic + microscopic stool exam; ova, cysts, parasites.',
   'Reported descriptively', 'qualitative', 200,
   30, 6, FALSE,
   'Fresh sample within 1 hour. Bring own container if walk-in.',
   'Stool', TRUE),

  -- ── Serology / Immunology ──────────────────────────────────────
  ('HIV 1 & 2 Antibody (ELISA)', 'HIV', 'SEROLOGY',
   '4th-gen HIV antibody/p24 antigen screen.',
   'Non-reactive', 'qualitative', 500,
   50, 24, FALSE,
   'Confidential test. Counselling available before/after.',
   'Serum', TRUE),

  ('Hepatitis B Surface Antigen', 'HBSAG', 'SEROLOGY',
   'HBV chronic-infection screen.',
   'Non-reactive', 'qualitative', 300,
   50, 24, FALSE,
   'No preparation required.', 'Serum', TRUE),

  ('Hepatitis C Antibody', 'HCV', 'SEROLOGY',
   'HCV antibody screen.',
   'Non-reactive', 'qualitative', 500,
   50, 24, FALSE,
   'No preparation required.', 'Serum', TRUE),

  ('Dengue NS1 Antigen', 'DENGUE_NS1', 'SEROLOGY',
   'Detects dengue infection in the first 5 days of fever.',
   'Negative', 'qualitative', 500,
   50, 6, FALSE,
   'Sample within first 5 days of fever for best sensitivity.',
   'Serum', TRUE),

  ('Malaria Antigen (RDT)', 'MALARIA_AG', 'SEROLOGY',
   'Rapid diagnostic test for P. falciparum / P. vivax.',
   'Negative', 'qualitative', 250,
   50, 2, FALSE,
   'Best drawn at time of fever spike.',
   'Whole blood', TRUE),

  ('Typhoid (Widal Test)', 'WIDAL', 'SEROLOGY',
   'Salmonella typhi/paratyphi agglutination titres.',
   'O < 1:80, H < 1:160 (paired sera preferred)', 'titre', 250,
   50, 24, FALSE,
   'Useful from week 2 of illness; paired sera 7-10 days apart.',
   'Serum', TRUE),

  -- ── Cardiology / Inflammation ──────────────────────────────────
  ('Troponin I (hs)', 'TROPI', 'CARDIOLOGY',
   'High-sensitivity cardiac troponin I; suspected MI.',
   '< 0.04 ng/mL', 'ng/mL', 1000,
   100, 2, FALSE,
   'Urgent test — typically ordered ED/inpatient. Serial samples advised.',
   'Serum', TRUE),

  ('CPK-MB', 'CKMB', 'CARDIOLOGY',
   'Creatine kinase MB isoenzyme; cardiac marker.',
   '< 5 ng/mL or < 5% of total CK', 'ng/mL', 600,
   50, 4, FALSE,
   'Urgent test — usually ED/inpatient.',
   'Serum', TRUE),

  ('D-Dimer', 'DDIMER', 'CARDIOLOGY',
   'Fibrin degradation product; rules out venous thromboembolism.',
   '< 500 ng/mL FEU', 'ng/mL FEU', 1200,
   100, 6, FALSE,
   'No preparation; mention any anticoagulant use.',
   'Plasma (citrate)', TRUE),

  ('C-Reactive Protein', 'CRP', 'BIOCHEMISTRY',
   'Acute-phase reactant; non-specific inflammation marker.',
   '< 5 mg/L', 'mg/L', 400,
   50, 6, FALSE,
   'No preparation required.', 'Serum', TRUE),

  -- ── Pregnancy ──────────────────────────────────────────────────
  ('Beta hCG (Quantitative)', 'BETAHCG', 'PREGNANCY',
   'Quantitative serum beta-human chorionic gonadotropin.',
   '< 5 mIU/mL (non-pregnant)', 'mIU/mL', 500,
   50, 24, FALSE,
   'No preparation; first morning sample preferred.',
   'Serum', TRUE),

  ('Urine Pregnancy Test', 'UPT', 'PREGNANCY',
   'Qualitative urine hCG (β-subunit); home-grade.',
   'Negative / Positive', 'qualitative', 150,
   30, 1, FALSE,
   'First morning urine for highest sensitivity.',
   'Urine', TRUE)

ON CONFLICT (code) DO NOTHING;

COMMIT;
