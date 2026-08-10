-- 648_icu_flowsheet_bounds_code_status_history.sql
--
-- 2026-08-10 full re-review, findings H1 + CLIN-3 (ICU cluster):
--
-- 1. H1 — icu_flowsheet_entries and icu_assessments accepted unbounded
--    values: spo2 990, arbitrary vasopressor rates, SOFA sub-scores of 40.
--    App-level plausibility now lives in utils/clinical/icuPlausibility.js
--    (the friendly 400); these CHECK constraints are the DB backstop with
--    the same bounds. All are added NOT VALID: existing rows written before
--    the gate are grandfathered (validating them would abort the migration
--    on any historical garbage row), while every new INSERT/UPDATE is
--    enforced immediately — exactly the backstop semantics we want
--    (precedent: migrations 478/480/481/594).
--
-- 2. CLIN-3 — icu_admissions.code_status (DNR/DNI/comfort-only) was
--    overwritten in place: flipping full_code -> dnr -> full_code left no
--    trace of the DNR window. New append-only icu_code_status_history table;
--    icuService.updateAdmissionCodeStatus inserts one row per flip in the
--    same transaction as the flip itself. Append-only is enforced with the
--    shared audit_append_only_guard() (migration 324/599 semantics: UPDATE/
--    DELETE blocked unless app.audit_bypass=on or superuser). Existing
--    admissions get one baseline row so the current order is anchored.
--
-- recorded_at plausibility (future/backdate window) is enforced app-side
-- only — a NOW()-relative CHECK would re-evaluate on later row rewrites and
-- is not a stable table invariant.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- ────────────────────────────────────────────────────────────────────
-- 1. Flowsheet bounds (mirrors ICU_FLOWSHEET_BOUNDS in
--    utils/clinical/icuPlausibility.js; NULL always passes — partial
--    hourly entries are a first-class shape).
-- ────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_icu_flowsheet_vitals_plausible') THEN
    ALTER TABLE icu_flowsheet_entries
      ADD CONSTRAINT chk_icu_flowsheet_vitals_plausible CHECK (
        (hr             IS NULL OR (hr             BETWEEN 20  AND 300)) AND
        (sbp            IS NULL OR (sbp            BETWEEN 40  AND 300)) AND
        (dbp            IS NULL OR (dbp            BETWEEN 20  AND 200)) AND
        (map            IS NULL OR (map            BETWEEN 20  AND 250)) AND
        (cvp            IS NULL OR (cvp            BETWEEN -10 AND 60))  AND
        (spo2           IS NULL OR (spo2           BETWEEN 0   AND 100)) AND
        (rr             IS NULL OR (rr             BETWEEN 0   AND 80))  AND
        (temp_c         IS NULL OR (temp_c         BETWEEN 30  AND 45))  AND
        (cap_refill_sec IS NULL OR (cap_refill_sec BETWEEN 0   AND 30))
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_icu_flowsheet_neuro_plausible') THEN
    ALTER TABLE icu_flowsheet_entries
      ADD CONSTRAINT chk_icu_flowsheet_neuro_plausible CHECK (
        (gcs_eye              IS NULL OR (gcs_eye              BETWEEN 1 AND 4))  AND
        (gcs_verbal           IS NULL OR (gcs_verbal           BETWEEN 1 AND 5))  AND
        (gcs_motor            IS NULL OR (gcs_motor            BETWEEN 1 AND 6))  AND
        (pupils_left_size_mm  IS NULL OR (pupils_left_size_mm  BETWEEN 0 AND 12)) AND
        (pupils_right_size_mm IS NULL OR (pupils_right_size_mm BETWEEN 0 AND 12))
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_icu_flowsheet_vent_plausible') THEN
    ALTER TABLE icu_flowsheet_entries
      ADD CONSTRAINT chk_icu_flowsheet_vent_plausible CHECK (
        (fio2_pct                IS NULL OR (fio2_pct                BETWEEN 21 AND 100))  AND
        (peep_cmh2o              IS NULL OR (peep_cmh2o              BETWEEN 0  AND 40))   AND
        (tidal_volume_ml         IS NULL OR (tidal_volume_ml         BETWEEN 0  AND 2000)) AND
        (resp_rate_set           IS NULL OR (resp_rate_set           BETWEEN 0  AND 80))   AND
        (airway_pressure_peak    IS NULL OR (airway_pressure_peak    BETWEEN 0  AND 120))  AND
        (airway_pressure_plateau IS NULL OR (airway_pressure_plateau BETWEEN 0  AND 120))  AND
        (pf_ratio                IS NULL OR (pf_ratio                BETWEEN 0  AND 700))
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_icu_flowsheet_drips_plausible') THEN
    ALTER TABLE icu_flowsheet_entries
      ADD CONSTRAINT chk_icu_flowsheet_drips_plausible CHECK (
        (noradrenaline_mcg_kg_min IS NULL OR (noradrenaline_mcg_kg_min BETWEEN 0 AND 10))   AND
        (adrenaline_mcg_kg_min    IS NULL OR (adrenaline_mcg_kg_min    BETWEEN 0 AND 10))   AND
        (vasopressin_units_hr     IS NULL OR (vasopressin_units_hr     BETWEEN 0 AND 10))   AND
        (dobutamine_mcg_kg_min    IS NULL OR (dobutamine_mcg_kg_min    BETWEEN 0 AND 40))   AND
        (propofol_mcg_kg_min      IS NULL OR (propofol_mcg_kg_min      BETWEEN 0 AND 300))  AND
        (midazolam_mg_hr          IS NULL OR (midazolam_mg_hr          BETWEEN 0 AND 50))   AND
        (fentanyl_mcg_hr          IS NULL OR (fentanyl_mcg_hr          BETWEEN 0 AND 1000)) AND
        (insulin_units_hr         IS NULL OR (insulin_units_hr         BETWEEN 0 AND 100))
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_icu_flowsheet_io_plausible') THEN
    ALTER TABLE icu_flowsheet_entries
      ADD CONSTRAINT chk_icu_flowsheet_io_plausible CHECK (
        (iv_fluids_ml      IS NULL OR (iv_fluids_ml      BETWEEN 0 AND 5000)) AND
        (oral_intake_ml    IS NULL OR (oral_intake_ml    BETWEEN 0 AND 3000)) AND
        (blood_products_ml IS NULL OR (blood_products_ml BETWEEN 0 AND 5000)) AND
        (urine_output_ml   IS NULL OR (urine_output_ml   BETWEEN 0 AND 3000)) AND
        (drain_output_ml   IS NULL OR (drain_output_ml   BETWEEN 0 AND 5000)) AND
        (ng_aspirate_ml    IS NULL OR (ng_aspirate_ml    BETWEEN 0 AND 3000)) AND
        (stool_count       IS NULL OR (stool_count       BETWEEN 0 AND 20))
      ) NOT VALID;
  END IF;

  -- Assessments: RASS -5..4, SOFA sub-scores 0-4 (total 0-24), CPOT
  -- domains 0-2 (total 0-8).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_icu_assessment_scores_plausible') THEN
    ALTER TABLE icu_assessments
      ADD CONSTRAINT chk_icu_assessment_scores_plausible CHECK (
        (rass_score           IS NULL OR (rass_score           BETWEEN -5 AND 4))  AND
        (rass_target          IS NULL OR (rass_target          BETWEEN -5 AND 4))  AND
        (sofa_resp            IS NULL OR (sofa_resp            BETWEEN 0  AND 4))  AND
        (sofa_coag            IS NULL OR (sofa_coag            BETWEEN 0  AND 4))  AND
        (sofa_liver           IS NULL OR (sofa_liver           BETWEEN 0  AND 4))  AND
        (sofa_cardio          IS NULL OR (sofa_cardio          BETWEEN 0  AND 4))  AND
        (sofa_cns             IS NULL OR (sofa_cns             BETWEEN 0  AND 4))  AND
        (sofa_renal           IS NULL OR (sofa_renal           BETWEEN 0  AND 4))  AND
        (sofa_total           IS NULL OR (sofa_total           BETWEEN 0  AND 24)) AND
        (cpot_facial          IS NULL OR (cpot_facial          BETWEEN 0  AND 2))  AND
        (cpot_movement        IS NULL OR (cpot_movement        BETWEEN 0  AND 2))  AND
        (cpot_muscle_tension  IS NULL OR (cpot_muscle_tension  BETWEEN 0  AND 2))  AND
        (cpot_vent_compliance IS NULL OR (cpot_vent_compliance BETWEEN 0  AND 2))  AND
        (cpot_total           IS NULL OR (cpot_total           BETWEEN 0  AND 8))
      ) NOT VALID;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────
-- 2. Append-only code-status (DNR) history
-- ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS icu_code_status_history (
  id                   BIGSERIAL PRIMARY KEY,
  tenant_id            UUID NOT NULL,
  icu_admission_id     INTEGER NOT NULL REFERENCES icu_admissions(id) ON DELETE CASCADE,
  patient_uid          UUID,
  previous_code_status VARCHAR(20)
    CHECK (previous_code_status IS NULL
           OR previous_code_status IN ('full_code', 'dni', 'dnr', 'dnr_dni', 'comfort_only')),
  new_code_status      VARCHAR(20) NOT NULL
    CHECK (new_code_status IN ('full_code', 'dni', 'dnr', 'dnr_dni', 'comfort_only')),
  changed_by           UUID,
  changed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_icu_code_status_history_admission
  ON icu_code_status_history (tenant_id, icu_admission_id, changed_at DESC);

-- Append-only: same guard + semantics as the canonical audit/timeline
-- tables (migrations 324/599).
DROP TRIGGER IF EXISTS trg_icu_code_status_history_append_only
  ON icu_code_status_history;
CREATE TRIGGER trg_icu_code_status_history_append_only
  BEFORE UPDATE OR DELETE ON icu_code_status_history
  FOR EACH ROW EXECUTE FUNCTION audit_append_only_guard();

-- Tenant RLS — canonical tenant_isolation policy (mirrors migration 304).
ALTER TABLE icu_code_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE icu_code_status_history FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'icu_code_status_history'
       AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON icu_code_status_history
      USING (
        current_setting('app.current_tenant_id', true) IS NULL
        OR current_setting('app.current_tenant_id', true) = ''
        OR current_setting('app.current_tenant_id', true) = 'bypass'
        OR tenant_id = app_current_tenant_id_uuid()
      )
      WITH CHECK (
        current_setting('app.current_tenant_id', true) IS NULL
        OR current_setting('app.current_tenant_id', true) = ''
        OR current_setting('app.current_tenant_id', true) = 'bypass'
        OR tenant_id = app_current_tenant_id_uuid()
      );
  END IF;
END $$;

-- Baseline row per existing admission that has a code status on record, so
-- the current order is anchored before the first post-migration flip.
INSERT INTO icu_code_status_history
  (tenant_id, icu_admission_id, patient_uid, previous_code_status, new_code_status, changed_by, changed_at)
SELECT a.tenant_id, a.id, a.patient_uid, NULL, a.code_status,
       a.code_status_set_by, COALESCE(a.code_status_set_at, a.admitted_at)
  FROM icu_admissions a
 WHERE a.code_status IN ('full_code', 'dni', 'dnr', 'dnr_dni', 'comfort_only')
   AND NOT EXISTS (
     SELECT 1 FROM icu_code_status_history h WHERE h.icu_admission_id = a.id
   );

COMMIT;
