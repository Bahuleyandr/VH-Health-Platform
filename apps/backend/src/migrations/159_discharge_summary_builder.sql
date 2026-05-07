-- Migration 159: Discharge summary builder (Sprint 11).
--
-- The discharge summary is the single most important document the
-- patient walks out of the hospital with — and historically it's been
-- the worst-quality artifact. A free-form Word doc that the junior
-- doctor types under time pressure, no structure, no template, no
-- continuity if the patient comes back next month.
--
-- This migration models the structured discharge summary that an
-- admin can configure templates for and a doctor fills + signs.
-- Smart-phrase support is already wired (.dischargesummary etc.);
-- the builder gives every section a stable identity so QA + audit
-- can map findings back to specific sections rather than trying to
-- regex a free-form blob.

BEGIN;

-- ── 1. Discharge summary header (one per admission) ─────────────────
CREATE TABLE IF NOT EXISTS discharge_summaries (
  id                     SERIAL PRIMARY KEY,
  admission_id           INTEGER,                    -- admissions(id), nullable for OPD/ER discharges
  patient_uid            UUID NOT NULL,
  -- Header / demographic block (snapshot at discharge time so the
  -- record is reproducible even if the patient's profile is edited
  -- later).
  patient_name_snapshot  VARCHAR(255),
  age_years_snapshot     INTEGER,
  sex_snapshot           VARCHAR(10),
  hospital_number        VARCHAR(80),
  admitted_at            TIMESTAMPTZ,
  discharged_at          TIMESTAMPTZ,
  ward_at_discharge      VARCHAR(80),
  -- Clinical
  primary_diagnosis      TEXT,
  secondary_diagnoses    TEXT[],
  icd10_codes            TEXT[],
  procedures_performed   TEXT[],
  -- Status walk: draft → ready_for_signoff → signed → delivered
  status                 VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'ready_for_signoff', 'signed', 'delivered')),
  signed_by              UUID,
  signed_by_name         VARCHAR(160),
  signed_by_reg          VARCHAR(60),
  signed_at              TIMESTAMPTZ,
  -- Delivery to patient
  delivered_at           TIMESTAMPTZ,
  delivery_method        VARCHAR(20),                -- printed / email / whatsapp / abdm
  -- Audit
  created_by             UUID,
  tenant_id              UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_discharge_summaries_patient
  ON discharge_summaries(patient_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_discharge_summaries_admission
  ON discharge_summaries(admission_id) WHERE admission_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_discharge_summaries_pending
  ON discharge_summaries(tenant_id, status)
  WHERE status IN ('draft', 'ready_for_signoff');

-- ── 2. Sections (key-value, ordered) ────────────────────────────────
-- Sections are stored as separate rows so we can diff edits, audit
-- by section, and let admins reorder/rename templates without a
-- migration.
CREATE TABLE IF NOT EXISTS discharge_summary_sections (
  id                     SERIAL PRIMARY KEY,
  discharge_summary_id   INTEGER NOT NULL REFERENCES discharge_summaries(id) ON DELETE CASCADE,
  section_key            VARCHAR(60) NOT NULL,        -- chief_complaint / hpi / pmh / exam / course / etc.
  section_title          VARCHAR(120) NOT NULL,
  display_order          INTEGER NOT NULL DEFAULT 0,
  body                   TEXT,
  -- Last-edited tracking per section (so we can highlight what
  -- changed between save and signoff).
  edited_by              UUID,
  edited_at              TIMESTAMPTZ,
  UNIQUE (discharge_summary_id, section_key)
);

CREATE INDEX IF NOT EXISTS idx_discharge_sections_summary
  ON discharge_summary_sections(discharge_summary_id, display_order);

-- ── 3. Template (per tenant + specialty) ────────────────────────────
-- Hospital admin defines which sections a discharge summary should
-- have for each specialty. createDischargeSummary copies sections
-- from the matching template.
CREATE TABLE IF NOT EXISTS discharge_summary_templates (
  id              SERIAL PRIMARY KEY,
  code            VARCHAR(60) NOT NULL,
  display_name    VARCHAR(160) NOT NULL,
  specialty       VARCHAR(60),                       -- null = default for tenant
  -- Sections defined inline as JSON for simplicity. Each entry:
  -- { "section_key": "...", "section_title": "...",
  --   "display_order": N, "default_body": "..." (optional) }
  sections        JSONB NOT NULL DEFAULT '[]'::jsonb,
  active          BOOLEAN NOT NULL DEFAULT true,
  tenant_id       UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, code)
);

CREATE INDEX IF NOT EXISTS idx_discharge_templates_specialty
  ON discharge_summary_templates(tenant_id, specialty, active);

