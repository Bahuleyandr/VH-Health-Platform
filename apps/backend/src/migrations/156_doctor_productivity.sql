-- Migration 156: Doctor productivity — smart phrases + order sets
-- (Sprint 8). Clinical calculators are pure compute (no DB).
--
-- Smart phrases ("dot phrases") are short codes a doctor types into
-- any text field that auto-expand to long boilerplate. Standard EHR
-- pattern from EPIC / Cerner. Each phrase can be private to one user
-- or shared across the tenant. The body supports {{TOKEN}}
-- placeholders (resolved at expand time by the client given the
-- encounter context).
--
-- Order sets are bundle templates — "Pneumonia adult IP order set"
-- expands to N orders (IV ceftriaxone + azithro + IV fluids + chest
-- X-ray + CBC + blood culture + saturation monitoring + diet). The
-- doctor picks which lines to keep before signing.

BEGIN;

-- ── 1. Smart phrases ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS smart_phrases (
  id            SERIAL PRIMARY KEY,
  code          VARCHAR(40) NOT NULL,             -- ".dmnotes", ".htnreview"
  title         VARCHAR(160) NOT NULL,
  body          TEXT NOT NULL,
  specialty     VARCHAR(60),                      -- "general_medicine", "obg", "pediatrics"
  scope         VARCHAR(20) NOT NULL DEFAULT 'private'
    CHECK (scope IN ('private', 'tenant_shared')),
  owner_uid     UUID,                             -- null when scope='tenant_shared'
  -- Placeholders the body uses (e.g. ['AGE', 'DIAGNOSIS', 'BP']) so
  -- the client UI knows what to substitute.
  placeholders  TEXT[],
  use_count     INTEGER NOT NULL DEFAULT 0,
  active        BOOLEAN NOT NULL DEFAULT true,
  notes         TEXT,
  tenant_id     UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Code is unique per (tenant, scope, owner). A doctor's private
  -- ".dmnotes" doesn't collide with a tenant-shared one.
  UNIQUE (tenant_id, scope, owner_uid, code)
);

CREATE INDEX IF NOT EXISTS idx_smart_phrases_lookup
  ON smart_phrases(tenant_id, owner_uid, scope, code, active);
CREATE INDEX IF NOT EXISTS idx_smart_phrases_specialty
  ON smart_phrases(tenant_id, specialty, scope, active);

