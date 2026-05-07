-- Migration 167: Death certification (MCCD Form 4) + mortality review
-- (Sprint 21).
--
-- Two surfaces:
--
-- 1. MCCD — Medical Certificate of Cause of Death, prescribed under
--    the Registration of Births and Deaths Act 1969 (Form 4 for
--    deaths in hospital, Form 4A for deaths outside hospital). The
--    State registrar requires this on the WHO ICD-10 format with
--    Part I (Ia immediate / Ib intermediate / Ic underlying) and
--    Part II (contributory). Format is non-negotiable — the registrar
--    rejects the death registration without it.
--
-- 2. Mortality Review (M&M) — peer review case-by-case to classify
--    preventability, system factors, and learning points. NABH
--    accreditation requires this for every hospital death.

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- DEATH RECORD + MCCD
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS death_records (
  id                          SERIAL PRIMARY KEY,
  patient_uid                 UUID NOT NULL,
  admission_id                INTEGER,
  -- Per-tenant MCCD serial issued by the certifier on submission
  mccd_serial                 VARCHAR(40),

  -- Death event
  date_of_death               DATE NOT NULL,
  time_of_death               TIME NOT NULL,
  place_of_death              VARCHAR(40) NOT NULL DEFAULT 'inpatient'
    CHECK (place_of_death IN ('inpatient', 'emergency', 'icu', 'or', 'home_brought_dead', 'transferred_out_dead')),
  ward_or_unit                VARCHAR(80),

  -- Cause of death — WHO ICD-10 format. Part I is the immediate →
  -- underlying chain. Part II is contributory (does not lead directly
  -- to death but contributed). The State registrar wants free-text
  -- + ICD-10 codes both.
  cause_part_1a               TEXT NOT NULL,        -- immediate cause
  icd10_part_1a               VARCHAR(10),
  cause_part_1b               TEXT,                 -- intermediate
  icd10_part_1b               VARCHAR(10),
  cause_part_1c               TEXT,                 -- underlying (the "started it all" cause)
  icd10_part_1c               VARCHAR(10),
  cause_part_2                TEXT,                 -- contributory
  icd10_part_2                VARCHAR(10),

  -- Manner of death — required by the form
  manner_of_death             VARCHAR(20) NOT NULL DEFAULT 'natural'
    CHECK (manner_of_death IN ('natural', 'accident', 'suicide', 'homicide', 'pending', 'undetermined')),

  -- Special situations
  was_pregnancy_related       BOOLEAN NOT NULL DEFAULT false,
  pregnancy_stage             VARCHAR(40),          -- 'antenatal' / 'intrapartum' / 'postpartum_42d' / 'na'
  was_postsurgery             BOOLEAN NOT NULL DEFAULT false,
  surgery_within_30d          BOOLEAN NOT NULL DEFAULT false,

  -- Coronial / police interest — when any of these are true, body
  -- cannot be released without police clearance under CrPC §174.
  is_medicolegal              BOOLEAN NOT NULL DEFAULT false,
  police_station              VARCHAR(120),
  police_fir_no               VARCHAR(60),
  police_clearance_at         TIMESTAMPTZ,
  postmortem_required         BOOLEAN NOT NULL DEFAULT false,
  postmortem_completed_at     TIMESTAMPTZ,

  -- Body release
  body_released_at            TIMESTAMPTZ,
  body_released_to_name       VARCHAR(160),
  body_released_to_relation   VARCHAR(40),
  body_released_to_id_proof   VARCHAR(60),          -- Aadhaar last 4 / passport no
  body_release_witnessed_by   UUID,
  body_release_method         VARCHAR(20),          -- 'family' / 'mortuary_van' / 'unclaimed_to_municipality'

  -- Certification (the doctor who signs Form 4)
  certified_by                UUID,
  certified_by_name           VARCHAR(160),
  certifier_registration_no   VARCHAR(60),          -- MCI / state council
  certified_at                TIMESTAMPTZ,

  -- Workflow
  status                      VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'certified', 'submitted_to_registrar', 'registered', 'cancelled')),
  registrar_acknowledgement_no VARCHAR(60),
  registered_at               TIMESTAMPTZ,

  notes                       TEXT,

  tenant_id                   UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, mccd_serial)
);

CREATE INDEX IF NOT EXISTS idx_death_records_status
  ON death_records(tenant_id, status, date_of_death DESC);
