-- Migration 640: one active admission per patient — DB backstop.
--
-- admitPatient's "patient already has an active admission" rule was only a
-- pre-flight SELECT outside the admit transaction, so two concurrent admits
-- for the same patient could both pass the check and both commit, leaving the
-- patient with two active charts (double bed allocation, split orders/billing).
--
-- Partial unique index: at most one admissions row per (tenant_id, patient_uid)
-- while its status is an active one ('admitted' / 'transferred'). Discharged /
-- lama / expired / cancelled rows stay unconstrained, so re-admissions are
-- unaffected. The service layer keeps its pre-flight + in-tx checks for the
-- friendly 409; this index is the guarantee under true concurrency.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '180s';

-- Pre-check (mirrors migration 329's idiom): an already-double-active patient
-- would make the index build fail with an opaque "could not create unique
-- index". Name the offending patient instead so the operator can resolve the
-- duplicate chart before re-applying. Clean CI/QA databases have no rows.
DO $$
DECLARE
  clash RECORD;
BEGIN
  SELECT tenant_id, patient_uid, count(*) AS n
    INTO clash
    FROM admissions
   WHERE status IN ('admitted', 'transferred')
   GROUP BY tenant_id, patient_uid
  HAVING count(*) > 1
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'Cannot enforce one active admission per patient: patient % (tenant %) has % active admissions; discharge/cancel the duplicates before applying migration 640',
      clash.patient_uid, clash.tenant_id, clash.n;
  END IF;
END $$;

-- The trailing (TRUE) expression column is deliberate (migration-580 idiom,
-- ux_workflow_steps_one_current): a constant adds nothing to the key, but it
-- makes this an expression index that `prisma db pull` skips — a plain
-- (tenant_id, patient_uid) unique is a column subset of the readmission /
-- pathway / handoff FKs, and introspection then mis-infers those relations as
-- one-to-one and emits a schema that fails its own validation.
CREATE UNIQUE INDEX IF NOT EXISTS ux_admissions_one_active_per_patient
  ON public.admissions (tenant_id, patient_uid, (TRUE))
  WHERE status IN ('admitted', 'transferred');

COMMIT;
