-- 277_drug_knowledge_base.sql
--
-- Roadmap Pillar B / item B2 (docs/EPIC_LEVEL_ROADMAP.md) — real drug
-- knowledge base schema. Until now drug-drug checking was a hand-rolled
-- antithrombotic table inside prescriptionSafetyCheck.js plus a toy
-- drug_interactions seed — "the biggest clinical-credibility gap vs Epic".
--
-- This migration adds the KB substrate the CDS pipeline reads:
--   * drug_kb_sources                — which KB release is loaded (Medi-Span /
--                                      FDB / CIMS / CDSCO-derived; licensing is
--                                      an owner-side procurement action)
--   * drug_kb_monographs             — drug identities + alias lists (Indian
--                                      brand names) the matcher resolves
--                                      free-text prescription names against
--   * drug_kb_interactions           — drug–drug pairs with severity/mechanism/
--                                      management (canonical a<b key order)
--   * drug_kb_allergy_groups         — cross-sensitivity group membership
--   * drug_kb_allergy_cross_reactivity — group↔group reactivity edges
--   * drug_kb_condition_cautions     — drug–disease cautions keyed by ICD-10
--                                      prefix (consumes the B7 problem list)
--   * drug_kb_dose_ranges            — adult/paediatric dose ceilings incl.
--                                      renal thresholds
--   * drug_kb_iv_compatibility       — Y-site/line compatibility pairs
--
-- Reference data: global, no PHI, no tenant_id/RLS (same stance as the B8
-- terminology tables).
--
-- A STARTER dataset (source_key 'vh_starter_set', is_starter = true) seeds
-- ~90 rows of high-attestation, textbook-level content so the engine has
-- clinical value from day one. It is deliberately conservative and clearly
-- flagged: the roadmap-B2 acceptance bar remains importing a licensed KB
-- via scripts/drug-kb-import.mjs, after which the starter set can be
-- deactivated (UPDATE drug_kb_sources SET is_active = false WHERE source_key
-- = 'vh_starter_set').

BEGIN;

