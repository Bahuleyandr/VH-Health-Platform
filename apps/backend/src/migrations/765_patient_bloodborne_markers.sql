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
-- Append-only by convention: writers insert rows and perform the void
-- transition (voided_at/voided_by/void_reason set together, nothing else
-- changed); the resolver reads the latest non-voided row per marker.
-- Database-level enforcement (a BEFORE UPDATE OR DELETE trigger in the
-- merge-aware pattern of migration 758's enforce_*_patient_merge_path_753,
-- so the patient-merge sweep can still re-point patient_uid) is deferred to a
-- follow-up and tracked on the delivering pull request.
--
-- Writers: the lab sign-off hook (source = lab_result, one row per signed
-- HIV/HBSAG/HCV result, idempotent through ux_patient_bloodborne_markers_lab_result)
-- and, in the companion cath readiness work, the checklist's external-result
-- and clinical-declaration paths. There is no general create endpoint.
-- Foreign keys are tenant-pinned composites (users (tenant_id, uid);
-- lab_results (tenant_id, id, patient_uid)) so a marker can never bind to
-- another tenant's or another patient's lab result.
-- Source semantics: `lab_result` rows come from the pathologist sign-off hook
-- on an in-house result; `external_report` rows come from the cath readiness
-- checklist, which first files the outside value as an external-origin
-- lab_results row (result_origin = 'external_lab', never signed off) and then
-- records the marker against it — so both carry lab_result_id and differ in
-- provenance, not shape; `clinical_declaration` rows carry none. The
-- lab_link_check below enforces exactly that.
--
-- No NOT VALID constraints; the table is new, so nothing joins the OPEN-15
-- validation backlog.
-- Every CHECK is named explicitly so the names are stable: Postgres
-- auto-names a single-column check <table>_<column>_check but a multi-column
-- check <table>_check, <table>_check1, … — positional suffixes that renumber
-- when a check is added or removed.

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
    FOREIGN KEY (tenant_id, patient_uid) REFERENCES users (tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_patient_bloodborne_markers_lab_result
    FOREIGN KEY (tenant_id, lab_result_id, patient_uid)
    REFERENCES lab_results (tenant_id, id, patient_uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_patient_bloodborne_markers_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_patient_bloodborne_markers_recorded_by
    FOREIGN KEY (tenant_id, recorded_by) REFERENCES users (tenant_id, uid) ON DELETE NO ACTION,
  CONSTRAINT fk_patient_bloodborne_markers_voided_by
    FOREIGN KEY (tenant_id, voided_by) REFERENCES users (tenant_id, uid) ON DELETE NO ACTION,
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
    CHECK ((source = 'clinical_declaration') = (lab_result_id IS NULL)),
  CONSTRAINT patient_bloodborne_markers_void_check
    CHECK (
      (voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL)
      OR (voided_at IS NOT NULL AND voided_by IS NOT NULL AND NULLIF(BTRIM(void_reason), '') IS NOT NULL)
    )
);

CREATE INDEX idx_patient_bloodborne_markers_patient
  ON patient_bloodborne_markers (tenant_id, patient_uid, marker, tested_on DESC, id DESC);

-- One active marker row per lab result, whatever its source. The sign-off
-- hook inserts with ON CONFLICT … DO NOTHING on this index, so a replay — or
-- an external_report row already occupying the slot — is a no-op, never a
-- 23505; a corrective sign-off voids the old row before inserting the new.
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
