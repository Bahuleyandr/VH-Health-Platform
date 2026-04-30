-- Migration 111: seed canonical clinical protocols.
--
-- Migration 093 created the clinical_protocols table but left it empty,
-- which meant cdsEngine.getProtocolReminders never produced a single
-- protocol-reminder alert in production. The protocol-reminder pass is
-- visible in the CDS UI but silently inactive without seed data.
--
-- This migration seeds six widely-accepted protocols every Indian general
-- hospital is expected to have on day 1. Each is keyed off public,
-- citation-attributed guidance:
--
--   1. Sepsis 1-hour bundle
--      Source: Surviving Sepsis Campaign 2021 (Crit Care Med 2021;49:e1063)
--   2. VTE prophylaxis
--      Source: NICE NG89 (2018), ACCP CHEST 2012
--   3. Hospital-acquired DVT screening
--      Source: NICE NG158 (2020), ACP 2007
--   4. ARDS lung-protective ventilation
--      Source: ARDSNet (NEJM 2000;342:1301), Berlin definition (JAMA 2012)
--   5. ICU SBAR handover
--      Source: Joint Commission Sentinel Event Alert 58, IHI SBAR
--   6. ED-to-ward handover
--      Source: SHARED protocol (BMJ Qual Saf 2017;26:949)
--
-- These are decision-support reminders, not autonomous orders. Every
-- alert routes through cds_alerts where a clinician acknowledges or
-- overrides; canOverride=true on every recommendation. None bypasses
-- normal sign-off.
--
-- Idempotency: a unique index on `name` is added so re-applying this
-- migration (or layering customer-specific overrides in a later
-- migration) is safe. ON CONFLICT (name) DO NOTHING preserves any
-- post-seed edits the hospital may have made to fine-tune a protocol.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS uq_clinical_protocols_name
  ON clinical_protocols (name);

INSERT INTO clinical_protocols
  (name, category, trigger_conditions, recommendations, priority)
VALUES
  -- ── 1. Sepsis 1-hour bundle (SSC 2021) ─────────────────────────────
  (
    'Sepsis 1-hour bundle',
    'sepsis',
    '{
      "is_admitted": true,
      "diagnosis_contains": ["sepsis", "septic shock", "septicemia", "severe sepsis"]
    }'::jsonb,
    '{
      "tests": ["lactate", "blood culture"],
      "medications": ["broad-spectrum antibiotic", "crystalloid"],
      "actions": [
        "Reassess MAP after 30 mL/kg crystalloid; start vasopressor (norepinephrine first-line) if MAP <65 mmHg",
        "Repeat lactate within 2-4 hours if initial >2 mmol/L"
      ]
    }'::jsonb,
    'high'
  ),

  -- ── 2. VTE prophylaxis (NICE NG89, ACCP 2012) ──────────────────────
  (
    'VTE prophylaxis on admission',
    'vte_prophylaxis',
    '{
      "is_admitted": true,
      "days_admitted_gte": 1
    }'::jsonb,
    '{
      "actions": [
        "Document VTE risk score (Caprini for surgical, Padua for medical patients)",
        "Order pharmacological prophylaxis (e.g. enoxaparin 40 mg SC OD or UFH 5000 IU SC TDS) unless bleeding risk contraindicates",
        "Apply mechanical prophylaxis (graduated compression stockings or intermittent pneumatic compression) when pharmacological is contraindicated or as adjunct"
      ]
    }'::jsonb,
    'high'
  ),

  -- ── 3. Hospital-acquired DVT screening (NICE NG158) ────────────────
  (
    'Suspected DVT workup',
    'dvt_screening',
    '{
      "is_admitted": true,
      "chief_complaint_contains": [
        "leg swelling",
        "calf pain",
        "calf swelling",
        "unilateral leg edema",
        "lower limb pain"
      ]
    }'::jsonb,
    '{
      "tests": ["d-dimer", "venous doppler"],
      "actions": [
        "Calculate two-level Wells score for DVT probability",
        "If Wells >=2 (likely): proximal-leg compression ultrasound within 4 hours; if cannot do within 4 hours, give interim parenteral anticoagulant",
        "If Wells <=1 (unlikely): age-adjusted D-dimer; positive triggers ultrasound, negative excludes DVT"
      ]
    }'::jsonb,
    'medium'
  ),

  -- ── 4. ARDS lung-protective ventilation (ARDSNet, Berlin) ──────────
  (
    'ARDS lung-protective ventilation',
    'ards_ventilation',
    '{
      "is_admitted": true,
      "department": ["icu", "critical care", "ccu"],
      "diagnosis_contains": [
        "ards",
        "acute respiratory distress",
        "respiratory failure",
        "hypoxic respiratory failure"
      ]
    }'::jsonb,
    '{
      "actions": [
        "Set tidal volume to 6 mL/kg predicted body weight; reduce to 4 mL/kg if plateau pressure exceeds 30 cmH2O",
        "Maintain plateau pressure <=30 cmH2O on volume-control ventilation",
        "Titrate PEEP and FiO2 per the ARDSNet low/high PEEP table to keep SpO2 88-95% or PaO2 55-80 mmHg",
        "Consider prone positioning >=12 hours/day if PaO2/FiO2 <150 on PEEP >=5 cmH2O",
        "Conservative fluid balance once shock is resolved"
      ]
    }'::jsonb,
    'high'
  ),

  -- ── 5. ICU SBAR handover (Joint Commission, IHI) ───────────────────
  (
    'ICU shift handover (SBAR)',
    'icu_handover',
    '{
      "is_admitted": true,
      "department": ["icu", "critical care", "ccu", "nicu", "picu"],
      "days_admitted_gte": 1
    }'::jsonb,
    '{
      "actions": [
        "Complete structured SBAR handover (Situation, Background, Assessment, Recommendation) at every shift change",
        "Confirm and document current code status with primary team or surrogate decision-maker",
        "Review goals of care and any new family conversations for the next 24 hours",
        "Hand over active drips, ventilator settings, pending procedures, and time-sensitive cultures"
      ]
    }'::jsonb,
    'medium'
  ),

  -- ── 6. ED-to-ward handover (SHARED) ────────────────────────────────
  (
    'ED-to-ward handover (SHARED)',
    'ed_handover',
    '{
      "is_admitted": true,
      "admission_type": ["emergency", "inpatient", "urgent"],
      "days_admitted_gte": 0
    }'::jsonb,
    '{
      "actions": [
        "Document chief complaint summary and ED working diagnosis on the inpatient record",
        "List pending investigations (labs, imaging, cultures) that the ward team must follow up",
        "Reconcile and document all medications administered or changed in the ED",
        "Confirm allergies, code status, and any active isolation precautions on the ward chart",
        "Capture vital-sign trends from triage through ED disposition"
      ]
    }'::jsonb,
    'medium'
  )
ON CONFLICT (name) DO NOTHING;

COMMIT;
