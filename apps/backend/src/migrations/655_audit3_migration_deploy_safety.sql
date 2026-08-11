-- 655_audit3_migration_deploy_safety.sql
--
-- @no-transaction
-- @statement_timeout: 0
--
-- Additive remediation for databases that already recorded migrations
-- 647-653 before their deploy-safe forms landed. Every statement is
-- re-runnable because no-transaction files can be interrupted after any
-- committed statement. The historical files remain corrected for fresh or
-- not-yet-upgraded databases; this file converges already-upgraded schemas.

-- Repair the recorded fail-open RLS posture before any long-running index,
-- validation, or backfill work. Both policies are replaced inside one DO so
-- no committed cut point can expose the permissive policy on its own.
ALTER TABLE public.icu_code_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.icu_code_status_history FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON public.icu_code_status_history';
  EXECUTE $policy$
    CREATE POLICY tenant_isolation ON public.icu_code_status_history
    AS PERMISSIVE
    USING (
      current_setting('app.current_tenant_id', true) IS NULL
      OR current_setting('app.current_tenant_id', true) = ''
      OR current_setting('app.current_tenant_id', true) = 'bypass'
      OR tenant_id = public.app_current_tenant_id_uuid()
    )
    WITH CHECK (
      current_setting('app.current_tenant_id', true) IS NULL
      OR current_setting('app.current_tenant_id', true) = ''
      OR current_setting('app.current_tenant_id', true) = 'bypass'
      OR tenant_id = public.app_current_tenant_id_uuid()
    )
  $policy$;

  EXECUTE 'DROP POLICY IF EXISTS icu_code_status_history_explicit_context ON public.icu_code_status_history';
  EXECUTE $policy$
    CREATE POLICY icu_code_status_history_explicit_context
    ON public.icu_code_status_history
    AS RESTRICTIVE
    USING (
      current_setting('app.current_tenant_id', true) IS NOT NULL
      AND current_setting('app.current_tenant_id', true) <> ''
      AND current_setting('app.current_tenant_id', true) <> 'bypass'
      AND tenant_id = public.app_current_tenant_id_uuid()
    )
    WITH CHECK (
      current_setting('app.current_tenant_id', true) IS NOT NULL
      AND current_setting('app.current_tenant_id', true) <> ''
      AND current_setting('app.current_tenant_id', true) <> 'bypass'
      AND tenant_id = public.app_current_tenant_id_uuid()
    )
  $policy$;
END $$;

-- The ICU history table is append-only clinical evidence. Preserve that
-- evidence on parent deletion with an explicit restrictive FK instead of the
-- old CASCADE, whose delete trigger turned the cascade into an opaque failure.
DROP INDEX CONCURRENTLY IF EXISTS public.ux_icu_admissions_tenant_invalid_rebuild;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index
     WHERE indexrelid = to_regclass('public.ux_icu_admissions_tenant_id')
       AND NOT indisvalid
  ) THEN
    ALTER INDEX public.ux_icu_admissions_tenant_id
      RENAME TO ux_icu_admissions_tenant_invalid_rebuild;
  END IF;
END $$;
DROP INDEX CONCURRENTLY IF EXISTS public.ux_icu_admissions_tenant_invalid_rebuild;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ux_icu_admissions_tenant_id
  ON public.icu_admissions (tenant_id, id);

-- Keep the deprecated provenance column through the rolling deployment: pods
-- from the preceding release still write it. Current patient identity is
-- resolved through icu_admission_id; physical removal is a later contract
-- migration after all compatibility writers have been retired.
ALTER TABLE public.icu_code_status_history
  ADD COLUMN IF NOT EXISTS patient_uid UUID;

COMMENT ON COLUMN public.icu_code_status_history.patient_uid IS
  'DEPRECATED immutable provenance for rolling-write compatibility; resolve current patient identity through icu_admission_id';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.icu_code_status_history'::regclass
       AND tgname = 'trg_icu_code_status_history_append_only'
       AND NOT tgisinternal
  ) THEN
    EXECUTE $trigger$
      CREATE TRIGGER trg_icu_code_status_history_append_only
      BEFORE UPDATE OR DELETE ON public.icu_code_status_history
      FOR EACH ROW EXECUTE FUNCTION public.audit_append_only_guard()
    $trigger$;
  END IF;
END $$;

