-- 416_ophthalmic_biometry.sql
--
-- N6-7 ophthalmology completion: recorded-not-computed biometry/IOL power
-- rows keyed to an ophthalmic exam and patient encounter context.

BEGIN;

CREATE TABLE IF NOT EXISTS ophthalmic_biometry (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  exam_id INTEGER NOT NULL REFERENCES ophthalmic_exams(id) ON DELETE CASCADE,
  patient_uid UUID NOT NULL,
  encounter_id UUID REFERENCES patient_encounters(id) ON DELETE SET NULL,
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  eye VARCHAR(2) NOT NULL,
  k1_diopters NUMERIC(5,2),
  k1_axis INTEGER,
  k2_diopters NUMERIC(5,2),
  k2_axis INTEGER,
  axial_length_mm NUMERIC(5,2) NOT NULL,
  anterior_chamber_depth_mm NUMERIC(5,2),
  lens_thickness_mm NUMERIC(5,2),
  white_to_white_mm NUMERIC(5,2),
  target_refraction NUMERIC(5,2),
  iol_formula VARCHAR(40),
  selected_iol_power NUMERIC(5,2),
  selected_iol_model VARCHAR(160),
  calculation_reference TEXT,
  notes TEXT,
  recorded_by UUID,
  recorded_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT fk_ophthalmic_biometry_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT chk_ophthalmic_biometry_eye CHECK (eye IN ('od', 'os')),
  CONSTRAINT chk_ophthalmic_biometry_k1 CHECK (k1_diopters IS NULL OR k1_diopters BETWEEN 30 AND 60),
  CONSTRAINT chk_ophthalmic_biometry_k2 CHECK (k2_diopters IS NULL OR k2_diopters BETWEEN 30 AND 60),
  CONSTRAINT chk_ophthalmic_biometry_axis1 CHECK (k1_axis IS NULL OR k1_axis BETWEEN 0 AND 180),
  CONSTRAINT chk_ophthalmic_biometry_axis2 CHECK (k2_axis IS NULL OR k2_axis BETWEEN 0 AND 180),
  CONSTRAINT chk_ophthalmic_biometry_axial CHECK (axial_length_mm BETWEEN 15 AND 40),
  CONSTRAINT chk_ophthalmic_biometry_acd CHECK (anterior_chamber_depth_mm IS NULL OR anterior_chamber_depth_mm BETWEEN 1 AND 8),
  CONSTRAINT chk_ophthalmic_biometry_lens CHECK (lens_thickness_mm IS NULL OR lens_thickness_mm BETWEEN 1 AND 8),
  CONSTRAINT chk_ophthalmic_biometry_wtw CHECK (white_to_white_mm IS NULL OR white_to_white_mm BETWEEN 8 AND 16),
  CONSTRAINT uq_ophthalmic_biometry_exam_eye UNIQUE (tenant_id, exam_id, eye)
);

CREATE INDEX IF NOT EXISTS idx_ophthalmic_biometry_patient
  ON ophthalmic_biometry (tenant_id, patient_uid, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_ophthalmic_biometry_encounter
  ON ophthalmic_biometry (tenant_id, encounter_id)
  WHERE encounter_id IS NOT NULL;

ALTER TABLE ophthalmic_biometry ENABLE ROW LEVEL SECURITY;
ALTER TABLE ophthalmic_biometry FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON ophthalmic_biometry;
CREATE POLICY tenant_isolation ON ophthalmic_biometry
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

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'OPHTHALMIC_BIOMETRY_APPLIED',
  'ophthalmic_biometry',
  '416',
  jsonb_build_object(
    'migration', '416_ophthalmic_biometry.sql',
    'scope', 'K-readings, axial length, IOL formula/power/selection recorded as clinician-entered values'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'OPHTHALMIC_BIOMETRY_APPLIED'
    AND resource = 'ophthalmic_biometry'
    AND resource_id = '416'
);

COMMIT;