-- Seed a few clinically-useful templates as tenant-shared so a fresh
-- tenant has something to start with.
INSERT INTO smart_phrases (code, title, body, specialty, scope, placeholders)
SELECT v.code, v.title, v.body, v.spec, 'tenant_shared', v.ph
FROM (VALUES
  ('.dmreview',
   'Diabetes follow-up review',
   E'Diabetes Mellitus type {{DM_TYPE}} since {{DURATION_YEARS}} years.\nCurrent medications: {{MEDS}}.\nLatest HbA1c: {{HBA1C}} on {{HBA1C_DATE}}.\nFasting BS: {{FBS}} mg/dL, post-prandial: {{PPBS}} mg/dL.\nFundus: {{FUNDUS}}. Foot exam: {{FOOT}}.\nNo hypoglycaemic episodes / {{HYPO_NOTES}}.\nCompliance: {{COMPLIANCE}}.\nPlan: {{PLAN}}.',
   'general_medicine',
   ARRAY['DM_TYPE','DURATION_YEARS','MEDS','HBA1C','HBA1C_DATE','FBS','PPBS','FUNDUS','FOOT','HYPO_NOTES','COMPLIANCE','PLAN']),
  ('.htnreview',
   'Hypertension follow-up review',
   E'Hypertension since {{DURATION_YEARS}} years on {{MEDS}}.\nBP today: {{BP}} (left arm, sitting).\nHome BP log: {{HOME_BP}}.\nNo chest pain / breathlessness / palpitations / pedal edema.\nCompliance: {{COMPLIANCE}}.\nPlan: {{PLAN}}.',
   'general_medicine',
   ARRAY['DURATION_YEARS','MEDS','BP','HOME_BP','COMPLIANCE','PLAN']),
  ('.feverwu',
   'Fever workup template',
   E'Fever for {{DURATION_DAYS}} days, max {{MAX_TEMP}}°C, with {{ASSOC_SYMPTOMS}}.\nNo cough / loose stools / dysuria / rash / joint pain / {{NEG_HX}}.\nExam: pulse {{PULSE}}, BP {{BP}}, no pallor / icterus / lymphadenopathy.\nChest, P/A, CNS unremarkable.\nWorkup: CBC, ESR, CRP, malarial parasite, dengue NS1+IgM, urine routine, blood culture x2.\nPlan: paracetamol, oral fluids, review with reports.',
   'general_medicine',
   ARRAY['DURATION_DAYS','MAX_TEMP','ASSOC_SYMPTOMS','NEG_HX','PULSE','BP']),
  ('.normaldelivery',
   'Normal vaginal delivery summary',
   E'G{{G}}P{{P}} delivered a live {{SEX}} baby weighing {{WEIGHT}}g via spontaneous vaginal delivery at {{TIME}}.\nGestational age: {{GA}} weeks. Liquor: clear. Cord around neck: {{CAN}}.\nApgar: {{APGAR1}}/10 at 1 min, {{APGAR5}}/10 at 5 min. Resuscitation: not required.\nPlacenta and membranes complete, delivered at {{PLACENTA_TIME}}. Blood loss: {{EBL}}ml. Episiotomy: {{EPIS}}, repaired with vicryl 2-0. Perineum intact.\nMother and baby stable. Vit K given. Skin-to-skin and breastfeeding initiated within {{BF_MIN}} min.',
   'obg',
   ARRAY['G','P','SEX','WEIGHT','TIME','GA','CAN','APGAR1','APGAR5','PLACENTA_TIME','EBL','EPIS','BF_MIN']),
  ('.dischargesummary',
   'Generic discharge summary header',
   E'{{NAME}}, {{AGE}}/{{SEX}}, {{HOSPITAL_NUMBER}}, was admitted on {{ADM_DATE}} with complaints of {{CHIEF}}.\nDiagnosis: {{DIAGNOSIS}}.\nClinical course: {{COURSE}}.\nInvestigations: {{INV}}.\nTreatment: {{TX}}.\nCondition at discharge: stable, afebrile, vitals stable.\nDischarge medications: {{MEDS}}.\nFollow-up: {{FOLLOWUP}}.',
   'general_medicine',
   ARRAY['NAME','AGE','SEX','HOSPITAL_NUMBER','ADM_DATE','CHIEF','DIAGNOSIS','COURSE','INV','TX','MEDS','FOLLOWUP'])
) AS v(code, title, body, spec, ph)
WHERE NOT EXISTS (
  SELECT 1 FROM smart_phrases sp
   WHERE sp.code = v.code
     AND sp.scope = 'tenant_shared'
     AND sp.tenant_id = '00000000-0000-4000-8000-000000000001'::uuid
);

