-- 765_patient_bloodborne_markers.sql
--
-- Platform-level patient blood-borne marker record (HIV, HBsAg, HCV,
-- CJD-suspected, other). Until now the only serology status lived inside
-- dialysis enrolment (dialysis_patients.hbsag_status/hcv_status/hiv_status,
-- migration 168) and blood-bank donor testing (tti_tests, migration 404); no
-- consumer outside those modules could ask "may a device used on this patient
-- be reprocessed?". Cath-lab device reuse is the first consumer
-- (docs/superpowers/specs/2026-09-04-cath-device-reuse-and-bloodborne-markers-design.md §5.1, §7);
-- OT and dialysis are named future consumers.
--
-- Append-only with voiding: a correction inserts a new row and voids the old
-- one; the resolver reads the latest non-voided row per marker.
--
-- Writers: the lab sign-off hook (source = lab_result, one row per signed
-- HIV/HBSAG/HCV result, idempotent through ux_patient_bloodborne_markers_lab_result)
-- and, in the companion cath readiness work, the checklist's external-result
-- and clinical-declaration paths. There is no general create endpoint.
--
-- No NOT VALID constraints; the table is new, so nothing joins the OPEN-15
-- validation backlog. Every CHECK is named so the inline-check census reads
-- it as declared.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE TABLE patient_bloodborne_markers (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  patient_uid UUID NOT NULL,
  marker VARCHAR(32) NOT NULL,
  marker_label VARCHAR(120),
  result VARCHAR(20) NOT NULL,
  tested_on DATE NOT NULL,
  source VARCHAR(24) NOT NULL,
  lab_result_id INTEGER,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_by UUID NOT NULL,
  recorded_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  voided_at TIMESTAMPTZ(6),
  voided_by UUID,
  void_reason TEXT,
  notes TEXT,

  CONSTRAINT fk_patient_bloodborne_markers_patient
    FOREIGN KEY (patient_uid) REFERENCES users(uid) ON DELETE RESTRICT,
  CONSTRAINT fk_patient_bloodborne_markers_lab_result
    FOREIGN KEY (lab_result_id) REFERENCES lab_results(id) ON DELETE RESTRICT,
  CONSTRAINT patient_bloodborne_markers_marker_check
    CHECK (marker IN ('hiv', 'hbsag', 'hcv', 'cjd_suspected', 'other')),
  CONSTRAINT patient_bloodborne_markers_result_check
    CHECK (result IN ('reactive', 'non_reactive', 'indeterminate', 'pending')),
  CONSTRAINT patient_bloodborne_markers_source_check
    CHECK (source IN ('lab_result', 'external_report', 'clinical_declaration')),
  CONSTRAINT patient_bloodborne_markers_label_check
    CHECK (marker <> 'other' OR NULLIF(BTRIM(marker_label), '') IS NOT NULL),
  CONSTRAINT patient_bloodborne_markers_cjd_result_check
    CHECK (marker <> 'cjd_suspected' OR result IN ('reactive', 'non_reactive')),
  CONSTRAINT patient_bloodborne_markers_lab_link_check
    CHECK (source <> 'lab_result' OR lab_result_id IS NOT NULL),
  CONSTRAINT patient_bloodborne_markers_void_check
    CHECK (
      (voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL)
      OR (voided_at IS NOT NULL AND voided_by IS NOT NULL AND void_reason IS NOT NULL)
    )
);

CREATE INDEX idx_patient_bloodborne_markers_patient
  ON patient_bloodborne_markers (tenant_id, patient_uid, marker, tested_on DESC, id DESC);

-- One active marker row per signed lab result: the sign-off hook replays as a
-- no-op, and a corrective sign-off voids the old row before inserting the new.
CREATE UNIQUE INDEX ux_patient_bloodborne_markers_lab_result
  ON patient_bloodborne_markers (tenant_id, lab_result_id)
  WHERE lab_result_id IS NOT NULL AND voided_at IS NULL;

ALTER TABLE patient_bloodborne_markers ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_bloodborne_markers FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON patient_bloodborne_markers;
CREATE POLICY tenant_isolation ON patient_bloodborne_markers
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

COMMIT;