CREATE INDEX IF NOT EXISTS idx_death_records_patient
  ON death_records(patient_uid);
CREATE INDEX IF NOT EXISTS idx_death_records_pending_release
  ON death_records(tenant_id) WHERE body_released_at IS NULL;

-- Per-tenant MCCD serial counter
CREATE TABLE IF NOT EXISTS mccd_serial_counter (
  tenant_id   UUID PRIMARY KEY,
  next_serial INTEGER NOT NULL DEFAULT 1
);

-- ════════════════════════════════════════════════════════════════════
-- MORTALITY REVIEW (M&M)
-- ════════════════════════════════════════════════════════════════════
--
-- One review per death record (NABH requires every death to be
-- reviewed within 7 days). Multiple reviewers contribute findings.

CREATE TABLE IF NOT EXISTS mortality_reviews (
  id                          SERIAL PRIMARY KEY,
  death_record_id             INTEGER NOT NULL REFERENCES death_records(id) ON DELETE CASCADE,
  review_date                 DATE NOT NULL DEFAULT CURRENT_DATE,
  scheduled_for               DATE,                 -- M&M committee meeting date

  -- Classification (consensus output of the meeting)
  preventability              VARCHAR(20)            -- 'not_preventable' / 'possibly_preventable' / 'probably_preventable' / 'definitely_preventable'
    CHECK (preventability IN ('not_preventable', 'possibly_preventable', 'probably_preventable', 'definitely_preventable')),
  cause_classification        VARCHAR(40),           -- 'disease_progression' / 'complication_of_treatment' / 'medication_error' / 'surgical_complication' / 'system_failure' / 'comorbidity'
  -- Key contributing factors (NABH categories — pick all that apply)
  factor_disease              BOOLEAN NOT NULL DEFAULT false,
  factor_communication        BOOLEAN NOT NULL DEFAULT false,
  factor_documentation        BOOLEAN NOT NULL DEFAULT false,
  factor_diagnostic_delay     BOOLEAN NOT NULL DEFAULT false,
  factor_treatment_delay      BOOLEAN NOT NULL DEFAULT false,
  factor_medication           BOOLEAN NOT NULL DEFAULT false,
  factor_procedural           BOOLEAN NOT NULL DEFAULT false,
  factor_supervision          BOOLEAN NOT NULL DEFAULT false,
  factor_resource             BOOLEAN NOT NULL DEFAULT false,    -- staffing / equipment
  factor_handover             BOOLEAN NOT NULL DEFAULT false,
  -- Free-text discussion + lessons
  discussion_summary          TEXT,
  learning_points             TEXT,
  -- Action items (string[] — short list for tracking)
  action_items                TEXT[],
  presented_by                UUID,
  presented_by_name           VARCHAR(160),
  -- Committee chair sign-off
  finalised_by                UUID,
  finalised_at                TIMESTAMPTZ,

  status                      VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'scheduled', 'reviewed', 'finalised', 'archived')),

  tenant_id                   UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mortality_reviews_dr
  ON mortality_reviews(death_record_id);
CREATE INDEX IF NOT EXISTS idx_mortality_reviews_status
  ON mortality_reviews(tenant_id, status, review_date DESC);

-- 30-day rolling stats — for ICU / ward / hospital quality dashboards
CREATE OR REPLACE VIEW mortality_30d_summary AS
SELECT
  d.tenant_id,
  COUNT(*)::int                                    AS total_deaths,
  COUNT(*) FILTER (WHERE d.status = 'registered')::int AS registered_count,
  COUNT(*) FILTER (WHERE d.is_medicolegal)::int    AS medicolegal_count,
  COUNT(*) FILTER (WHERE d.was_pregnancy_related)::int AS maternal_deaths,
  COUNT(*) FILTER (WHERE d.surgery_within_30d)::int AS surgical_30d_deaths,
  COUNT(r.id)::int                                 AS reviews_done,
  COUNT(r.id) FILTER (WHERE r.preventability IN ('possibly_preventable', 'probably_preventable', 'definitely_preventable'))::int
                                                   AS reviews_preventable
FROM death_records d
LEFT JOIN mortality_reviews r ON r.death_record_id = d.id
WHERE d.date_of_death > CURRENT_DATE - INTERVAL '30 days'
GROUP BY d.tenant_id;

COMMIT;