-- ── 2. Order sets ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clinical_order_sets (
  id              SERIAL PRIMARY KEY,
  code            VARCHAR(60) UNIQUE NOT NULL,         -- "ORDERSET-PNEUMONIA-IP"
  title           VARCHAR(255) NOT NULL,
  specialty       VARCHAR(60),
  condition_codes TEXT[],                              -- ICD-10 it applies to
  description     TEXT,
  active          BOOLEAN NOT NULL DEFAULT true,
  created_by      UUID,
  tenant_id       UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clinical_order_sets_specialty
  ON clinical_order_sets(specialty, active);

CREATE TABLE IF NOT EXISTS clinical_order_set_items (
  id            SERIAL PRIMARY KEY,
  order_set_id  INTEGER NOT NULL REFERENCES clinical_order_sets(id) ON DELETE CASCADE,
  display_order INTEGER NOT NULL DEFAULT 1,
  kind          VARCHAR(20) NOT NULL CHECK (kind IN
    ('med', 'lab', 'radiology', 'diet', 'nursing', 'vitals',
     'consult', 'note', 'monitor', 'other')),
  payload       JSONB NOT NULL,                        -- shape depends on kind
  -- For meds: {drug, dose, route, frequency, duration_days, prn, notes}
  -- For lab:  {test_code, test_name, urgency, notes}
  -- For radiology: {study, region, contrast, urgency}
  -- For diet/nursing/vitals/etc.: {label, instructions}
  default_selected BOOLEAN NOT NULL DEFAULT true,      -- pre-checked when set is applied
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clinical_order_set_items_set
  ON clinical_order_set_items(order_set_id, display_order);

-- Seed common emergency/IP order sets.
INSERT INTO clinical_order_sets (code, title, specialty, condition_codes, description)
SELECT v.code, v.title, v.spec, v.codes, v.desc
FROM (VALUES
  ('ORDERSET-PNEUMONIA-IP', 'Community-acquired pneumonia (IP, adult)',
   'general_medicine', ARRAY['J18.9'],
   'Adult IP CAP starter — IV antibiotics + supportive + workup.'),
  ('ORDERSET-AMI-STEMI', 'STEMI / Acute MI initial bundle',
   'cardiology', ARRAY['I21.0','I21.9'],
   'Door-to-balloon: aspirin + clopidogrel + statin + heparin + ECG + Trop-T.'),
  ('ORDERSET-DKA', 'Diabetic ketoacidosis (adult)',
   'general_medicine', ARRAY['E10.10','E11.10'],
   'Insulin drip + IV fluids + K+ replacement + monitoring.'),
  ('ORDERSET-SEPSIS-1HR', 'Sepsis 1-hour bundle',
   'critical_care', ARRAY['A41.9','R65.20'],
   'Surviving Sepsis 1-hour bundle: lactate, blood cultures, broad-spectrum, IV fluid 30 ml/kg, pressors if needed.'),
  ('ORDERSET-LSCS-PREOP', 'LSCS pre-operative bundle',
   'obg', ARRAY['O82'],
   'Pre-op for elective LSCS: NPO, group + cross 1 unit, antacid, prophylactic IV antibiotic, urinary catheter.')
) AS v(code, title, spec, codes, desc)
WHERE NOT EXISTS (SELECT 1 FROM clinical_order_sets WHERE code = v.code);

-- Seed items for ORDERSET-PNEUMONIA-IP
INSERT INTO clinical_order_set_items (order_set_id, display_order, kind, payload)
SELECT (SELECT id FROM clinical_order_sets WHERE code = 'ORDERSET-PNEUMONIA-IP'),
       d.display_order, d.kind, d.payload::jsonb
FROM (VALUES
  (1, 'med',     '{"drug":"Ceftriaxone","dose":"1g","route":"IV","frequency":"q12h","duration_days":7}'),
  (2, 'med',     '{"drug":"Azithromycin","dose":"500mg","route":"PO","frequency":"OD","duration_days":5}'),
  (3, 'med',     '{"drug":"Paracetamol","dose":"1g","route":"PO","frequency":"q8h","prn":true,"prn_for":"fever > 38.5"}'),
  (4, 'lab',     '{"test_code":"CBC","test_name":"Complete Blood Count","urgency":"routine"}'),
  (5, 'lab',     '{"test_code":"CRP","test_name":"C-reactive protein","urgency":"routine"}'),
  (6, 'lab',     '{"test_code":"BCULT","test_name":"Blood culture x2","urgency":"stat"}'),
  (7, 'lab',     '{"test_code":"PROCAL","test_name":"Procalcitonin","urgency":"routine"}'),
  (8, 'radiology','{"study":"Chest X-ray PA","region":"chest","urgency":"routine"}'),
  (9, 'vitals',  '{"label":"Vitals q4h with SpO2"}'),
  (10,'monitor', '{"label":"SpO2 monitoring continuous"}'),
  (11,'diet',    '{"label":"Soft diet, oral fluids ad lib"}')
) AS d(display_order, kind, payload)
WHERE NOT EXISTS (
  SELECT 1 FROM clinical_order_set_items
   WHERE order_set_id = (SELECT id FROM clinical_order_sets WHERE code = 'ORDERSET-PNEUMONIA-IP')
);

-- Seed items for ORDERSET-AMI-STEMI
INSERT INTO clinical_order_set_items (order_set_id, display_order, kind, payload)
SELECT (SELECT id FROM clinical_order_sets WHERE code = 'ORDERSET-AMI-STEMI'),
       d.display_order, d.kind, d.payload::jsonb
FROM (VALUES
  (1, 'med',     '{"drug":"Aspirin","dose":"325mg","route":"PO chewed","frequency":"STAT"}'),
  (2, 'med',     '{"drug":"Clopidogrel","dose":"600mg","route":"PO","frequency":"loading dose STAT"}'),
  (3, 'med',     '{"drug":"Atorvastatin","dose":"80mg","route":"PO","frequency":"OD","duration_days":30}'),
  (4, 'med',     '{"drug":"Heparin (UFH)","dose":"60 units/kg bolus then 12 u/kg/hr","route":"IV","frequency":"continuous"}'),
  (5, 'med',     '{"drug":"Morphine","dose":"2-4 mg","route":"IV","frequency":"q5min PRN","prn":true,"prn_for":"chest pain"}'),
  (6, 'med',     '{"drug":"Oxygen","dose":"if SpO2 < 90%","route":"nasal","frequency":"titrate"}'),
  (7, 'lab',     '{"test_code":"TROPT","test_name":"Troponin-T","urgency":"stat"}'),
  (8, 'lab',     '{"test_code":"ECG12","test_name":"ECG 12-lead","urgency":"stat"}'),
  (9, 'lab',     '{"test_code":"CKMB","test_name":"CK-MB","urgency":"stat"}'),
  (10,'lab',     '{"test_code":"BMP","test_name":"Renal panel + electrolytes","urgency":"routine"}'),
  (11,'consult', '{"specialty":"interventional_cardiology","urgency":"stat","reason":"Cath lab activation"}'),
  (12,'monitor', '{"label":"Continuous cardiac monitoring + SpO2"}')
) AS d(display_order, kind, payload)
WHERE NOT EXISTS (
  SELECT 1 FROM clinical_order_set_items
   WHERE order_set_id = (SELECT id FROM clinical_order_sets WHERE code = 'ORDERSET-AMI-STEMI')
);

-- ── 3. Application audit ────────────────────────────────────────────
-- Records every time an order set was applied to an encounter, who
-- applied it, and which items they kept. Useful for auditing protocol
-- compliance.
CREATE TABLE IF NOT EXISTS clinical_order_set_applications (
  id              SERIAL PRIMARY KEY,
  order_set_id    INTEGER NOT NULL REFERENCES clinical_order_sets(id) ON DELETE RESTRICT,
  encounter_id    INTEGER,
  patient_uid     UUID,
  applied_by      UUID,
  applied_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  items_applied   JSONB NOT NULL DEFAULT '[]'::jsonb,  -- which items survived clinician edit
  items_skipped   JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes           TEXT,
  tenant_id       UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid
);

CREATE INDEX IF NOT EXISTS idx_clinical_order_set_apps_encounter
  ON clinical_order_set_applications(encounter_id) WHERE encounter_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_clinical_order_set_apps_patient
  ON clinical_order_set_applications(patient_uid, applied_at DESC);

COMMIT;
