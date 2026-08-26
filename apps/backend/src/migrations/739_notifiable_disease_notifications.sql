-- 739_notifiable_disease_notifications.sql
--
-- Statutory public-health notifiable-disease register (G1, reaudit 2026-08-25).
--
-- Today only tierGPublicHealthService drafts AGGREGATE reports — there is no
-- case-level register and no submission-format export. TB notification is
-- legally mandatory for private hospitals (Nikshay); IDSP/IHIP weekly S/P
-- forms and state HMIS monthly returns are standing obligations. This table is
-- the case-level register that feeds those exports.
--
-- The register is the source of truth; the export FILES (Nikshay TB CSV,
-- IDSP/IHIP weekly, HMIS monthly) are generated read-projections. Live portal
-- APIs are out of scope (the portals accept manual upload).
--
-- RLS follows the mis_report_schedules (migration 679) request-path pattern:
-- permissive tenant_isolation, ENABLE + FORCE, service writers supply tenant_id
-- explicitly (dev/QA/CI keep the GUC unset — first OR branch keeps them open).

BEGIN;

CREATE TABLE IF NOT EXISTS notifiable_disease_notifications (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- Case identity
  patient_uid         UUID NOT NULL,
  admission_id        INTEGER,
  -- Demographic snapshot for the line-list (registers are name+age+sex+address).
  patient_name        VARCHAR(160),
  patient_age_years    INTEGER CHECK (patient_age_years IS NULL OR patient_age_years BETWEEN 0 AND 130),
  patient_sex         VARCHAR(12) CHECK (patient_sex IS NULL OR patient_sex IN ('male', 'female', 'intersex', 'indeterminate')),
  patient_phone       VARCHAR(20),
  patient_address     TEXT,
  patient_district    VARCHAR(120),
  patient_state       VARCHAR(80),

  -- Disease
  disease_code        VARCHAR(40) NOT NULL,   -- controlled slug (see chk below)
  disease_name        VARCHAR(160) NOT NULL,
  icd10_code          VARCHAR(10),

  -- Which statutory programme this case is reported under. A TB case is
  -- reported to Nikshay; most other notifiable diseases flow via IDSP/IHIP;
  -- routine service counts roll up into HMIS.
  program             VARCHAR(20) NOT NULL DEFAULT 'idsp'
    CHECK (program IN ('idsp', 'nikshay', 'hmis', 'other')),

  case_classification VARCHAR(20) NOT NULL DEFAULT 'suspected'
    CHECK (case_classification IN ('suspected', 'probable', 'confirmed', 'discarded')),
  lab_confirmed       BOOLEAN NOT NULL DEFAULT false,
  specimen_type       VARCHAR(60),
  lab_test            VARCHAR(120),
  lab_result          VARCHAR(120),

  date_of_onset       DATE,
  date_of_diagnosis   DATE NOT NULL,
  notified_at         TIMESTAMPTZ,

  -- Programme-specific detail (Nikshay: hiv_status, dst, treatment regimen;
  -- IDSP: syndrome; free-form so the register carries programme fields without
  -- a column explosion). Never PHI beyond what the programme form requires.
  program_details     JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- External acknowledgement (Nikshay ID / IDSP reference once submitted).
  external_ref        VARCHAR(80),

  outcome             VARCHAR(24)
    CHECK (outcome IS NULL OR outcome IN ('under_treatment', 'recovered', 'died', 'transferred_out', 'lost_to_followup', 'unknown')),

  status              VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'notified', 'acknowledged', 'closed', 'cancelled')),

  reported_by         UUID,
  reported_by_name    VARCHAR(160),
  notes               TEXT,

  created_by          UUID,
  created_at          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Controlled disease vocabulary (IDSP notifiable list + programme diseases).
  -- Widen alongside the service registry in one commit.
  CONSTRAINT chk_notifiable_disease_code CHECK (
    disease_code IN (
      'tuberculosis', 'malaria', 'dengue', 'chikungunya', 'cholera',
      'acute_diarrheal_disease', 'typhoid', 'viral_hepatitis', 'measles',
      'diphtheria', 'pertussis', 'tetanus', 'meningitis', 'leptospirosis',
      'japanese_encephalitis', 'acute_encephalitis_syndrome', 'rabies',
      'covid19', 'influenza_h1n1', 'chickenpox', 'mumps', 'leprosy',
      'kala_azar', 'filariasis', 'plague', 'anthrax', 'other'
    )
  ),
  -- A notified case must carry a notification timestamp.
  CONSTRAINT chk_notifiable_notified_has_ts CHECK (
    status = 'draft' OR status = 'cancelled' OR notified_at IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_notifiable_disease_program
  ON notifiable_disease_notifications (tenant_id, program, date_of_diagnosis DESC);
CREATE INDEX IF NOT EXISTS idx_notifiable_disease_status
  ON notifiable_disease_notifications (tenant_id, status, date_of_diagnosis DESC);
CREATE INDEX IF NOT EXISTS idx_notifiable_disease_patient
  ON notifiable_disease_notifications (patient_uid);
-- Pending-submission radar: notifiable cases not yet submitted to a programme.
CREATE INDEX IF NOT EXISTS idx_notifiable_disease_pending
  ON notifiable_disease_notifications (tenant_id, date_of_diagnosis)
  WHERE status = 'draft';

ALTER TABLE notifiable_disease_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifiable_disease_notifications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON notifiable_disease_notifications;
CREATE POLICY tenant_isolation ON notifiable_disease_notifications
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

COMMENT ON TABLE notifiable_disease_notifications IS
  'Case-level statutory public-health notifiable-disease register feeding Nikshay(TB)/IDSP-IHIP/HMIS submission-format exports; source of truth for the export files.';

COMMIT;
