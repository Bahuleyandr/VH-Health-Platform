-- 230_daycare_ophthalmology_template_and_readmission_link.sql
--
-- Two surgical-day-care gaps from the 2026-05-10 triage cluster
-- (Stage-5 chip 7):
--
--  1. Day-care ophthalmology discharge template. Findings
--     2026-05-10-surgical-day-care-discharge-no-daycare-ophthalmology-template
--     and 2026-05-10-surgical-day-care-patient-postop-restriction-duration-missing
--     (same root cause). The discharge summary builder (migration 159)
--     only seeds GENERAL_MEDICINE_V1 / SURGICAL_V1 / MATERNITY_V1, so a
--     same-day cataract / day-care eye patient has no concise
--     eye-specific template — staff fall back to the generic surgical
--     template and inherit wrong defaults (suture removal, wound care),
--     and post-op restrictions like the 1-week dust/bending avoidance
--     have nowhere structured to live. This seeds
--     DAYCARE_OPHTHALMOLOGY_V1.
--
--     IMPORTANT — clinical content is a DRAFT, not final. The section
--     STRUCTURE (which sections exist, their order and titles) is
--     final. Every clinical instruction / duration in a section
--     default_body is wrapped "[PLACEHOLDER — ophthalmology clinical
--     review required]" and carries the triage finding's *suggested*
--     value clearly marked as a draft. An ophthalmologist must review
--     and sign off the wording and the durations before the template
--     is used unedited — a wrong "1 week" vs "2 weeks" is a
--     patient-safety error.
--
--  2. Re-admission continuity link. Finding
--     2026-05-10-surgical-day-care-discharge-readmit-continuity-unlinked.
--     admissions has from_er_visit_id but no way to link a re-admission
--     to the prior discharge. A patient re-admitted within 7 days of
--     discharge loses the continuity thread (recent summary, medication
--     changes, unresolved follow-up). This adds a nullable
--     self-referential prior_admission_id FK;
--     admissionService.admitPatient populates it when a recent prior
--     discharge exists for the same patient.

BEGIN;

-- ── 1. Day-care ophthalmology discharge summary template ────────────
-- Mirrors the shape of the migration-159 seeds (SURGICAL_V1 etc.).
-- specialty='ophthalmology' so listTemplates/pickTemplate resolve it
-- for cataract / same-day eye discharges.
INSERT INTO discharge_summary_templates (code, display_name, specialty, sections)
SELECT 'DAYCARE_OPHTHALMOLOGY_V1',
       'Day-care Ophthalmology (cataract / same-day) — default',
       'ophthalmology',
       '[
          {"section_key":"procedure","section_title":"Procedure Performed","display_order":1},
          {"section_key":"eye_operated","section_title":"Eye Operated (RE / LE)","display_order":2},
          {"section_key":"intraop_summary","section_title":"Intra-operative Summary","display_order":3},
          {"section_key":"condition_at_discharge","section_title":"Condition at Discharge","display_order":4,"default_body":"Comfortable, eye shield in place, reviewed and fit for same-day discharge."},
          {"section_key":"postop_restrictions","section_title":"Post-operative Restrictions","display_order":5,"default_body":"[PLACEHOLDER — ophthalmology clinical review required] Suggested draft (NOT final — requires operating-surgeon sign-off): Keep the eye shield on overnight and while sleeping. Do not rub, press, or splash water into the operated eye. Avoid bending below waist level, straining, and dusty environments for 1 week. Avoid head bath for 1 week. No heavy lifting or driving until reviewed. The restriction durations above are a draft and must be confirmed by the operating surgeon."},
          {"section_key":"eye_drop_schedule","section_title":"Eye Drop Schedule","display_order":6,"default_body":"[PLACEHOLDER — ophthalmology clinical review required] Suggested draft (NOT final — requires operating-surgeon sign-off): Antibiotic and steroid eye drops in the operated eye on a tapering schedule. Exact drug names, frequency, and taper duration to be filled in by the operating surgeon."},
          {"section_key":"discharge_medications","section_title":"Discharge Medications","display_order":7},
          {"section_key":"follow_up","section_title":"Follow-up Plan","display_order":8,"default_body":"[PLACEHOLDER — ophthalmology clinical review required] Suggested draft (NOT final — requires operating-surgeon sign-off): POD-1 review on the morning after surgery. Further reviews per surgeon (commonly at 1 week and 4 weeks)."},
          {"section_key":"red_flags","section_title":"Eye Warning Signs — Return to Hospital Immediately If","display_order":9,"default_body":"[PLACEHOLDER — ophthalmology clinical review required] Suggested draft (NOT final — requires operating-surgeon sign-off): Sudden loss or drop in vision, increasing eye pain not relieved by prescribed medication, increasing redness, discharge or watering from the eye, new flashes or floaters, or fever."}
        ]'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM discharge_summary_templates
   WHERE code = 'DAYCARE_OPHTHALMOLOGY_V1'
     AND tenant_id = '00000000-0000-4000-8000-000000000001'::uuid
);

-- ── 2. Re-admission continuity link on admissions ───────────────────
ALTER TABLE admissions
  -- Self-referential FK to the prior admission. ON DELETE SET NULL
  -- preserves the re-admission row's audit trail if the prior
  -- admission is ever deleted/archived. Mirrors from_er_visit_id
  -- (migration 170). Populated by admissionService.admitPatient when a
  -- recent prior discharge for the same patient is found.
  ADD COLUMN IF NOT EXISTS prior_admission_id INTEGER
    REFERENCES admissions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_admissions_prior_admission
  ON admissions(prior_admission_id)
  WHERE prior_admission_id IS NOT NULL;

COMMIT;