-- Seed a sensible default template for general medicine.
INSERT INTO discharge_summary_templates (code, display_name, specialty, sections)
SELECT 'GENERAL_MEDICINE_V1', 'General Medicine — default', 'general_medicine',
       '[
          {"section_key":"chief_complaint","section_title":"Chief Complaint","display_order":1},
          {"section_key":"hpi","section_title":"History of Present Illness","display_order":2},
          {"section_key":"past_history","section_title":"Past Medical / Surgical History","display_order":3},
          {"section_key":"family_history","section_title":"Family History","display_order":4},
          {"section_key":"personal_history","section_title":"Personal History","display_order":5},
          {"section_key":"on_examination","section_title":"On Examination","display_order":6},
          {"section_key":"investigations","section_title":"Investigations","display_order":7,"default_body":"(See lab + imaging attached)"},
          {"section_key":"diagnosis","section_title":"Diagnosis","display_order":8},
          {"section_key":"course_in_hospital","section_title":"Course in Hospital","display_order":9},
          {"section_key":"treatment_given","section_title":"Treatment Given","display_order":10},
          {"section_key":"condition_at_discharge","section_title":"Condition at Discharge","display_order":11,"default_body":"Stable, afebrile, vitals stable, ambulatory."},
          {"section_key":"discharge_medications","section_title":"Discharge Medications","display_order":12},
          {"section_key":"diet_advice","section_title":"Diet & Lifestyle Advice","display_order":13},
          {"section_key":"follow_up","section_title":"Follow-up Plan","display_order":14},
          {"section_key":"red_flags","section_title":"Red Flags — Return to Hospital If","display_order":15,"default_body":"Fever > 38.5°C, breathlessness, chest pain, altered mentation, persistent vomiting, or any sudden worsening."}
        ]'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM discharge_summary_templates
   WHERE code = 'GENERAL_MEDICINE_V1'
     AND tenant_id = '00000000-0000-4000-8000-000000000001'::uuid
);

-- Surgical specialty template — fewer sections, OT-specific blocks.
INSERT INTO discharge_summary_templates (code, display_name, specialty, sections)
SELECT 'SURGICAL_V1', 'Surgical — default', 'general_surgery',
       '[
          {"section_key":"chief_complaint","section_title":"Chief Complaint","display_order":1},
          {"section_key":"diagnosis","section_title":"Diagnosis","display_order":2},
          {"section_key":"procedure","section_title":"Procedure Performed","display_order":3},
          {"section_key":"surgeon","section_title":"Surgeon / Anaesthetist","display_order":4},
          {"section_key":"intraop_findings","section_title":"Intra-operative Findings","display_order":5},
          {"section_key":"postop_course","section_title":"Post-operative Course","display_order":6},
          {"section_key":"condition_at_discharge","section_title":"Condition at Discharge","display_order":7,"default_body":"Wound dry and healthy, sutures in situ, ambulatory."},
          {"section_key":"discharge_medications","section_title":"Discharge Medications","display_order":8},
          {"section_key":"wound_care","section_title":"Wound Care Instructions","display_order":9},
          {"section_key":"diet_advice","section_title":"Diet & Activity Advice","display_order":10},
          {"section_key":"follow_up","section_title":"Follow-up Plan","display_order":11,"default_body":"Suture removal on day 7. OPD review in 2 weeks with reports."},
          {"section_key":"red_flags","section_title":"Red Flags — Return to Hospital If","display_order":12,"default_body":"Wound discharge / redness / bleeding, fever, severe pain, vomiting."}
        ]'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM discharge_summary_templates
   WHERE code = 'SURGICAL_V1'
     AND tenant_id = '00000000-0000-4000-8000-000000000001'::uuid
);

-- Maternity (companion to Sprint 7 deliveries).
INSERT INTO discharge_summary_templates (code, display_name, specialty, sections)
SELECT 'MATERNITY_V1', 'Maternity (post-delivery) — default', 'obg',
       '[
          {"section_key":"obstetric_history","section_title":"Obstetric History","display_order":1,"default_body":"G__P__ A__ L__ at __ weeks gestation."},
          {"section_key":"admission_reason","section_title":"Reason for Admission","display_order":2},
          {"section_key":"labour_summary","section_title":"Labour Summary","display_order":3},
          {"section_key":"delivery","section_title":"Delivery","display_order":4},
          {"section_key":"newborn","section_title":"Newborn Details","display_order":5},
          {"section_key":"postnatal_course","section_title":"Postnatal Course","display_order":6},
          {"section_key":"condition_at_discharge","section_title":"Condition at Discharge","display_order":7,"default_body":"Mother and baby stable, breastfeeding established, voiding normally."},
          {"section_key":"discharge_medications","section_title":"Discharge Medications (Mother)","display_order":8,"default_body":"Iron + folic acid, calcium, paracetamol PRN."},
          {"section_key":"baby_immunisations","section_title":"Baby Immunisations Given","display_order":9,"default_body":"BCG, Hep-B birth dose, OPV-0 — see Mother & Child card."},
          {"section_key":"follow_up","section_title":"Follow-up Plan","display_order":10,"default_body":"Mother — PNC visit at 1 week, 6 weeks. Baby — well-baby clinic at 2 weeks then per immunisation schedule."},
          {"section_key":"red_flags","section_title":"Red Flags — Return Immediately If","display_order":11,"default_body":"Mother: heavy bleeding, fever, severe headache, foul-smelling discharge. Baby: poor feeding, lethargy, jaundice, fever, fast breathing."}
        ]'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM discharge_summary_templates
   WHERE code = 'MATERNITY_V1'
     AND tenant_id = '00000000-0000-4000-8000-000000000001'::uuid
);

COMMIT;
