-- Migration 155: Maternity workflow — antenatal, partograph, delivery,
-- newborn record, postnatal (Sprint 7).
--
-- Maternity is one of the highest-volume departments in any Indian
-- hospital and today it's almost entirely paper-driven. The decision-
-- support obstetric_risk_assistant table (migration 051) covers AI
-- assessments only; the actual operational records — partograph charts
-- the nurse fills every 30 minutes during labour, delivery summary,
-- newborn record with Apgar — were never modelled.
--
-- Tables added here (all tenant-scoped):
--
--   1. maternity_pregnancies          — one row per pregnancy. Links
--                                       to patient_uid (mother) and
--                                       carries gravida/parity, LMP,
--                                       EDD, blood group + Rh, booked
--                                       at our hospital y/n.
--   2. maternity_anc_visits           — every antenatal clinic visit
--                                       (multiple per pregnancy).
--   3. maternity_labor_admissions     — one row when a pregnant patient
--                                       presents in labour or for
--                                       induction. Links to
--                                       ip_admissions.
--   4. maternity_partograph_entries   — labour monitoring chart, one
--                                       row per assessment cycle
--                                       (typically every 30 min).
--   5. maternity_deliveries           — outcome row (mode, stage
--                                       durations, blood loss,
--                                       placenta, perineum, etc.).
--   6. maternity_newborns             — newborn record (one row per
--                                       baby; multiples handled).
--   7. maternity_apgar_scores         — Apgar at 1/5/10 minutes per
--                                       newborn.
--   8. maternity_postnatal_visits     — mother + baby PNC visits.

BEGIN;

