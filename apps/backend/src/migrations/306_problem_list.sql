-- 306_problem_list.sql
--
-- Roadmap B7 (longitudinal problem list) — additive enhancements layered
-- over migration 276 which created the patient_problems table.
--
-- What this migration adds:
--
--   1. problem_list_snapshots — periodic point-in-time snapshots of a
--      patient's active problem list, used by discharge summaries,
--      outpatient referral letters, and care-plan continuity audits.
--      These are *derived* rows (written by scheduled jobs and service
--      calls), NOT the source of truth — patient_problems is the spine.
--
--   2. problem_episode_links — links multiple patient_problems rows into
--      a named clinical episode (e.g., "Diabetic foot ulcer episode 2024")
--      so that resolved + reactivated + related problems can be grouped
--      for longitudinal analytics without losing individual status history.
--
--   3. Performance index: (managing_doctor_id, status) — surfaces the
--      "my active patients' problems" query used by the CDS engine when
--      constructing the doctor-scoped clinical dashboard.
--
--   4. RLS hardening: migration 276 used DROP POLICY IF EXISTS before
--      creating the policy (non-idempotent on re-run). This migration
--      adds an idempotent policy guard (CREATE POLICY only when absent,
--      mirroring the 304 pattern) to both new tables and re-affirms
--      FORCE ROW LEVEL SECURITY on patient_problems so the guarantee is
--      explicit in the migration record even after any manual DDL.
--
-- Design notes:
--   * problem_list_snapshots has tenant_id + RLS (PHI-bearing: it mirrors
--     a patient's full problem list at a point in time).
--   * problem_episode_links has tenant_id + RLS (links are per-patient).
--   * Neither table has a patient_uid FK — they carry patient_uid as a
--     denormalized column for RLS and query efficiency, same as
--     patient_problems itself.
--   * check:phi-tenant-id: both new tables carry tenant_id + a
--     tenant_isolation policy, so they pass the PHI-tenant-id check.
--     terminology_concepts / terminology_code_systems are intentionally
--     global reference tables (no tenant_id) — they are not touched here.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. problem_list_snapshots — point-in-time active problem list captures
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS problem_list_snapshots (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  patient_uid    UUID NOT NULL,
  snapshot_type  VARCHAR(40) NOT NULL DEFAULT 'discharge',
  snapshot_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  encounter_id   UUID,
  problems       JSONB NOT NULL DEFAULT '[]'::jsonb,
  generated_by   UUID,
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_problem_snapshots_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_problem_snapshots_type
    CHECK (snapshot_type IN ('discharge', 'referral', 'periodic', 'care_plan', 'admission'))
);

CREATE INDEX IF NOT EXISTS idx_problem_snapshots_patient
  ON problem_list_snapshots (tenant_id, patient_uid, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_problem_snapshots_encounter
  ON problem_list_snapshots (encounter_id)
  WHERE encounter_id IS NOT NULL;

-- Tenant isolation (idempotent: only creates policy when absent, matching
-- the 304-style guard).
DO $$
BEGIN
  EXECUTE 'ALTER TABLE problem_list_snapshots ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE problem_list_snapshots FORCE ROW LEVEL SECURITY';
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'problem_list_snapshots'
       AND policyname = 'tenant_isolation'
  ) THEN
    EXECUTE $f$
      CREATE POLICY tenant_isolation ON problem_list_snapshots
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
    $f$;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. problem_episode_links — group related problem rows into episodes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS problem_episode_links (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  patient_uid  UUID NOT NULL,
  episode_name VARCHAR(255) NOT NULL,
  problem_id   UUID NOT NULL,
  link_role    VARCHAR(40) NOT NULL DEFAULT 'primary',
  notes        TEXT,
  linked_by    UUID,
  created_at   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_episode_links_problem
    FOREIGN KEY (problem_id) REFERENCES patient_problems(id) ON DELETE CASCADE,
  CONSTRAINT fk_episode_links_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_episode_links_role
    CHECK (link_role IN ('primary', 'complication', 'related', 'resolved_member'))
);

CREATE INDEX IF NOT EXISTS idx_episode_links_patient
  ON problem_episode_links (tenant_id, patient_uid, episode_name);
CREATE INDEX IF NOT EXISTS idx_episode_links_problem
  ON problem_episode_links (problem_id);

DO $$
BEGIN
  EXECUTE 'ALTER TABLE problem_episode_links ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE problem_episode_links FORCE ROW LEVEL SECURITY';
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'problem_episode_links'
       AND policyname = 'tenant_isolation'
  ) THEN
    EXECUTE $f$
      CREATE POLICY tenant_isolation ON problem_episode_links
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
    $f$;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. Performance index: doctor-scoped active problem query
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_patient_problems_doctor_status
  ON patient_problems (managing_doctor_id, status, created_at DESC)
  WHERE managing_doctor_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Re-affirm FORCE ROW LEVEL SECURITY on patient_problems (idempotent)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  EXECUTE 'ALTER TABLE patient_problems ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE patient_problems FORCE ROW LEVEL SECURITY';
  -- Idempotent policy guard (276 used DROP+CREATE; this ensures the policy
  -- is present even if 276 ran against a DB that already lacked it).
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'patient_problems'
       AND policyname = 'tenant_isolation'
  ) THEN
    EXECUTE $f$
      CREATE POLICY tenant_isolation ON patient_problems
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
    $f$;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Audit stamp (idempotent, repo convention).
-- ---------------------------------------------------------------------------
INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'PROBLEM_LIST_ENHANCEMENTS_APPLIED',
  'patient_problems',
  'patient_problems',
  jsonb_build_object(
    'migration', '306_problem_list.sql',
    'roadmap', 'docs/EPIC_LEVEL_ROADMAP.md#B7',
    'reason', 'Additive enhancements: point-in-time snapshots, episode grouping, doctor-status performance index, idempotent RLS re-affirmation on patient_problems.',
    'new_tables', ARRAY['problem_list_snapshots', 'problem_episode_links'],
    'phi_tenant_id', 'Both new tables carry tenant_id + tenant_isolation RLS policy (ENABLE + FORCE).'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'PROBLEM_LIST_ENHANCEMENTS_APPLIED'
    AND resource = 'patient_problems'
);

COMMIT;