CREATE TABLE IF NOT EXISTS drug_kb_sources (
  id           SERIAL PRIMARY KEY,
  source_key   VARCHAR(60) NOT NULL UNIQUE,
  name         VARCHAR(200) NOT NULL,
  vendor       VARCHAR(120),
  version      VARCHAR(80),
  license_note VARCHAR(255),
  is_starter   BOOLEAN NOT NULL DEFAULT false,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  imported_at  TIMESTAMPTZ(6),
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS drug_kb_monographs (
  id           SERIAL PRIMARY KEY,
  source_key   VARCHAR(60) NOT NULL REFERENCES drug_kb_sources(source_key) ON UPDATE CASCADE,
  drug_key     VARCHAR(120) NOT NULL,
  display_name VARCHAR(200) NOT NULL,
  atc_code     VARCHAR(20),
  drug_class   VARCHAR(120),
  aliases      TEXT[] NOT NULL DEFAULT '{}',
  properties   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT drug_kb_monographs_unique UNIQUE (source_key, drug_key)
);

CREATE INDEX IF NOT EXISTS idx_drug_kb_monographs_key ON drug_kb_monographs (drug_key);

CREATE TABLE IF NOT EXISTS drug_kb_interactions (
  id          SERIAL PRIMARY KEY,
  source_key  VARCHAR(60) NOT NULL REFERENCES drug_kb_sources(source_key) ON UPDATE CASCADE,
  drug_a_key  VARCHAR(120) NOT NULL,
  drug_b_key  VARCHAR(120) NOT NULL,
  severity    VARCHAR(20) NOT NULL,
  mechanism   TEXT,
  effect      TEXT,
  management  TEXT,
  evidence    VARCHAR(40),
  created_at  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT drug_kb_interactions_unique UNIQUE (source_key, drug_a_key, drug_b_key),
  CONSTRAINT chk_drug_kb_interactions_severity
    CHECK (severity IN ('contraindicated', 'major', 'moderate', 'minor')),
  CONSTRAINT chk_drug_kb_interactions_order CHECK (drug_a_key < drug_b_key)
);

CREATE INDEX IF NOT EXISTS idx_drug_kb_interactions_a ON drug_kb_interactions (drug_a_key);
CREATE INDEX IF NOT EXISTS idx_drug_kb_interactions_b ON drug_kb_interactions (drug_b_key);

CREATE TABLE IF NOT EXISTS drug_kb_allergy_groups (
  id         SERIAL PRIMARY KEY,
  source_key VARCHAR(60) NOT NULL REFERENCES drug_kb_sources(source_key) ON UPDATE CASCADE,
  group_key  VARCHAR(80) NOT NULL,
  member_key VARCHAR(120) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT drug_kb_allergy_groups_unique UNIQUE (source_key, group_key, member_key)
);

CREATE INDEX IF NOT EXISTS idx_drug_kb_allergy_groups_member ON drug_kb_allergy_groups (member_key);

CREATE TABLE IF NOT EXISTS drug_kb_allergy_cross_reactivity (
  id                    SERIAL PRIMARY KEY,
  source_key            VARCHAR(60) NOT NULL REFERENCES drug_kb_sources(source_key) ON UPDATE CASCADE,
  group_key             VARCHAR(80) NOT NULL,
  reacts_with_group_key VARCHAR(80) NOT NULL,
  risk                  VARCHAR(20) NOT NULL DEFAULT 'moderate',
  note                  TEXT,
  created_at            TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT drug_kb_allergy_xreact_unique UNIQUE (source_key, group_key, reacts_with_group_key),
  CONSTRAINT chk_drug_kb_allergy_xreact_risk CHECK (risk IN ('high', 'moderate', 'low'))
);

CREATE TABLE IF NOT EXISTS drug_kb_condition_cautions (
  id              SERIAL PRIMARY KEY,
  source_key      VARCHAR(60) NOT NULL REFERENCES drug_kb_sources(source_key) ON UPDATE CASCADE,
  drug_key        VARCHAR(120) NOT NULL,
  icd10_prefix    VARCHAR(10) NOT NULL,
  condition_label VARCHAR(200) NOT NULL,
  risk            VARCHAR(20) NOT NULL,
  note            TEXT,
  created_at      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT drug_kb_condition_cautions_unique UNIQUE (source_key, drug_key, icd10_prefix),
  CONSTRAINT chk_drug_kb_condition_risk CHECK (risk IN ('contraindicated', 'caution'))
);

CREATE INDEX IF NOT EXISTS idx_drug_kb_condition_cautions_drug ON drug_kb_condition_cautions (drug_key);

CREATE TABLE IF NOT EXISTS drug_kb_dose_ranges (
  id                  SERIAL PRIMARY KEY,
  source_key          VARCHAR(60) NOT NULL REFERENCES drug_kb_sources(source_key) ON UPDATE CASCADE,
  drug_key            VARCHAR(120) NOT NULL,
  route               VARCHAR(20),
  population          VARCHAR(20) NOT NULL DEFAULT 'adult',
  max_single_dose_mg  NUMERIC(10,3),
  max_daily_dose_mg   NUMERIC(10,3),
  max_daily_mg_per_kg NUMERIC(10,3),
  min_egfr            NUMERIC(6,2),
  egfr_max_daily_mg   NUMERIC(10,3),
  note                TEXT,
  created_at          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_drug_kb_dose_population CHECK (population IN ('adult', 'pediatric', 'neonatal'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_drug_kb_dose_ranges
  ON drug_kb_dose_ranges (source_key, drug_key, COALESCE(route, 'any'), population);
CREATE INDEX IF NOT EXISTS idx_drug_kb_dose_ranges_drug ON drug_kb_dose_ranges (drug_key);

CREATE TABLE IF NOT EXISTS drug_kb_iv_compatibility (
  id            SERIAL PRIMARY KEY,
  source_key    VARCHAR(60) NOT NULL REFERENCES drug_kb_sources(source_key) ON UPDATE CASCADE,
  drug_a_key    VARCHAR(120) NOT NULL,
  drug_b_key    VARCHAR(120) NOT NULL,
  compatibility VARCHAR(20) NOT NULL,
  diluent       VARCHAR(80),
  note          TEXT,
  created_at    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_drug_kb_iv_compat CHECK (compatibility IN ('compatible', 'incompatible', 'caution')),
  CONSTRAINT chk_drug_kb_iv_order CHECK (drug_a_key < drug_b_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_drug_kb_iv_compatibility
  ON drug_kb_iv_compatibility (source_key, drug_a_key, drug_b_key, COALESCE(diluent, 'any'));

-- ════════════════════════════════════════════════════════════════════════
-- Starter dataset — textbook-attestation content, clearly flagged.
-- ════════════════════════════════════════════════════════════════════════

INSERT INTO drug_kb_sources (source_key, name, vendor, version, license_note, is_starter, imported_at)
VALUES ('vh_starter_set', 'VH starter drug-safety set', 'VH Health (curated)', '2026.06',
        'Curated high-attestation starter content. NOT a licensed KB — roadmap B2 acceptance requires importing Medi-Span/FDB/CIMS via scripts/drug-kb-import.mjs, then deactivating this source.',
        true, NOW())
ON CONFLICT (source_key) DO NOTHING;

-- Monographs (drug identities + Indian brand aliases used by the matcher).
INSERT INTO drug_kb_monographs (source_key, drug_key, display_name, atc_code, drug_class, aliases) VALUES
  ('vh_starter_set', 'paracetamol',     'Paracetamol',     'N02BE01', 'analgesic-antipyretic', ARRAY['paracetamol','acetaminophen','crocin','dolo','calpol','pcm']),
  ('vh_starter_set', 'ibuprofen',       'Ibuprofen',       'M01AE01', 'nsaid',                 ARRAY['ibuprofen','brufen','combiflam']),
  ('vh_starter_set', 'diclofenac',      'Diclofenac',      'M01AB05', 'nsaid',                 ARRAY['diclofenac','voveran','dynapar']),
  ('vh_starter_set', 'naproxen',        'Naproxen',        'M01AE02', 'nsaid',                 ARRAY['naproxen','naprosyn']),
  ('vh_starter_set', 'ketorolac',       'Ketorolac',       'M01AB15', 'nsaid',                 ARRAY['ketorolac','ketorol']),
  ('vh_starter_set', 'aceclofenac',     'Aceclofenac',     'M01AB16', 'nsaid',                 ARRAY['aceclofenac','zerodol','hifenac']),
  ('vh_starter_set', 'mefenamic acid',  'Mefenamic acid',  'M01AG01', 'nsaid',                 ARRAY['mefenamic','meftal']),
  ('vh_starter_set', 'aspirin',         'Aspirin',         'B01AC06', 'antiplatelet',          ARRAY['aspirin','acetylsalicylic','ecosprin','disprin']),
  ('vh_starter_set', 'metformin',       'Metformin',       'A10BA02', 'biguanide',             ARRAY['metformin','glycomet','glucophage']),
  ('vh_starter_set', 'amoxicillin',     'Amoxicillin',     'J01CA04', 'penicillin',            ARRAY['amoxicillin','amoxycillin','mox','novamox']),
  ('vh_starter_set', 'amoxiclav',       'Amoxicillin-clavulanate', 'J01CR02', 'penicillin',    ARRAY['amoxiclav','augmentin','clavam','moxikind']),
  ('vh_starter_set', 'ampicillin',      'Ampicillin',      'J01CA01', 'penicillin',            ARRAY['ampicillin']),
  ('vh_starter_set', 'cloxacillin',     'Cloxacillin',     'J01CF02', 'penicillin',            ARRAY['cloxacillin']),
  ('vh_starter_set', 'piperacillin',    'Piperacillin-tazobactam', 'J01CR05', 'penicillin',    ARRAY['piperacillin','tazobactam','piptaz']),
  ('vh_starter_set', 'ceftriaxone',     'Ceftriaxone',     'J01DD04', 'cephalosporin',         ARRAY['ceftriaxone','monocef']),
  ('vh_starter_set', 'cefixime',        'Cefixime',        'J01DD08', 'cephalosporin',         ARRAY['cefixime','taxim-o','zifi']),
  ('vh_starter_set', 'cefuroxime',      'Cefuroxime',      'J01DC02', 'cephalosporin',         ARRAY['cefuroxime','ceftum']),
  ('vh_starter_set', 'cephalexin',      'Cephalexin',      'J01DB01', 'cephalosporin',         ARRAY['cephalexin','cefalexin','sporidex']),
  ('vh_starter_set', 'cotrimoxazole',   'Co-trimoxazole',  'J01EE01', 'sulfonamide',           ARRAY['cotrimoxazole','co-trimoxazole','trimethoprim','sulfamethoxazole','septran','bactrim']),
  ('vh_starter_set', 'sulfasalazine',   'Sulfasalazine',   'A07EC01', 'sulfonamide',           ARRAY['sulfasalazine']),
  ('vh_starter_set', 'azithromycin',    'Azithromycin',    'J01FA10', 'macrolide',             ARRAY['azithromycin','azithral','azee']),
  ('vh_starter_set', 'clarithromycin',  'Clarithromycin',  'J01FA09', 'macrolide',             ARRAY['clarithromycin','claribid']),
  ('vh_starter_set', 'erythromycin',    'Erythromycin',    'J01FA01', 'macrolide',             ARRAY['erythromycin']),
  ('vh_starter_set', 'ciprofloxacin',   'Ciprofloxacin',   'J01MA02', 'fluoroquinolone',       ARRAY['ciprofloxacin','ciplox','cifran']),
  ('vh_starter_set', 'levofloxacin',    'Levofloxacin',    'J01MA12', 'fluoroquinolone',       ARRAY['levofloxacin','levoflox']),
  ('vh_starter_set', 'atorvastatin',    'Atorvastatin',    'C10AA05', 'statin',                ARRAY['atorvastatin','atorva','storvas']),
  ('vh_starter_set', 'simvastatin',     'Simvastatin',     'C10AA01', 'statin',                ARRAY['simvastatin']),
  ('vh_starter_set', 'rosuvastatin',    'Rosuvastatin',    'C10AA07', 'statin',                ARRAY['rosuvastatin','rosuvas']),
  ('vh_starter_set', 'methotrexate',    'Methotrexate',    'L04AX03', 'antifolate',            ARRAY['methotrexate','folitrax']),
  ('vh_starter_set', 'allopurinol',     'Allopurinol',     'M04AA01', 'xanthine-oxidase-inhibitor', ARRAY['allopurinol','zyloric']),
  ('vh_starter_set', 'azathioprine',    'Azathioprine',    'L04AX01', 'immunosuppressant',     ARRAY['azathioprine','azoran']),
  ('vh_starter_set', 'colchicine',      'Colchicine',      'M04AC01', 'antigout',              ARRAY['colchicine']),
  ('vh_starter_set', 'tramadol',        'Tramadol',        'N02AX02', 'opioid',                ARRAY['tramadol','ultracet','tramazac']),
  ('vh_starter_set', 'morphine',        'Morphine',        'N02AA01', 'opioid',                ARRAY['morphine']),
  ('vh_starter_set', 'codeine',         'Codeine',         'R05DA04', 'opioid',                ARRAY['codeine']),
  ('vh_starter_set', 'fluoxetine',      'Fluoxetine',      'N06AB03', 'ssri',                  ARRAY['fluoxetine','fludac']),
  ('vh_starter_set', 'sertraline',      'Sertraline',      'N06AB06', 'ssri',                  ARRAY['sertraline','daxid']),
  ('vh_starter_set', 'escitalopram',    'Escitalopram',    'N06AB10', 'ssri',                  ARRAY['escitalopram','nexito']),
  ('vh_starter_set', 'linezolid',       'Linezolid',       'J01XX08', 'oxazolidinone-maoi',    ARRAY['linezolid','lizolid']),
  ('vh_starter_set', 'sildenafil',      'Sildenafil',      'G04BE03', 'pde5-inhibitor',        ARRAY['sildenafil','viagra']),
  ('vh_starter_set', 'tadalafil',       'Tadalafil',       'G04BE08', 'pde5-inhibitor',        ARRAY['tadalafil']),
  ('vh_starter_set', 'nitroglycerin',   'Nitroglycerin',   'C01DA02', 'nitrate',               ARRAY['nitroglycerin','nitroglycerine','gtn','angised']),
  ('vh_starter_set', 'isosorbide',      'Isosorbide nitrate', 'C01DA08', 'nitrate',            ARRAY['isosorbide','sorbitrate','monotrate']),
  ('vh_starter_set', 'spironolactone',  'Spironolactone',  'C03DA01', 'k-sparing-diuretic',    ARRAY['spironolactone','aldactone']),
  ('vh_starter_set', 'enalapril',       'Enalapril',       'C09AA02', 'ace-inhibitor',         ARRAY['enalapril','envas']),
  ('vh_starter_set', 'ramipril',        'Ramipril',        'C09AA05', 'ace-inhibitor',         ARRAY['ramipril','cardace']),
  ('vh_starter_set', 'losartan',        'Losartan',        'C09CA01', 'arb',                   ARRAY['losartan','losar']),
  ('vh_starter_set', 'telmisartan',     'Telmisartan',     'C09CA07', 'arb',                   ARRAY['telmisartan','telma']),
  ('vh_starter_set', 'potassium chloride', 'Potassium chloride', 'A12BA01', 'electrolyte',     ARRAY['potassium chloride','kcl']),
  ('vh_starter_set', 'digoxin',         'Digoxin',         'C01AA05', 'cardiac-glycoside',     ARRAY['digoxin','lanoxin']),
  ('vh_starter_set', 'amiodarone',      'Amiodarone',      'C01BD01', 'antiarrhythmic',        ARRAY['amiodarone','cordarone']),
  ('vh_starter_set', 'verapamil',       'Verapamil',       'C08DA01', 'ccb',                   ARRAY['verapamil']),
  ('vh_starter_set', 'theophylline',    'Theophylline',    'R03DA04', 'methylxanthine',        ARRAY['theophylline','deriphyllin']),
  ('vh_starter_set', 'carbamazepine',   'Carbamazepine',   'N03AF01', 'anticonvulsant',        ARRAY['carbamazepine','tegretol','mazetol']),
  ('vh_starter_set', 'valproate',       'Sodium valproate','N03AG01', 'anticonvulsant',        ARRAY['valproate','valparin','encorate']),
  ('vh_starter_set', 'phenytoin',       'Phenytoin',       'N03AB02', 'anticonvulsant',        ARRAY['phenytoin','eptoin']),
  ('vh_starter_set', 'lithium',         'Lithium',         'N05AN01', 'mood-stabilizer',       ARRAY['lithium','licab']),
  ('vh_starter_set', 'hydrochlorothiazide', 'Hydrochlorothiazide', 'C03AA03', 'thiazide',      ARRAY['hydrochlorothiazide','hctz','aquazide']),
  ('vh_starter_set', 'furosemide',      'Furosemide',      'C03CA01', 'loop-diuretic',         ARRAY['furosemide','frusemide','lasix']),
  ('vh_starter_set', 'midazolam',       'Midazolam',       'N05CD08', 'benzodiazepine',        ARRAY['midazolam']),
  ('vh_starter_set', 'ondansetron',     'Ondansetron',     'A04AA01', '5ht3-antagonist',       ARRAY['ondansetron','emeset','ondem']),
  ('vh_starter_set', 'propranolol',     'Propranolol',     'C07AA05', 'beta-blocker',          ARRAY['propranolol','inderal']),
  ('vh_starter_set', 'vancomycin',      'Vancomycin',      'J01XA01', 'glycopeptide',          ARRAY['vancomycin']),
  ('vh_starter_set', 'ringer lactate',  'Ringer lactate',  'B05BB01', 'iv-fluid',              ARRAY['ringer lactate','ringers lactate','rl fluid','hartmann']),
  ('vh_starter_set', 'calcium gluconate', 'Calcium gluconate', 'A12AA03', 'electrolyte',       ARRAY['calcium gluconate','calcium chloride'])
ON CONFLICT (source_key, drug_key) DO NOTHING;

-- Drug–drug interactions (non-antithrombotic classics; the antithrombotic
-- axis stays owned by checkAntithromboticInteractions).
INSERT INTO drug_kb_interactions (source_key, drug_a_key, drug_b_key, severity, mechanism, effect, management, evidence) VALUES
  ('vh_starter_set', 'cotrimoxazole', 'methotrexate', 'contraindicated', 'Additive antifolate toxicity; TMP inhibits renal MTX clearance', 'Pancytopenia, mucositis', 'Avoid combination; use alternative antibiotic', 'textbook'),
  ('vh_starter_set', 'ibuprofen', 'methotrexate', 'major', 'NSAIDs reduce renal MTX clearance', 'Methotrexate toxicity', 'Avoid with high-dose MTX; monitor levels/counts with low-dose', 'textbook'),
  ('vh_starter_set', 'diclofenac', 'methotrexate', 'major', 'NSAIDs reduce renal MTX clearance', 'Methotrexate toxicity', 'Avoid with high-dose MTX; monitor with low-dose', 'textbook'),
  ('vh_starter_set', 'atorvastatin', 'clarithromycin', 'major', 'CYP3A4 inhibition raises statin exposure', 'Myopathy / rhabdomyolysis', 'Suspend statin during the macrolide course or switch to azithromycin', 'textbook'),
  ('vh_starter_set', 'clarithromycin', 'simvastatin', 'contraindicated', 'Strong CYP3A4 inhibition', 'Rhabdomyolysis', 'Contraindicated — suspend simvastatin', 'textbook'),
  ('vh_starter_set', 'clarithromycin', 'colchicine', 'contraindicated', 'CYP3A4/P-gp inhibition raises colchicine to toxic levels', 'Fatal colchicine toxicity reported', 'Avoid; if unavoidable, drastically reduce colchicine dose', 'textbook'),
  ('vh_starter_set', 'fluoxetine', 'tramadol', 'major', 'Additive serotonergic activity + CYP2D6 inhibition', 'Serotonin syndrome; seizure risk', 'Avoid; if needed monitor closely, prefer non-serotonergic analgesic', 'textbook'),
  ('vh_starter_set', 'sertraline', 'tramadol', 'major', 'Additive serotonergic activity', 'Serotonin syndrome', 'Avoid or monitor closely', 'textbook'),
  ('vh_starter_set', 'escitalopram', 'tramadol', 'major', 'Additive serotonergic activity', 'Serotonin syndrome', 'Avoid or monitor closely', 'textbook'),
  ('vh_starter_set', 'fluoxetine', 'linezolid', 'contraindicated', 'Linezolid is a reversible MAOI', 'Serotonin syndrome', 'Avoid; 2-week washout for fluoxetine where feasible', 'textbook'),
  ('vh_starter_set', 'linezolid', 'sertraline', 'contraindicated', 'Linezolid is a reversible MAOI', 'Serotonin syndrome', 'Avoid unless benefit outweighs risk with close monitoring', 'textbook'),
  ('vh_starter_set', 'nitroglycerin', 'sildenafil', 'contraindicated', 'Additive cGMP-mediated vasodilation', 'Profound refractory hypotension', 'Contraindicated; separate by ≥24h (sildenafil) / ≥48h (tadalafil)', 'textbook'),
  ('vh_starter_set', 'isosorbide', 'sildenafil', 'contraindicated', 'Additive cGMP-mediated vasodilation', 'Profound hypotension', 'Contraindicated', 'textbook'),
  ('vh_starter_set', 'isosorbide', 'tadalafil', 'contraindicated', 'Additive cGMP-mediated vasodilation', 'Profound hypotension', 'Contraindicated', 'textbook'),
  ('vh_starter_set', 'nitroglycerin', 'tadalafil', 'contraindicated', 'Additive cGMP-mediated vasodilation', 'Profound hypotension', 'Contraindicated', 'textbook'),
  ('vh_starter_set', 'enalapril', 'spironolactone', 'major', 'Dual potassium retention', 'Hyperkalaemia', 'Monitor K+/creatinine closely; avoid in renal impairment', 'textbook'),
  ('vh_starter_set', 'losartan', 'spironolactone', 'major', 'Dual potassium retention', 'Hyperkalaemia', 'Monitor K+ closely', 'textbook'),
  ('vh_starter_set', 'potassium chloride', 'spironolactone', 'major', 'Additive potassium load', 'Hyperkalaemia', 'Avoid unless documented hypokalaemia with monitoring', 'textbook'),
  ('vh_starter_set', 'amiodarone', 'digoxin', 'major', 'P-gp inhibition raises digoxin levels', 'Digoxin toxicity', 'Halve digoxin dose; monitor levels', 'textbook'),
  ('vh_starter_set', 'digoxin', 'verapamil', 'major', 'P-gp inhibition raises digoxin levels', 'Digoxin toxicity, bradycardia', 'Reduce digoxin; monitor levels and heart rate', 'textbook'),
  ('vh_starter_set', 'ciprofloxacin', 'theophylline', 'major', 'CYP1A2 inhibition', 'Theophylline toxicity (seizures, arrhythmia)', 'Avoid or reduce theophylline 50% with level monitoring', 'textbook'),
  ('vh_starter_set', 'allopurinol', 'azathioprine', 'contraindicated', 'Xanthine-oxidase inhibition blocks azathioprine catabolism', 'Profound myelosuppression', 'Avoid; if combined, reduce azathioprine to 25% with counts', 'textbook'),
  ('vh_starter_set', 'carbamazepine', 'erythromycin', 'major', 'CYP3A4 inhibition', 'Carbamazepine toxicity (ataxia, drowsiness)', 'Avoid macrolide or monitor carbamazepine levels', 'textbook'),
  ('vh_starter_set', 'ibuprofen', 'lithium', 'major', 'NSAIDs reduce renal lithium clearance', 'Lithium toxicity', 'Avoid NSAIDs; prefer paracetamol; monitor levels', 'textbook'),
  ('vh_starter_set', 'hydrochlorothiazide', 'lithium', 'major', 'Thiazides reduce lithium clearance', 'Lithium toxicity', 'Avoid or monitor lithium levels closely', 'textbook'),
  ('vh_starter_set', 'amiodarone', 'levofloxacin', 'major', 'Additive QT prolongation', 'Torsades de pointes risk', 'Avoid combination; if unavoidable, ECG monitoring', 'textbook'),
  ('vh_starter_set', 'azithromycin', 'levofloxacin', 'moderate', 'Additive QT prolongation', 'QT prolongation', 'Avoid combination where possible; baseline ECG if combined', 'textbook'),
  ('vh_starter_set', 'ciprofloxacin', 'ondansetron', 'moderate', 'Additive QT prolongation', 'QT prolongation', 'Use lowest effective doses; consider ECG in cardiac patients', 'textbook')
ON CONFLICT (source_key, drug_a_key, drug_b_key) DO NOTHING;

-- Allergy cross-sensitivity groups.
INSERT INTO drug_kb_allergy_groups (source_key, group_key, member_key) VALUES
  ('vh_starter_set', 'penicillins', 'penicillin'),
  ('vh_starter_set', 'penicillins', 'amoxicillin'),
  ('vh_starter_set', 'penicillins', 'amoxiclav'),
  ('vh_starter_set', 'penicillins', 'ampicillin'),
  ('vh_starter_set', 'penicillins', 'cloxacillin'),
  ('vh_starter_set', 'penicillins', 'piperacillin'),
  ('vh_starter_set', 'cephalosporins', 'ceftriaxone'),
  ('vh_starter_set', 'cephalosporins', 'cefixime'),
  ('vh_starter_set', 'cephalosporins', 'cefuroxime'),
  ('vh_starter_set', 'cephalosporins', 'cephalexin'),
  ('vh_starter_set', 'sulfonamides', 'cotrimoxazole'),
  ('vh_starter_set', 'sulfonamides', 'sulfasalazine'),
  ('vh_starter_set', 'nsaids', 'aspirin'),
  ('vh_starter_set', 'nsaids', 'ibuprofen'),
  ('vh_starter_set', 'nsaids', 'diclofenac'),
  ('vh_starter_set', 'nsaids', 'naproxen'),
  ('vh_starter_set', 'nsaids', 'ketorolac'),
  ('vh_starter_set', 'nsaids', 'aceclofenac'),
  ('vh_starter_set', 'nsaids', 'mefenamic acid'),
  ('vh_starter_set', 'opioids', 'morphine'),
  ('vh_starter_set', 'opioids', 'codeine'),
  ('vh_starter_set', 'opioids', 'tramadol')
ON CONFLICT (source_key, group_key, member_key) DO NOTHING;

INSERT INTO drug_kb_allergy_cross_reactivity (source_key, group_key, reacts_with_group_key, risk, note) VALUES
  ('vh_starter_set', 'penicillins', 'cephalosporins', 'moderate', 'Historic 10% figure overstates risk; modern estimate ~1-3%, higher with shared side-chains (e.g. amoxicillin↔cefadroxil). Confirm reaction history.'),
  ('vh_starter_set', 'cephalosporins', 'penicillins', 'moderate', 'Cross-reactivity driven by side-chain similarity; confirm reaction type and severity.')
ON CONFLICT (source_key, group_key, reacts_with_group_key) DO NOTHING;

-- Drug–disease cautions (ICD-10 prefix matched against the B7 problem list).
INSERT INTO drug_kb_condition_cautions (source_key, drug_key, icd10_prefix, condition_label, risk, note) VALUES
  ('vh_starter_set', 'ibuprofen',   'N18', 'Chronic kidney disease', 'contraindicated', 'NSAIDs accelerate CKD progression and precipitate AKI; prefer paracetamol.'),
  ('vh_starter_set', 'diclofenac',  'N18', 'Chronic kidney disease', 'contraindicated', 'NSAIDs accelerate CKD progression; prefer paracetamol.'),
  ('vh_starter_set', 'naproxen',    'N18', 'Chronic kidney disease', 'contraindicated', 'NSAIDs accelerate CKD progression.'),
  ('vh_starter_set', 'ketorolac',   'N18', 'Chronic kidney disease', 'contraindicated', 'High renal risk; avoid in CKD.'),
  ('vh_starter_set', 'aceclofenac', 'N18', 'Chronic kidney disease', 'caution', 'NSAID — avoid where possible in CKD.'),
  ('vh_starter_set', 'metformin',   'N18', 'Chronic kidney disease', 'caution', 'Review eGFR: reduce dose eGFR 30-45, stop <30 (lactic acidosis risk).'),
  ('vh_starter_set', 'spironolactone', 'N18', 'Chronic kidney disease', 'caution', 'Hyperkalaemia risk rises sharply with falling eGFR.'),
  ('vh_starter_set', 'ibuprofen',   'K25', 'Gastric ulcer', 'caution', 'NSAIDs impair mucosal defence; add PPI or avoid.'),
  ('vh_starter_set', 'diclofenac',  'K25', 'Gastric ulcer', 'caution', 'NSAIDs impair mucosal defence; add PPI or avoid.'),
  ('vh_starter_set', 'ibuprofen',   'K26', 'Duodenal ulcer', 'caution', 'NSAIDs impair mucosal defence; add PPI or avoid.'),
  ('vh_starter_set', 'aspirin',     'K25', 'Gastric ulcer', 'caution', 'GI bleeding risk; gastroprotection required.'),
  ('vh_starter_set', 'propranolol', 'J45', 'Asthma', 'contraindicated', 'Non-selective beta-blockade provokes bronchospasm; use cardioselective agent if essential.'),
  ('vh_starter_set', 'tramadol',    'G40', 'Epilepsy', 'caution', 'Lowers seizure threshold.'),
  ('vh_starter_set', 'ciprofloxacin', 'G40', 'Epilepsy', 'caution', 'Fluoroquinolones lower seizure threshold.'),
  ('vh_starter_set', 'valproate',   'K72', 'Hepatic failure', 'contraindicated', 'Hepatotoxic; contraindicated in significant hepatic impairment.'),
  ('vh_starter_set', 'sildenafil',  'I20', 'Angina on nitrates', 'caution', 'Verify the patient is not on nitrate therapy before prescribing.'),
  ('vh_starter_set', 'metformin',   'E87', 'Acidosis/electrolyte disorder', 'caution', 'Lactic acidosis risk in acute metabolic derangement.')
ON CONFLICT (source_key, drug_key, icd10_prefix) DO NOTHING;

-- Dose ceilings (adult flat + paediatric mg/kg/day; conservative).
INSERT INTO drug_kb_dose_ranges (source_key, drug_key, route, population, max_single_dose_mg, max_daily_dose_mg, max_daily_mg_per_kg, min_egfr, egfr_max_daily_mg, note) VALUES
  ('vh_starter_set', 'paracetamol', NULL, 'adult',     1000, 4000, NULL, NULL, NULL, '3g/day ceiling in hepatic disease/low body weight.'),
  ('vh_starter_set', 'paracetamol', NULL, 'pediatric', NULL, NULL, 60, NULL, NULL, '10-15 mg/kg/dose, max 60 mg/kg/day.'),
  ('vh_starter_set', 'ibuprofen',   NULL, 'adult',     800, 2400, NULL, NULL, NULL, NULL),
  ('vh_starter_set', 'ibuprofen',   NULL, 'pediatric', NULL, NULL, 40, NULL, NULL, '5-10 mg/kg/dose, max 40 mg/kg/day.'),
  ('vh_starter_set', 'diclofenac',  NULL, 'adult',     75, 150, NULL, NULL, NULL, NULL),
  ('vh_starter_set', 'tramadol',    NULL, 'adult',     100, 400, NULL, 30, 200, 'Reduce in renal impairment (eGFR<30: max 200mg/day).'),
  ('vh_starter_set', 'metformin',   NULL, 'adult',     1000, 2550, NULL, 30, 1000, 'Stop below eGFR 30; half-dose 30-45.'),
  ('vh_starter_set', 'amoxicillin', NULL, 'adult',     1000, 3000, NULL, NULL, NULL, NULL),
  ('vh_starter_set', 'amoxicillin', NULL, 'pediatric', NULL, NULL, 90, NULL, NULL, 'High-dose regimens up to 90 mg/kg/day.'),
  ('vh_starter_set', 'azithromycin', NULL, 'pediatric', NULL, NULL, 10, NULL, NULL, '10 mg/kg once daily.'),
  ('vh_starter_set', 'atorvastatin', NULL, 'adult',    80, 80, NULL, NULL, NULL, NULL),
  ('vh_starter_set', 'ondansetron', NULL, 'adult',     16, 24, NULL, NULL, NULL, 'Single IV dose capped at 16mg (QT).')
ON CONFLICT DO NOTHING;

-- IV / Y-site compatibility starters.
INSERT INTO drug_kb_iv_compatibility (source_key, drug_a_key, drug_b_key, compatibility, diluent, note) VALUES
  ('vh_starter_set', 'calcium gluconate', 'ceftriaxone', 'incompatible', NULL, 'Fatal calcium-ceftriaxone precipitates reported (neonates: absolute contraindication; others: never same line).'),
  ('vh_starter_set', 'ceftriaxone', 'ringer lactate', 'incompatible', NULL, 'Ringer lactate contains calcium — precipitates with ceftriaxone; use saline.'),
  ('vh_starter_set', 'furosemide', 'midazolam', 'incompatible', NULL, 'pH incompatibility — precipitates at the Y-site.'),
  ('vh_starter_set', 'ceftriaxone', 'vancomycin', 'caution', NULL, 'Physical incompatibility reported at high concentrations; flush line between drugs.'),
  ('vh_starter_set', 'furosemide', 'ondansetron', 'caution', NULL, 'Variable Y-site compatibility; flush between drugs.')
ON CONFLICT DO NOTHING;

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'DRUG_KNOWLEDGE_BASE_APPLIED',
  'drug_kb_sources',
  'drug_kb_sources',
  jsonb_build_object(
    'migration', '277_drug_knowledge_base.sql',
    'roadmap', 'docs/EPIC_LEVEL_ROADMAP.md#B2',
    'reason', 'Drug KB substrate (interactions, allergy cross-sensitivity, drug-disease, dose ranges, IV compatibility) + flagged starter set. Licensed KB import is owner-side via scripts/drug-kb-import.mjs.'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'DRUG_KNOWLEDGE_BASE_APPLIED'
    AND resource = 'drug_kb_sources'
);

COMMIT;
