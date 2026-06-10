-- 293_ophthalmology_exams.sql
--
-- Roadmap Pillar D / item D7 — ophthalmology depth (greenfield).
--
--   * ophthalmic_exams       — per-eye (OD/OS) structured exam: visual
--                              acuity (Snellen 6/x + CF/HM/PL/NPL
--                              notations, validated service-side), IOP
--                              with method, anterior/posterior segment,
--                              lens status. IOP > 21 mmHg surfaces an
--                              alert flag (glaucoma threshold).
--   * ophthalmic_refractions — sphere/cylinder/axis/add per eye per exam;
--                              type manifest|cycloplegic|final_glasses
--                              (final_glasses rows are the dispensable
--                              spectacle prescription).

BEGIN;

CREATE TABLE IF NOT EXISTS ophthalmic_exams (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  patient_uid     UUID NOT NULL,
  exam_type       VARCHAR(16) NOT NULL DEFAULT 'comprehensive',
  od_va_unaided   VARCHAR(12),
  os_va_unaided   VARCHAR(12),
  od_va_pinhole   VARCHAR(12),
  os_va_pinhole   VARCHAR(12),
  od_va_corrected VARCHAR(12),
  os_va_corrected VARCHAR(12),
  od_iop_mmhg     NUMERIC(4, 1),
  os_iop_mmhg     NUMERIC(4, 1),
  iop_method      VARCHAR(10),
  od_anterior_segment TEXT,
  os_anterior_segment TEXT,
  od_posterior_segment TEXT,
  os_posterior_segment TEXT,
  od_lens_status  VARCHAR(20),
  os_lens_status  VARCHAR(20),
  diagnosis       TEXT,
  advice          TEXT,
  examined_by     UUID,
  recorded_at     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ophthalmic_exams_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_ophthalmic_exams_type CHECK (exam_type IN (
    'comprehensive', 'refraction', 'iop_check', 'fundus', 'post_op', 'emergency'
  )),
  CONSTRAINT chk_ophthalmic_exams_iop_method CHECK (
    iop_method IS NULL OR iop_method IN ('gat', 'nct', 'icare', 'schiotz')
  ),
  CONSTRAINT chk_ophthalmic_exams_iop_od CHECK (od_iop_mmhg IS NULL OR (od_iop_mmhg >= 0 AND od_iop_mmhg <= 80)),
  CONSTRAINT chk_ophthalmic_exams_iop_os CHECK (os_iop_mmhg IS NULL OR (os_iop_mmhg >= 0 AND os_iop_mmhg <= 80)),
  CONSTRAINT chk_ophthalmic_exams_lens_od CHECK (od_lens_status IS NULL OR od_lens_status IN (
    'clear', 'ns_grade_1', 'ns_grade_2', 'ns_grade_3', 'ns_grade_4',
    'cortical', 'psc', 'mature', 'pseudophakic', 'aphakic'
  )),
  CONSTRAINT chk_ophthalmic_exams_lens_os CHECK (os_lens_status IS NULL OR os_lens_status IN (
    'clear', 'ns_grade_1', 'ns_grade_2', 'ns_grade_3', 'ns_grade_4',
    'cortical', 'psc', 'mature', 'pseudophakic', 'aphakic'
  ))
);

CREATE INDEX IF NOT EXISTS idx_ophthalmic_exams_patient
  ON ophthalmic_exams (patient_uid, recorded_at DESC);

CREATE TABLE IF NOT EXISTS ophthalmic_refractions (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  exam_id         INTEGER NOT NULL REFERENCES ophthalmic_exams(id) ON DELETE CASCADE,
  patient_uid     UUID NOT NULL,
  eye             VARCHAR(2) NOT NULL,
  refraction_type VARCHAR(14) NOT NULL DEFAULT 'manifest',
  sphere          NUMERIC(5, 2) NOT NULL,
  cylinder        NUMERIC(5, 2),
  axis            INTEGER,
  add_power       NUMERIC(4, 2),
  va_with_correction VARCHAR(12),
  recorded_by     UUID,
  created_at      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ophthalmic_refractions_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_ophthalmic_refractions_eye CHECK (eye IN ('od', 'os')),
  CONSTRAINT chk_ophthalmic_refractions_type CHECK (refraction_type IN ('manifest', 'cycloplegic', 'final_glasses')),
  CONSTRAINT chk_ophthalmic_refractions_sphere CHECK (sphere BETWEEN -30 AND 30),
  CONSTRAINT chk_ophthalmic_refractions_cylinder CHECK (cylinder IS NULL OR (cylinder BETWEEN -10 AND 10)),
  CONSTRAINT chk_ophthalmic_refractions_axis CHECK (axis IS NULL OR (axis BETWEEN 0 AND 180)),
  CONSTRAINT chk_ophthalmic_refractions_add CHECK (add_power IS NULL OR (add_power BETWEEN 0 AND 4)),
  CONSTRAINT uq_ophthalmic_refractions_eye UNIQUE (exam_id, eye, refraction_type)
);

CREATE INDEX IF NOT EXISTS idx_ophthalmic_refractions_patient
  ON ophthalmic_refractions (patient_uid, created_at DESC);

-- Tenant isolation (262/272 pattern) — both tables are PHI.
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['ophthalmic_exams', 'ophthalmic_refractions'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
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
        )
    $f$, t);
  END LOOP;
END
$$;

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'OPHTHALMOLOGY_EXAMS_APPLIED',
  'ophthalmic_exams',
  'ophthalmic_exams',
  jsonb_build_object(
    'migration', '293_ophthalmology_exams.sql',
    'roadmap', 'docs/EPIC_LEVEL_ROADMAP.md#D7',
    'reason', 'Per-eye structured exams (VA notations, IOP with method + glaucoma alert, segments, lens status) and sphere/cyl/axis/add refractions incl. dispensable glasses prescriptions.'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'OPHTHALMOLOGY_EXAMS_APPLIED'
    AND resource = 'ophthalmic_exams'
);

COMMIT;
