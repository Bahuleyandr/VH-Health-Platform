-- Migration 160: Newborn / paediatric immunisation schedule (Sprint 7
-- follow-through).
--
-- The newborn record (migration 155) captures BCG / Hep-B / OPV given
-- at birth as boolean flags. That's not enough — Indian National
-- Immunisation Schedule (NIS) and IAP go through ~15 antigen doses
-- over the first 5 years (BCG, Hep-B birth + 6w/10w/14w, OPV 0/1/2/3 +
-- IPV, DTP/DPT primary + booster, Hib, PCV, Rota, Measles/MR, JE in
-- endemic states, vitamin A, etc.). This migration models each dose
-- as its own row so a parent's "due now" view is a simple WHERE.
--
-- Adolescent boosters (Td, HPV, etc.) and adult vaccines are out of
-- scope for this sprint — added when the platform serves school-age +
-- adult patients.

BEGIN;

-- ── 1. Vaccine catalogue (per tenant) ───────────────────────────────
CREATE TABLE IF NOT EXISTS vaccine_catalogue (
  id              SERIAL PRIMARY KEY,
  code            VARCHAR(40) NOT NULL,            -- BCG / HEPB / OPV / DPT / etc.
  display_name    VARCHAR(120) NOT NULL,
  -- Dose number for vaccines with a series (Hep-B 1/2/3, OPV 0/1/2/3,
  -- DPT 1/2/3 + boosters). Null for single-dose vaccines (BCG).
  dose_number     INTEGER,
  -- Recommended age in days from birth. Used to compute due_date.
  recommended_age_days INTEGER NOT NULL,
  -- Window in days the dose can be given (most are 28-day windows).
  window_days     INTEGER NOT NULL DEFAULT 28,
  description     TEXT,
  active          BOOLEAN NOT NULL DEFAULT true,
  tenant_id       UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, code, dose_number)
);

CREATE INDEX IF NOT EXISTS idx_vaccine_catalogue_age
  ON vaccine_catalogue(recommended_age_days, active);

-- Seed Indian NIS + IAP common doses (first 18 months).
INSERT INTO vaccine_catalogue
  (code, display_name, dose_number, recommended_age_days, description)
SELECT v.code, v.name, v.dose, v.age, v.descr
FROM (VALUES
  -- At birth (within 24h)
  ('BCG',   'BCG (Bacille Calmette-Guérin)',          NULL, 0,   'Single dose at birth'),
  ('HEPB',  'Hepatitis B birth dose',                 0,    0,   'Within 24h of birth'),
  ('OPV',   'Oral Polio (zero dose)',                 0,    0,   'OPV-0 within 15 days of birth'),
  -- 6 weeks
  ('DPT',   'DPT (Diphtheria-Pertussis-Tetanus) 1',   1,    42,  '1st DPT dose'),
  ('OPV',   'OPV 1',                                  1,    42,  '1st OPV dose'),
  ('HEPB',  'Hep-B 1',                                1,    42,  '1st Hep-B dose'),
  ('HIB',   'Hib (Haemophilus influenzae type B) 1',  1,    42,  '1st Hib dose'),
  ('PCV',   'PCV (Pneumococcal Conjugate) 1',         1,    42,  '1st PCV dose'),
  ('ROTA',  'Rotavirus 1',                            1,    42,  '1st Rotavirus dose'),
  ('IPV',   'IPV (Inactivated Polio) 1',              1,    42,  'Fractional IPV dose 1'),
  -- 10 weeks
  ('DPT',   'DPT 2',                                  2,    70,  '2nd DPT dose'),
  ('OPV',   'OPV 2',                                  2,    70,  '2nd OPV dose'),
  ('HIB',   'Hib 2',                                  2,    70,  '2nd Hib dose'),
  ('PCV',   'PCV 2',                                  2,    70,  '2nd PCV dose'),
  ('ROTA',  'Rotavirus 2',                            2,    70,  '2nd Rotavirus dose'),
  -- 14 weeks
  ('DPT',   'DPT 3',                                  3,    98,  '3rd DPT dose'),
  ('OPV',   'OPV 3',                                  3,    98,  '3rd OPV dose'),
  ('HEPB',  'Hep-B 3',                                3,    98,  '3rd Hep-B dose'),
  ('HIB',   'Hib 3',                                  3,    98,  '3rd Hib dose'),
  ('PCV',   'PCV 3 (booster)',                        3,    98,  '3rd PCV dose'),
  ('ROTA',  'Rotavirus 3',                            3,    98,  '3rd Rotavirus dose'),
  ('IPV',   'IPV 2 (fractional)',                     2,    98,  'Fractional IPV dose 2'),
  -- 9 months
  ('MR',    'Measles-Rubella (MR) 1',                 1,    274, '1st MR dose at 9 mo'),
  ('JE',    'Japanese Encephalitis 1 (endemic states)', 1,  274, 'Endemic states only'),
  ('VITA',  'Vitamin A — 1st dose',                   1,    274, '1 lakh IU oral'),
  -- 16-24 months
  ('DPT',   'DPT booster 1',                          4,    548, 'DPT booster at 16-24 mo'),
  ('OPV',   'OPV booster',                            4,    548, 'OPV booster'),
  ('MR',    'MR 2',                                   2,    548, '2nd MR dose'),
  ('JE',    'JE 2 (endemic states)',                  2,    548, 'Endemic states only')
) AS v(code, name, dose, age, descr)
WHERE NOT EXISTS (
  SELECT 1 FROM vaccine_catalogue
   WHERE code = v.code
     AND COALESCE(dose_number, -1) = COALESCE(v.dose, -1)
     AND tenant_id = '00000000-0000-4000-8000-000000000001'::uuid
);

-- ── 2. Per-newborn immunisation log ─────────────────────────────────
-- One row per dose. Created upfront when the newborn record is filed
-- (so the schedule is visible day 1) and updated as doses are given.
CREATE TABLE IF NOT EXISTS newborn_immunisations (
  id                  SERIAL PRIMARY KEY,
  newborn_id          INTEGER NOT NULL REFERENCES maternity_newborns(id) ON DELETE CASCADE,
  vaccine_catalogue_id INTEGER NOT NULL REFERENCES vaccine_catalogue(id) ON DELETE RESTRICT,
  due_date            DATE NOT NULL,
  -- Status walk: scheduled → given / missed / refused / contraindicated
  status              VARCHAR(20) NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'given', 'missed', 'refused', 'contraindicated')),
  given_at            TIMESTAMPTZ,
  given_by            UUID,
  given_by_name       VARCHAR(160),
  batch_number        VARCHAR(80),
  manufacturer        VARCHAR(120),
  site_of_injection   VARCHAR(40),                  -- left_thigh / right_thigh / left_deltoid / oral
  -- Optional adverse event capture
  adverse_event       TEXT,
  notes               TEXT,
  tenant_id           UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (newborn_id, vaccine_catalogue_id)
);

CREATE INDEX IF NOT EXISTS idx_newborn_immun_newborn
  ON newborn_immunisations(newborn_id, due_date);
CREATE INDEX IF NOT EXISTS idx_newborn_immun_due
  ON newborn_immunisations(tenant_id, due_date)
  WHERE status = 'scheduled';

COMMIT;