-- ── 1. Pregnancy episode ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS maternity_pregnancies (
  id                    SERIAL PRIMARY KEY,
  patient_uid           UUID NOT NULL,                 -- mother
  pregnancy_number      INTEGER NOT NULL DEFAULT 1,    -- gravida-style; for tracking multiple pregnancies over time
  lmp_date              DATE,                          -- last menstrual period
  edd_date              DATE,                          -- estimated due date (Naegele's or USG-corrected)
  edd_method            VARCHAR(20)                    -- lmp / usg / mixed
    CHECK (edd_method IS NULL OR edd_method IN ('lmp', 'usg', 'mixed')),
  gravida               INTEGER NOT NULL DEFAULT 1,
  parity                INTEGER NOT NULL DEFAULT 0,
  living_children       INTEGER NOT NULL DEFAULT 0,
  abortions             INTEGER NOT NULL DEFAULT 0,
  blood_group           VARCHAR(5),                    -- A+, B-, O+, AB+, etc.
  rh_factor             VARCHAR(8),                    -- positive / negative
  booking_status        VARCHAR(20) NOT NULL DEFAULT 'booked'
    CHECK (booking_status IN ('booked', 'unbooked', 'transferred_in', 'transferred_out')),
  booking_visit_date    DATE,
  high_risk             BOOLEAN NOT NULL DEFAULT false,
  high_risk_reasons     TEXT[],                        -- multi-tag: gdm, pih, anaemia, pre_eclampsia, prior_lscs, etc.
  status                VARCHAR(20) NOT NULL DEFAULT 'ongoing'
    CHECK (status IN ('ongoing', 'delivered', 'aborted', 'still_birth', 'transferred')),
  notes                 TEXT,
  created_by            UUID,
  tenant_id             UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_maternity_pregnancies_patient
  ON maternity_pregnancies(patient_uid, status);
CREATE INDEX IF NOT EXISTS idx_maternity_pregnancies_edd
  ON maternity_pregnancies(edd_date) WHERE status = 'ongoing';

-- ── 2. Antenatal visits ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS maternity_anc_visits (
  id                    SERIAL PRIMARY KEY,
  pregnancy_id          INTEGER NOT NULL REFERENCES maternity_pregnancies(id) ON DELETE CASCADE,
  visit_date            DATE NOT NULL,
  gestational_age_weeks NUMERIC(4, 1),
  weight_kg             NUMERIC(5, 2),
  bp_systolic           INTEGER,
  bp_diastolic          INTEGER,
  pulse_bpm             INTEGER,
  fundal_height_cm      INTEGER,
  fetal_heart_rate_bpm  INTEGER,
  fetal_movements_felt  BOOLEAN,
  presentation          VARCHAR(20),                   -- cephalic / breech / transverse / unstable
  edema                 VARCHAR(20),                   -- none / mild / moderate / severe
  pallor                VARCHAR(20),                   -- none / mild / moderate / severe
  hb_gm_dl              NUMERIC(4, 1),                 -- hemoglobin
  urine_albumin         VARCHAR(10),                   -- nil / trace / 1+ / 2+ / 3+
  urine_sugar           VARCHAR(10),                   -- nil / trace / 1+ / 2+ / 3+
  iron_folic_acid_given BOOLEAN NOT NULL DEFAULT false,
  calcium_given         BOOLEAN NOT NULL DEFAULT false,
  tt_dose               VARCHAR(20),                   -- tt1 / tt2 / booster / none
  next_visit_date       DATE,
  notes                 TEXT,
  recorded_by           UUID,
  tenant_id             UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_maternity_anc_pregnancy
  ON maternity_anc_visits(pregnancy_id, visit_date DESC);

-- ── 3. Labor admission ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS maternity_labor_admissions (
  id                    SERIAL PRIMARY KEY,
  pregnancy_id          INTEGER NOT NULL REFERENCES maternity_pregnancies(id) ON DELETE CASCADE,
  admission_id          INTEGER,                       -- ip_admissions(id)
  admitted_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  admission_reason      VARCHAR(40)
    CHECK (admission_reason IS NULL OR admission_reason IN (
      'spontaneous_labour', 'induction', 'elective_lscs', 'pprom',
      'reduced_fm', 'postdated', 'other'
    )),
  gestational_age_weeks NUMERIC(4, 1),
  membrane_status       VARCHAR(20),                   -- intact / ruptured_clear / ruptured_meconium / ruptured_blood
  membranes_ruptured_at TIMESTAMPTZ,
  cervix_dilation_cm    NUMERIC(3, 1),                 -- on admission
  cervix_effacement_pct INTEGER,
  station               VARCHAR(10),                   -- -3, -2, -1, 0, +1, +2, +3
  presentation          VARCHAR(20),
  fetal_heart_rate_bpm  INTEGER,
  contractions_per_10min INTEGER,
  labor_started_at      TIMESTAMPTZ,
  status                VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'delivered', 'transferred', 'discharged_undelivered')),
  notes                 TEXT,
  attending_obstetrician UUID,
  attending_midwife     UUID,
  tenant_id             UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_maternity_labor_pregnancy
  ON maternity_labor_admissions(pregnancy_id);
CREATE INDEX IF NOT EXISTS idx_maternity_labor_active
  ON maternity_labor_admissions(tenant_id, status, admitted_at DESC)
  WHERE status = 'active';

-- ── 4. Partograph entries (WHO modified partograph) ─────────────────
-- Recorded every 30 minutes during active labour. The alert/action
-- lines on a paper partograph are computed from the cervical
-- dilatation × time slope; we keep the raw and let the UI overlay
-- alert/action/expected dilatation.
CREATE TABLE IF NOT EXISTS maternity_partograph_entries (
  id                       SERIAL PRIMARY KEY,
  labor_admission_id       INTEGER NOT NULL REFERENCES maternity_labor_admissions(id) ON DELETE CASCADE,
  recorded_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Maternal vitals
  bp_systolic              INTEGER,
  bp_diastolic             INTEGER,
  pulse_bpm                INTEGER,
  temperature_c            NUMERIC(4, 1),
  urine_output_ml          INTEGER,
  urine_protein            VARCHAR(10),
  urine_acetone            VARCHAR(10),
  -- Labour progress
  cervix_dilation_cm       NUMERIC(3, 1),
  descent_fifths_above_brim INTEGER CHECK (descent_fifths_above_brim BETWEEN 0 AND 5),
  contractions_per_10min   INTEGER,
  contractions_duration_sec INTEGER,                   -- weak < 20s, moderate 20-40s, strong > 40s
  contractions_intensity   VARCHAR(10)                 -- weak / moderate / strong
    CHECK (contractions_intensity IS NULL OR contractions_intensity IN ('weak','moderate','strong')),
  -- Fetal status
  fetal_heart_rate_bpm     INTEGER,
  fetal_decel              VARCHAR(20),                -- none / early / late / variable
  amniotic_fluid           VARCHAR(20),                -- intact_membranes / clear / meconium_thin / meconium_thick / blood
  moulding                 VARCHAR(10),                -- 0 / 1+ / 2+ / 3+
  -- Drugs / fluids
  oxytocin_units_l         NUMERIC(4, 2),
  oxytocin_drops_min       INTEGER,
  drugs_given              TEXT,                       -- free-text additional meds
  iv_fluids                TEXT,
  -- Cross-zone alerting (computed elsewhere; surfaced here)
  on_alert_line            BOOLEAN,                    -- crossed alert line
  on_action_line           BOOLEAN,                    -- crossed action line — escalate
  notes                    TEXT,
  recorded_by              UUID,
  tenant_id                UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_maternity_partograph_labor
  ON maternity_partograph_entries(labor_admission_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_maternity_partograph_alert
  ON maternity_partograph_entries(labor_admission_id)
  WHERE on_action_line = true;

-- ── 5. Delivery summary ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS maternity_deliveries (
  id                       SERIAL PRIMARY KEY,
  pregnancy_id             INTEGER NOT NULL REFERENCES maternity_pregnancies(id) ON DELETE CASCADE,
  labor_admission_id       INTEGER REFERENCES maternity_labor_admissions(id) ON DELETE SET NULL,
  delivery_datetime        TIMESTAMPTZ NOT NULL,
  delivery_mode            VARCHAR(30) NOT NULL
    CHECK (delivery_mode IN ('nvd', 'lscs_emergency', 'lscs_elective',
                             'instrumental_forceps', 'instrumental_vacuum',
                             'breech', 'destructive', 'other')),
  -- Stage durations (minutes)
  stage1_duration_min      INTEGER,
  stage2_duration_min      INTEGER,
  stage3_duration_min      INTEGER,
  -- Maternal management
  episiotomy               BOOLEAN NOT NULL DEFAULT false,
  perineal_tear_grade      VARCHAR(10),                -- 1st / 2nd / 3rd / 4th / nil
  perineal_repair_done     BOOLEAN NOT NULL DEFAULT false,
  blood_loss_ml            INTEGER,
  pph_diagnosed            BOOLEAN NOT NULL DEFAULT false,
  pph_treatment            TEXT,
  -- Placenta
  placenta_delivered_at    TIMESTAMPTZ,
  placenta_method          VARCHAR(20),                -- ccm / mannual / ced / other
  placenta_complete        BOOLEAN,
  cord_around_neck         BOOLEAN NOT NULL DEFAULT false,
  cord_loops_count         INTEGER DEFAULT 0,
  -- Anesthesia / analgesia used during delivery
  anesthesia_type          VARCHAR(30),                -- spinal / epidural / ga / la / none
  -- Maternal complications
  complications            TEXT,
  -- Personnel
  delivered_by             UUID,
  delivered_by_name        VARCHAR(160),
  pediatrician_present     BOOLEAN NOT NULL DEFAULT false,
  pediatrician_uid         UUID,
  notes                    TEXT,
  tenant_id                UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_maternity_deliveries_pregnancy
  ON maternity_deliveries(pregnancy_id);
CREATE INDEX IF NOT EXISTS idx_maternity_deliveries_date
  ON maternity_deliveries(delivery_datetime DESC);
CREATE INDEX IF NOT EXISTS idx_maternity_deliveries_pph
  ON maternity_deliveries(tenant_id) WHERE pph_diagnosed = true;

-- ── 6. Newborn record ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS maternity_newborns (
  id                       SERIAL PRIMARY KEY,
  delivery_id              INTEGER NOT NULL REFERENCES maternity_deliveries(id) ON DELETE CASCADE,
  birth_order              INTEGER NOT NULL DEFAULT 1, -- 1, 2, 3 for multiples
  birth_datetime           TIMESTAMPTZ NOT NULL,
  sex                      VARCHAR(10) CHECK (sex IS NULL OR sex IN ('male','female','intersex','indeterminate')),
  birth_weight_g           INTEGER,
  birth_length_cm          NUMERIC(4, 1),
  head_circumference_cm    NUMERIC(4, 1),
  chest_circumference_cm   NUMERIC(4, 1),
  gestational_age_weeks    NUMERIC(4, 1),
  -- Outcome
  outcome                  VARCHAR(20) NOT NULL DEFAULT 'live'
    CHECK (outcome IN ('live', 'fresh_still_birth', 'macerated_still_birth', 'early_neonatal_death')),
  resuscitation_done       BOOLEAN NOT NULL DEFAULT false,
  resuscitation_type       VARCHAR(40),                -- routine / bag_mask / intubation / cpr / surfactant
  -- Newborn linked to a future patient_uid (created later if outcome=live)
  newborn_patient_uid      UUID,
  -- Initial care
  cord_clamped_at_min      NUMERIC(4, 1),              -- minutes after delivery (delayed cord clamping practice)
  skin_to_skin_done        BOOLEAN NOT NULL DEFAULT false,
  breastfeeding_initiated_min INTEGER,                 -- minutes after birth; <60 = early initiation
  vit_k_given              BOOLEAN NOT NULL DEFAULT false,
  bcg_given                BOOLEAN NOT NULL DEFAULT false,
  hep_b_given              BOOLEAN NOT NULL DEFAULT false,
  opv_given                BOOLEAN NOT NULL DEFAULT false,
  -- Anomalies
  congenital_anomaly       BOOLEAN NOT NULL DEFAULT false,
  congenital_anomaly_desc  TEXT,
  -- Audit
  recorded_by              UUID,
  notes                    TEXT,
  tenant_id                UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_maternity_newborns_delivery
  ON maternity_newborns(delivery_id, birth_order);
CREATE INDEX IF NOT EXISTS idx_maternity_newborns_patient_uid
  ON maternity_newborns(newborn_patient_uid) WHERE newborn_patient_uid IS NOT NULL;

-- ── 7. Apgar scores ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS maternity_apgar_scores (
  id                       SERIAL PRIMARY KEY,
  newborn_id               INTEGER NOT NULL REFERENCES maternity_newborns(id) ON DELETE CASCADE,
  time_minute              INTEGER NOT NULL CHECK (time_minute IN (1, 5, 10)),
  appearance               INTEGER CHECK (appearance BETWEEN 0 AND 2), -- skin colour
  pulse                    INTEGER CHECK (pulse BETWEEN 0 AND 2),
  grimace                  INTEGER CHECK (grimace BETWEEN 0 AND 2),
  activity                 INTEGER CHECK (activity BETWEEN 0 AND 2),    -- muscle tone
  respiration              INTEGER CHECK (respiration BETWEEN 0 AND 2),
  total_score              INTEGER GENERATED ALWAYS AS
    (COALESCE(appearance,0)+COALESCE(pulse,0)+COALESCE(grimace,0)+COALESCE(activity,0)+COALESCE(respiration,0)) STORED,
  recorded_by              UUID,
  recorded_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (newborn_id, time_minute)
);

CREATE INDEX IF NOT EXISTS idx_maternity_apgar_newborn
  ON maternity_apgar_scores(newborn_id, time_minute);

-- ── 8. Postnatal visits (mother + baby) ─────────────────────────────
CREATE TABLE IF NOT EXISTS maternity_postnatal_visits (
  id                       SERIAL PRIMARY KEY,
  delivery_id              INTEGER NOT NULL REFERENCES maternity_deliveries(id) ON DELETE CASCADE,
  visit_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  visit_kind               VARCHAR(20) NOT NULL DEFAULT 'mother'
    CHECK (visit_kind IN ('mother', 'baby', 'both')),
  newborn_id               INTEGER REFERENCES maternity_newborns(id) ON DELETE SET NULL,
  -- Mother
  mother_temp_c            NUMERIC(4, 1),
  mother_pulse_bpm         INTEGER,
  mother_bp_systolic       INTEGER,
  mother_bp_diastolic      INTEGER,
  uterine_involution       VARCHAR(20),                -- normal / sub_involution / atonic
  lochia                   VARCHAR(20),                -- rubra / serosa / alba / foul
  perineum_status          VARCHAR(20),                -- healing / infected / ohealed / dehisced
  breastfeeding_status     VARCHAR(20),                -- exclusive / partial / formula
  -- Baby
  baby_weight_g            INTEGER,
  baby_temperature_c       NUMERIC(4, 1),
  baby_feeding             VARCHAR(20),                -- breast / formula / mixed / iv
  baby_jaundice            VARCHAR(20),                -- nil / mild / moderate / severe / phototherapy
  baby_passed_meconium     BOOLEAN,
  baby_passed_urine        BOOLEAN,
  baby_cord_status         VARCHAR(20),                -- healthy / infected / detached
  red_flags                TEXT[],                     -- multi-tag escalation list
  notes                    TEXT,
  recorded_by              UUID,
  tenant_id                UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_maternity_pnc_delivery
  ON maternity_postnatal_visits(delivery_id, visit_at DESC);

COMMIT;