ALTER TABLE public.icu_code_status_history
  ALTER COLUMN tenant_id SET DEFAULT COALESCE(
    NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.icu_code_status_history'::regclass
       AND conname = 'fk_icu_code_status_history_tenant'
  ) THEN
    ALTER TABLE public.icu_code_status_history
      ADD CONSTRAINT fk_icu_code_status_history_tenant
      FOREIGN KEY (tenant_id)
      REFERENCES public.tenants (id)
      ON DELETE RESTRICT
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.icu_code_status_history'::regclass
       AND conname = 'fk_icu_code_status_history_admission_tenant'
  ) THEN
    ALTER TABLE public.icu_code_status_history
      ADD CONSTRAINT fk_icu_code_status_history_admission_tenant
      FOREIGN KEY (tenant_id, icu_admission_id)
      REFERENCES public.icu_admissions (tenant_id, id)
      ON DELETE RESTRICT
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.users'::regclass
       AND conname = 'chk_users_token_epoch_nonnegative'
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT chk_users_token_epoch_nonnegative
      CHECK (token_epoch >= 0) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.admins'::regclass
       AND conname = 'chk_admins_token_epoch_nonnegative'
  ) THEN
    ALTER TABLE public.admins
      ADD CONSTRAINT chk_admins_token_epoch_nonnegative
      CHECK (token_epoch >= 0) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.users'::regclass
       AND conname = 'chk_users_abha_verification_status'
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT chk_users_abha_verification_status
      CHECK (abha_verification_status IN ('pending', 'verified')) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.news2_scores'::regclass
       AND conname = 'fk_news2_scores_vitals_chart'
  ) THEN
    ALTER TABLE public.news2_scores
      ADD CONSTRAINT fk_news2_scores_vitals_chart
      FOREIGN KEY (vitals_chart_id) REFERENCES public.vitals_chart (id)
      ON DELETE SET NULL NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.news2_scores'::regclass
       AND conname = 'fk_news2_scores_superseded_by'
  ) THEN
    ALTER TABLE public.news2_scores
      ADD CONSTRAINT fk_news2_scores_superseded_by
      FOREIGN KEY (superseded_by_id) REFERENCES public.news2_scores (id)
      ON DELETE SET NULL NOT VALID;
  END IF;
END $$;

ALTER TABLE public.icu_code_status_history
  VALIDATE CONSTRAINT fk_icu_code_status_history_tenant;
ALTER TABLE public.icu_code_status_history
  VALIDATE CONSTRAINT fk_icu_code_status_history_admission_tenant;

-- Keep the legacy admission FK until the tenant-bound replacement is fully
-- validated. An interruption before this statement leaves both constraints
-- active; replay then removes only the weaker CASCADE relationship.
ALTER TABLE public.icu_code_status_history
  DROP CONSTRAINT IF EXISTS icu_code_status_history_icu_admission_id_fkey;

ALTER TABLE public.users
  VALIDATE CONSTRAINT chk_users_token_epoch_nonnegative;
ALTER TABLE public.admins
  VALIDATE CONSTRAINT chk_admins_token_epoch_nonnegative;
ALTER TABLE public.users
  VALIDATE CONSTRAINT chk_users_abha_verification_status;
ALTER TABLE public.news2_scores
  VALIDATE CONSTRAINT fk_news2_scores_vitals_chart;
ALTER TABLE public.news2_scores
  VALIDATE CONSTRAINT fk_news2_scores_superseded_by;

-- Converge the verified-only ABHA uniqueness index even if a prior concurrent
-- build was interrupted. A valid existing canonical index remains in place
-- until the verified replacement has finished building.
DROP INDEX CONCURRENTLY IF EXISTS public.uniq_users_abha_canonical_invalid_rebuild;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index
     WHERE indexrelid = to_regclass('public.uniq_users_tenant_abha_number_canonical')
       AND NOT indisvalid
  ) THEN
    ALTER INDEX public.uniq_users_tenant_abha_number_canonical
      RENAME TO uniq_users_abha_canonical_invalid_rebuild;
  END IF;
END $$;
DROP INDEX CONCURRENTLY IF EXISTS public.uniq_users_abha_canonical_invalid_rebuild;

DROP INDEX CONCURRENTLY IF EXISTS public.uniq_users_abha_verified_invalid_rebuild;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index
     WHERE indexrelid = to_regclass(
       'public.uniq_users_tenant_abha_number_canonical_verified_build'
     )
       AND NOT indisvalid
  ) THEN
    ALTER INDEX public.uniq_users_tenant_abha_number_canonical_verified_build
      RENAME TO uniq_users_abha_verified_invalid_rebuild;
  END IF;
END $$;
DROP INDEX CONCURRENTLY IF EXISTS public.uniq_users_abha_verified_invalid_rebuild;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uniq_users_tenant_abha_number_canonical_verified_build
  ON public.users (tenant_id, (regexp_replace(abha_number, '-', '', 'g')))
  WHERE abha_number IS NOT NULL
    AND btrim(abha_number) <> ''
    AND abha_verification_status = 'verified';

