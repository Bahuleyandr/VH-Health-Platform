-- Migration 767: Phase 1 dialysis isolation resolver support.
--
-- Legacy negative roster values were manufactured by defaults and are not
-- evidence. New enrolments use unknown; the read-time resolver retains legacy
-- positives as fail-safe declarations while marker and serology rows become
-- the evidence authority.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE dialysis_patients
  ALTER COLUMN hbsag_status SET DEFAULT 'unknown',
  ALTER COLUMN hcv_status SET DEFAULT 'unknown',
  ALTER COLUMN hiv_status SET DEFAULT 'unknown';

-- Before PR #1024, these rows inherited the default tenant even when their
-- roster parent belonged to another tenant. Repair them before making that
-- relationship database-enforced.
UPDATE dialysis_serology AS serology
   SET tenant_id = patient.tenant_id
  FROM dialysis_patients AS patient
 WHERE patient.id = serology.dialysis_patient_id
   AND serology.tenant_id IS DISTINCT FROM patient.tenant_id;

ALTER TABLE dialysis_patients
  ADD CONSTRAINT uq_dialysis_patients_tenant_id_id
  UNIQUE (tenant_id, id);

ALTER TABLE dialysis_serology
  DROP CONSTRAINT dialysis_serology_dialysis_patient_id_fkey,
  ADD CONSTRAINT fk_dialysis_serology_tenant_patient
    FOREIGN KEY (tenant_id, dialysis_patient_id)
    REFERENCES dialysis_patients (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX idx_dialysis_serology_tenant_patient_date
  ON dialysis_serology (tenant_id, dialysis_patient_id, test_date DESC, id DESC);

-- Plan 4 evidence holds point at marker rows through a tenant-pinned
-- composite FK. The child table belongs to that later lane; this is its parent
-- key and prevents a single-column reference from crossing tenants around RLS.
ALTER TABLE patient_bloodborne_markers
  ADD CONSTRAINT uq_patient_bloodborne_markers_tenant_id_id
  UNIQUE (tenant_id, id);

COMMIT;
