-- 634_patient_merge_integrity.sql
--
-- Patient-merge integrity substrate (2026-08-07 Phase-3 deep review,
-- patient-merge findings).
--
-- 1. users.merged_into_uid / users.merged_at — durable survivor pointer
--    written when a duplicate patient record is merged away. The merged-away
--    row is deactivated (is_active = false, status = 'merged') but never
--    deleted, and its identifier rows keep their original patient_uid, so an
--    old MRN/ABHA remains resolvable to the survivor and a future un-merge
--    has full provenance (original identifier ownership + this pointer +
--    patient_merge_requests.execution_summary).
--
-- 2. Every composite FK that carries patient_uid becomes DEFERRABLE
--    INITIALLY IMMEDIATE. The merge FK sweep re-points patient_uid on parent
--    and child tables inside one transaction under SET CONSTRAINTS ALL
--    DEFERRED; while these constraints are non-deferrable, updating either
--    side first fails the end-of-statement check (e.g. admissions vs the
--    fk_investigations_admission (tenant_id, admission_id, patient_uid)
--    composite), making any multi-table re-point impossible. INITIALLY
--    IMMEDIATE preserves the existing per-statement checking for every other
--    code path. Future migrations adding composite patient_uid FKs must also
--    declare them DEFERRABLE INITIALLY IMMEDIATE (pinned by
--    src/tests/patient-merge-execution.deep.test.js).

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS merged_into_uid uuid;
ALTER TABLE users ADD COLUMN IF NOT EXISTS merged_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_users_merged_into_not_self'
      AND conrelid = 'public.users'::regclass
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT chk_users_merged_into_not_self
      CHECK (merged_into_uid IS NULL OR merged_into_uid <> uid);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_users_merged_into_uid
  ON users (merged_into_uid)
  WHERE merged_into_uid IS NOT NULL;

COMMENT ON COLUMN users.merged_into_uid IS
  'Survivor patient uid when this duplicate record was merged away (patient_merge_requests execution). Row is deactivated, not deleted; NULL for live records.';

-- 2. Composite patient_uid FKs -> DEFERRABLE INITIALLY IMMEDIATE.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT pc.conrelid::regclass AS child, pc.conname
    FROM pg_constraint pc
    WHERE pc.contype = 'f'
      AND NOT pc.condeferrable
      AND array_length(pc.conkey, 1) > 1
      AND EXISTS (
        SELECT 1 FROM unnest(pc.conkey) AS k
        JOIN pg_attribute a ON a.attrelid = pc.conrelid AND a.attnum = k
        WHERE a.attname = 'patient_uid'
      )
  LOOP
    EXECUTE format(
      'ALTER TABLE %s ALTER CONSTRAINT %I DEFERRABLE INITIALLY IMMEDIATE',
      r.child, r.conname
    );
  END LOOP;
END $$;

COMMIT;