DROP INDEX CONCURRENTLY IF EXISTS public.uniq_users_tenant_abha_number_canonical;
ALTER INDEX IF EXISTS public.uniq_users_tenant_abha_number_canonical_verified_build
  RENAME TO uniq_users_tenant_abha_number_canonical;

-- Reconcile genuine historical partial scores and repair all-null rows that
-- the previously recorded unbounded 652 migration mislabeled as partial.
WITH derived AS (
  SELECT id,
         NUM_NONNULLS(respiration_rate, spo2, temperature, systolic_bp,
                      heart_rate, consciousness) AS present_count,
         ARRAY_REMOVE(ARRAY[
           CASE WHEN respiration_rate IS NULL THEN 'respiration_rate' END,
           CASE WHEN spo2 IS NULL THEN 'spo2' END,
           CASE WHEN temperature IS NULL THEN 'temperature' END,
           CASE WHEN systolic_bp IS NULL THEN 'systolic_bp' END,
           CASE WHEN heart_rate IS NULL THEN 'heart_rate' END,
           CASE WHEN consciousness IS NULL THEN 'consciousness' END
         ], NULL) AS missing
    FROM public.news2_scores
)
UPDATE public.news2_scores AS score
   SET partial_score = (derived.present_count BETWEEN 1 AND 5),
       missing_params = CASE
         WHEN derived.present_count BETWEEN 1 AND 5 THEN derived.missing
         ELSE NULL
       END
  FROM derived
 WHERE score.id = derived.id
   AND derived.present_count BETWEEN 0 AND 5
   AND (
     score.partial_score IS DISTINCT FROM (derived.present_count BETWEEN 1 AND 5)
     OR score.missing_params IS DISTINCT FROM CASE
       WHEN derived.present_count BETWEEN 1 AND 5 THEN derived.missing
       ELSE NULL
     END
   );

WITH derived AS (
  SELECT id,
         ARRAY_REMOVE(ARRAY[
           CASE WHEN NULLIF(BTRIM(COALESCE(inputs->>'rr', inputs->>'respiratory_rate')), '') IS NULL THEN 'respiration_rate' END,
           CASE WHEN NULLIF(BTRIM(inputs->>'spo2'), '') IS NULL THEN 'spo2' END,
           CASE WHEN NULLIF(BTRIM(COALESCE(inputs->>'temp_c', inputs->>'temperature')), '') IS NULL THEN 'temperature' END,
           CASE WHEN NULLIF(BTRIM(COALESCE(inputs->>'sbp', inputs->>'systolic_bp')), '') IS NULL THEN 'systolic_bp' END,
           CASE WHEN NULLIF(BTRIM(COALESCE(inputs->>'hr', inputs->>'pulse', inputs->>'heart_rate')), '') IS NULL THEN 'heart_rate' END,
           CASE WHEN NULLIF(BTRIM(inputs->>'consciousness'), '') IS NULL THEN 'consciousness' END
         ], NULL) AS missing
    FROM public.nursing_assessments
   WHERE assessment_kind = 'news2'
), counted AS (
  SELECT id, missing, 6 - CARDINALITY(missing) AS present_count
    FROM derived
)
UPDATE public.nursing_assessments AS assessment
   SET partial_score = (counted.present_count BETWEEN 1 AND 5),
       missing_params = CASE
         WHEN counted.present_count BETWEEN 1 AND 5 THEN counted.missing
         ELSE NULL
       END
  FROM counted
 WHERE assessment.id = counted.id
   AND counted.present_count BETWEEN 0 AND 5
   AND (
     assessment.partial_score IS DISTINCT FROM (counted.present_count BETWEEN 1 AND 5)
     OR assessment.missing_params IS DISTINCT FROM CASE
       WHEN counted.present_count BETWEEN 1 AND 5 THEN counted.missing
       ELSE NULL
     END
   );

DROP INDEX CONCURRENTLY IF EXISTS public.idx_news2_vitals_invalid_rebuild;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index
     WHERE indexrelid = to_regclass('public.idx_news2_scores_vitals_chart')
       AND NOT indisvalid
  ) THEN
    ALTER INDEX public.idx_news2_scores_vitals_chart
      RENAME TO idx_news2_vitals_invalid_rebuild;
  END IF;
END $$;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_news2_vitals_invalid_rebuild;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_news2_scores_vitals_chart
  ON public.news2_scores (vitals_chart_id)
  WHERE vitals_chart_id IS NOT NULL AND superseded_at IS NULL;
