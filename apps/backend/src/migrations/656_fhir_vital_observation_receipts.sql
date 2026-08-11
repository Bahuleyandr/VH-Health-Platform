-- Migration 656: durable FHIR vital-observation replay receipts.
--
-- One clinical vitals row may compose several same-patient, same-time FHIR
-- Observation resources. Per-resource receipts preserve that provenance while
-- the set receipt serializes exact concurrent replays and links the composite
-- write to its vitals_chart row in the same transaction.
-- @no-transaction
-- @statement_timeout: 0

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- FHIR sources cannot safely infer room air from absent oxygen-therapy
-- evidence. Preserve unknown as NULL while leaving the default false for
-- existing staff-authored NEWS2 writes that explicitly model room air.
ALTER TABLE public.news2_scores
  ALTER COLUMN supplemental_o2 DROP NOT NULL;

CREATE TABLE IF NOT EXISTS public.fhir_vital_observation_receipts (
  tenant_id UUID NOT NULL,
  resource_fingerprint VARCHAR(69) NOT NULL,
  patient_uid UUID NOT NULL,
  resource_id VARCHAR(255),
  observed_at TIMESTAMPTZ(6) NOT NULL,
  loinc_codes TEXT[] NOT NULL,
  imported_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT fhir_vital_observation_receipts_pkey
    PRIMARY KEY (tenant_id, resource_fingerprint),
  CONSTRAINT fk_fhir_vital_observation_receipt_tenant
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_fhir_vital_observation_receipt_patient
    FOREIGN KEY (tenant_id, patient_uid) REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT chk_fhir_vital_observation_resource_fingerprint
    CHECK (resource_fingerprint ~ '^fhir:[0-9a-f]{64}$'),
  CONSTRAINT chk_fhir_vital_observation_loinc_codes
    CHECK (cardinality(loinc_codes) > 0)
);

DROP INDEX CONCURRENTLY IF EXISTS public.ux_fhir_vital_logical_invalid_rebuild;

DO $invalid_logical_resource_index$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_index
     WHERE indexrelid = to_regclass('public.ux_fhir_vital_observation_receipt_logical_resource')
       AND NOT indisvalid
  ) THEN
    ALTER INDEX public.ux_fhir_vital_observation_receipt_logical_resource
      RENAME TO ux_fhir_vital_logical_invalid_rebuild;
  END IF;
END
$invalid_logical_resource_index$;

DROP INDEX CONCURRENTLY IF EXISTS public.ux_fhir_vital_logical_invalid_rebuild;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ux_fhir_vital_observation_receipt_logical_resource
  ON public.fhir_vital_observation_receipts
    (tenant_id, patient_uid, resource_id);

DROP INDEX CONCURRENTLY IF EXISTS public.idx_fhir_vital_receipts_invalid_rebuild;

DO $invalid_receipt_index$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_index
     WHERE indexrelid = to_regclass('public.idx_fhir_vital_observation_receipts_patient')
       AND NOT indisvalid
  ) THEN
    ALTER INDEX public.idx_fhir_vital_observation_receipts_patient
      RENAME TO idx_fhir_vital_receipts_invalid_rebuild;
  END IF;
END
$invalid_receipt_index$;

DROP INDEX CONCURRENTLY IF EXISTS public.idx_fhir_vital_receipts_invalid_rebuild;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_fhir_vital_observation_receipts_patient
  ON public.fhir_vital_observation_receipts
    (tenant_id, patient_uid, observed_at DESC);

CREATE TABLE IF NOT EXISTS public.fhir_vital_observation_sets (
  tenant_id UUID NOT NULL,
  set_fingerprint VARCHAR(73) NOT NULL,
  patient_uid UUID NOT NULL,
  observed_at TIMESTAMPTZ(6) NOT NULL,
  imported_by UUID NOT NULL,
  vitals_chart_id INTEGER,
  news2_effects_completed_at TIMESTAMPTZ(6),
  anomaly_effects_completed_at TIMESTAMPTZ(6),
  news2_effects_claimed_at TIMESTAMPTZ(6),
  news2_effects_claim_token UUID,
  news2_effects_attempts INTEGER NOT NULL DEFAULT 0,
  news2_effects_next_retry_at TIMESTAMPTZ(6),
  anomaly_effects_claimed_at TIMESTAMPTZ(6),
  anomaly_effects_claim_token UUID,
  anomaly_effects_attempts INTEGER NOT NULL DEFAULT 0,
  anomaly_effects_next_retry_at TIMESTAMPTZ(6),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT fhir_vital_observation_sets_pkey
    PRIMARY KEY (tenant_id, set_fingerprint),
  CONSTRAINT ux_fhir_vital_observation_set_vitals
    UNIQUE (tenant_id, vitals_chart_id),
  CONSTRAINT fk_fhir_vital_observation_set_tenant
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_fhir_vital_observation_set_patient
    FOREIGN KEY (tenant_id, patient_uid) REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_fhir_vital_observation_set_importer
    FOREIGN KEY (tenant_id, imported_by) REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_fhir_vital_observation_set_vitals
    FOREIGN KEY (vitals_chart_id)
    REFERENCES public.vitals_chart(id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_fhir_vital_observation_set_fingerprint
    CHECK (set_fingerprint ~ '^fhir-set:[0-9a-f]{64}$'),
  CONSTRAINT chk_fhir_vital_observation_set_effects_linked
    CHECK (
      (
        news2_effects_completed_at IS NULL
        AND anomaly_effects_completed_at IS NULL
        AND news2_effects_claimed_at IS NULL
        AND news2_effects_claim_token IS NULL
        AND news2_effects_next_retry_at IS NULL
        AND anomaly_effects_claimed_at IS NULL
        AND anomaly_effects_claim_token IS NULL
        AND anomaly_effects_next_retry_at IS NULL
      )
      OR vitals_chart_id IS NOT NULL
    ),
  CONSTRAINT chk_fhir_vital_observation_set_news2_claim
    CHECK (
      (news2_effects_claimed_at IS NULL) = (news2_effects_claim_token IS NULL)
      AND (news2_effects_completed_at IS NULL OR news2_effects_claimed_at IS NULL)
      AND (news2_effects_completed_at IS NULL OR news2_effects_next_retry_at IS NULL)
      AND news2_effects_attempts >= 0
    ),
  CONSTRAINT chk_fhir_vital_observation_set_anomaly_claim
    CHECK (
      (anomaly_effects_claimed_at IS NULL) = (anomaly_effects_claim_token IS NULL)
      AND (anomaly_effects_completed_at IS NULL OR anomaly_effects_claimed_at IS NULL)
      AND (anomaly_effects_completed_at IS NULL OR anomaly_effects_next_retry_at IS NULL)
      AND anomaly_effects_attempts >= 0
    )
);

-- CREATE TABLE IF NOT EXISTS does not add columns after an interrupted run
-- reached an older definition of this still-unmerged migration.
ALTER TABLE public.fhir_vital_observation_sets
  ADD COLUMN IF NOT EXISTS news2_effects_completed_at TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS anomaly_effects_completed_at TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS news2_effects_claimed_at TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS news2_effects_claim_token UUID,
  ADD COLUMN IF NOT EXISTS news2_effects_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS news2_effects_next_retry_at TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS anomaly_effects_claimed_at TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS anomaly_effects_claim_token UUID,
  ADD COLUMN IF NOT EXISTS anomaly_effects_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS anomaly_effects_next_retry_at TIMESTAMPTZ(6);

ALTER TABLE public.fhir_vital_observation_receipts
  ALTER CONSTRAINT fk_fhir_vital_observation_receipt_patient
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE public.fhir_vital_observation_sets
  ALTER CONSTRAINT fk_fhir_vital_observation_set_patient
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE public.fhir_vital_observation_sets
  DROP CONSTRAINT IF EXISTS chk_fhir_vital_observation_set_effects_linked,
  DROP CONSTRAINT IF EXISTS chk_fhir_vital_observation_set_news2_claim,
  DROP CONSTRAINT IF EXISTS chk_fhir_vital_observation_set_anomaly_claim;

ALTER TABLE public.fhir_vital_observation_sets
  ADD CONSTRAINT chk_fhir_vital_observation_set_effects_linked
    CHECK (
      (
        news2_effects_completed_at IS NULL
        AND anomaly_effects_completed_at IS NULL
        AND news2_effects_claimed_at IS NULL
        AND news2_effects_claim_token IS NULL
        AND news2_effects_next_retry_at IS NULL
        AND anomaly_effects_claimed_at IS NULL
        AND anomaly_effects_claim_token IS NULL
        AND anomaly_effects_next_retry_at IS NULL
      )
      OR vitals_chart_id IS NOT NULL
    ),
  ADD CONSTRAINT chk_fhir_vital_observation_set_news2_claim
    CHECK (
      (news2_effects_claimed_at IS NULL) = (news2_effects_claim_token IS NULL)
      AND (news2_effects_completed_at IS NULL OR news2_effects_claimed_at IS NULL)
      AND (news2_effects_completed_at IS NULL OR news2_effects_next_retry_at IS NULL)
      AND news2_effects_attempts >= 0
    ),
  ADD CONSTRAINT chk_fhir_vital_observation_set_anomaly_claim
    CHECK (
      (anomaly_effects_claimed_at IS NULL) = (anomaly_effects_claim_token IS NULL)
      AND (anomaly_effects_completed_at IS NULL OR anomaly_effects_claimed_at IS NULL)
      AND (anomaly_effects_completed_at IS NULL OR anomaly_effects_next_retry_at IS NULL)
      AND anomaly_effects_attempts >= 0
    );

DROP INDEX CONCURRENTLY IF EXISTS public.idx_fhir_vital_sets_invalid_rebuild;

DO $invalid_set_index$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_index
     WHERE indexrelid = to_regclass('public.idx_fhir_vital_observation_sets_patient')
       AND NOT indisvalid
  ) THEN
    ALTER INDEX public.idx_fhir_vital_observation_sets_patient
      RENAME TO idx_fhir_vital_sets_invalid_rebuild;
  END IF;
END
$invalid_set_index$;

DROP INDEX CONCURRENTLY IF EXISTS public.idx_fhir_vital_sets_invalid_rebuild;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_fhir_vital_observation_sets_patient
  ON public.fhir_vital_observation_sets
    (tenant_id, patient_uid, observed_at DESC);

DROP INDEX CONCURRENTLY IF EXISTS public.idx_fhir_vital_pending_effects_invalid_rebuild;

DO $invalid_pending_effects_index$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_index
     WHERE indexrelid = to_regclass('public.idx_fhir_vital_observation_sets_pending_effects')
       AND NOT indisvalid
  ) THEN
    ALTER INDEX public.idx_fhir_vital_observation_sets_pending_effects
      RENAME TO idx_fhir_vital_pending_effects_invalid_rebuild;
  END IF;
END
$invalid_pending_effects_index$;

DROP INDEX CONCURRENTLY IF EXISTS public.idx_fhir_vital_pending_effects_invalid_rebuild;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_fhir_vital_observation_sets_pending_effects
  ON public.fhir_vital_observation_sets (tenant_id, created_at, set_fingerprint)
  WHERE vitals_chart_id IS NOT NULL
    AND (news2_effects_completed_at IS NULL OR anomaly_effects_completed_at IS NULL);

CREATE TABLE IF NOT EXISTS public.fhir_vital_observation_set_resources (
  tenant_id UUID NOT NULL,
  set_fingerprint VARCHAR(73) NOT NULL,
  resource_fingerprint VARCHAR(69) NOT NULL,

  CONSTRAINT fhir_vital_observation_set_resources_pkey
    PRIMARY KEY (tenant_id, set_fingerprint, resource_fingerprint),
  CONSTRAINT ux_fhir_vital_observation_resource_owner
    UNIQUE (tenant_id, resource_fingerprint),
  CONSTRAINT fk_fhir_vital_observation_set_resource_set
    FOREIGN KEY (tenant_id, set_fingerprint)
    REFERENCES public.fhir_vital_observation_sets(tenant_id, set_fingerprint)
    ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT fk_fhir_vital_observation_set_resource_receipt
    FOREIGN KEY (tenant_id, resource_fingerprint)
    REFERENCES public.fhir_vital_observation_receipts(tenant_id, resource_fingerprint)
    ON UPDATE NO ACTION ON DELETE NO ACTION
);

CREATE OR REPLACE FUNCTION public.validate_fhir_vital_observation_receipt_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_setting('app.patient_merge_execution', true) IS DISTINCT FROM 'on'
    OR current_setting('app.patient_merge_tenant_id', true) IS DISTINCT FROM NEW.tenant_id::text
    OR current_setting('app.patient_merge_from_uid', true) IS DISTINCT FROM (to_jsonb(OLD) ->> 'patient_uid')
    OR current_setting('app.patient_merge_to_uid', true) IS DISTINCT FROM (to_jsonb(NEW) ->> 'patient_uid')
    OR NOT EXISTS (
      SELECT 1
        FROM public.patient_merge_requests AS merge_request
       WHERE merge_request.id::text = current_setting('app.patient_merge_request_id', true)
         AND merge_request.tenant_id = NEW.tenant_id
         AND merge_request.secondary_uid = (to_jsonb(OLD) ->> 'patient_uid')::uuid
         AND merge_request.primary_uid = (to_jsonb(NEW) ->> 'patient_uid')::uuid
         AND merge_request.status = 'approved'
         AND merge_request.continuity_disposition IS NULL
    )
    OR (to_jsonb(NEW) ->> 'patient_uid') IS NOT DISTINCT FROM (to_jsonb(OLD) ->> 'patient_uid')
    OR (to_jsonb(NEW) - 'patient_uid') IS DISTINCT FROM (to_jsonb(OLD) - 'patient_uid')
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_fhir_vital_observation_receipt_immutable',
      MESSAGE = 'FHIR Observation receipts are immutable outside a patient-merge identity rewrite';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.validate_fhir_vital_observation_receipt_update() FROM PUBLIC;

DO $receipt_update_trigger$
BEGIN
  DROP TRIGGER IF EXISTS fhir_vital_observation_receipt_update_guard
    ON public.fhir_vital_observation_receipts;
  CREATE TRIGGER fhir_vital_observation_receipt_update_guard
  BEFORE UPDATE ON public.fhir_vital_observation_receipts
  FOR EACH ROW EXECUTE FUNCTION public.validate_fhir_vital_observation_receipt_update();
END
$receipt_update_trigger$;

CREATE OR REPLACE FUNCTION public.validate_fhir_vital_observation_receipt_scope_deferred()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.fhir_vital_observation_set_resources AS links
      JOIN public.fhir_vital_observation_sets AS observation_set
        ON observation_set.tenant_id = links.tenant_id
       AND observation_set.set_fingerprint = links.set_fingerprint
     WHERE links.tenant_id = NEW.tenant_id
       AND links.resource_fingerprint = NEW.resource_fingerprint
       AND (
         observation_set.patient_uid IS DISTINCT FROM NEW.patient_uid
         OR observation_set.observed_at IS DISTINCT FROM NEW.observed_at
       )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_fhir_vital_observation_receipt_scope_deferred',
      MESSAGE = 'FHIR Observation receipt final patient scope must match its owning set';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.validate_fhir_vital_observation_receipt_scope_deferred() FROM PUBLIC;

DO $receipt_deferred_scope_trigger$
BEGIN
  DROP TRIGGER IF EXISTS fhir_vital_observation_receipt_scope_deferred
    ON public.fhir_vital_observation_receipts;
  CREATE CONSTRAINT TRIGGER fhir_vital_observation_receipt_scope_deferred
  AFTER UPDATE OF patient_uid ON public.fhir_vital_observation_receipts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_fhir_vital_observation_receipt_scope_deferred();
END
$receipt_deferred_scope_trigger$;

CREATE OR REPLACE FUNCTION public.validate_fhir_vital_observation_set_link()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND current_setting('app.patient_merge_execution', true) = 'on'
    AND current_setting('app.patient_merge_tenant_id', true) IS NOT DISTINCT FROM NEW.tenant_id::text
    AND current_setting('app.patient_merge_from_uid', true) IS NOT DISTINCT FROM (to_jsonb(OLD) ->> 'patient_uid')
    AND current_setting('app.patient_merge_to_uid', true) IS NOT DISTINCT FROM (to_jsonb(NEW) ->> 'patient_uid')
    AND (to_jsonb(NEW) ->> 'patient_uid') IS DISTINCT FROM (to_jsonb(OLD) ->> 'patient_uid')
    AND (to_jsonb(NEW) - 'patient_uid') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'patient_uid')
    AND EXISTS (
      SELECT 1
        FROM public.patient_merge_requests AS merge_request
       WHERE merge_request.id::text = current_setting('app.patient_merge_request_id', true)
         AND merge_request.tenant_id = NEW.tenant_id
         AND merge_request.secondary_uid = (to_jsonb(OLD) ->> 'patient_uid')::uuid
         AND merge_request.primary_uid = (to_jsonb(NEW) ->> 'patient_uid')::uuid
         AND merge_request.status = 'approved'
         AND merge_request.continuity_disposition IS NULL
    )
  THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.vitals_chart_id IS NOT NULL AND (
      NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.set_fingerprint IS DISTINCT FROM OLD.set_fingerprint
      OR (to_jsonb(NEW) ->> 'patient_uid') IS DISTINCT FROM (to_jsonb(OLD) ->> 'patient_uid')
      OR NEW.observed_at IS DISTINCT FROM OLD.observed_at
      OR NEW.vitals_chart_id IS DISTINCT FROM OLD.vitals_chart_id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_fhir_vital_observation_set_link_immutable',
        MESSAGE = 'FHIR Observation set linkage is immutable after first assignment';
    END IF;
    IF (
      (OLD.news2_effects_completed_at IS NOT NULL
        AND (
          NEW.news2_effects_completed_at IS DISTINCT FROM OLD.news2_effects_completed_at
          OR NEW.news2_effects_attempts IS DISTINCT FROM OLD.news2_effects_attempts
          OR NEW.news2_effects_next_retry_at IS DISTINCT FROM OLD.news2_effects_next_retry_at
        ))
      OR (OLD.anomaly_effects_completed_at IS NOT NULL
        AND (
          NEW.anomaly_effects_completed_at IS DISTINCT FROM OLD.anomaly_effects_completed_at
          OR NEW.anomaly_effects_attempts IS DISTINCT FROM OLD.anomaly_effects_attempts
          OR NEW.anomaly_effects_next_retry_at IS DISTINCT FROM OLD.anomaly_effects_next_retry_at
        ))
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_fhir_vital_observation_set_effects_immutable',
        MESSAGE = 'Completed FHIR Observation set clinical effects are immutable';
    END IF;
  END IF;
  IF (
    (NEW.news2_effects_completed_at IS NOT NULL
      OR NEW.anomaly_effects_completed_at IS NOT NULL
      OR NEW.news2_effects_claimed_at IS NOT NULL
      OR NEW.news2_effects_next_retry_at IS NOT NULL
      OR NEW.anomaly_effects_claimed_at IS NOT NULL
      OR NEW.anomaly_effects_next_retry_at IS NOT NULL)
    AND NEW.vitals_chart_id IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_fhir_vital_observation_set_effects_linked',
      MESSAGE = 'FHIR Observation set clinical effects require a linked vitals row';
  END IF;
  IF NEW.vitals_chart_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.vitals_chart AS vitals
     WHERE vitals.id = NEW.vitals_chart_id
       AND vitals.tenant_id = NEW.tenant_id
       AND vitals.patient_uid = NEW.patient_uid
       AND vitals.source = 'fhir'
       AND vitals.source_device = NEW.set_fingerprint
       AND vitals.recorded_at = NEW.observed_at
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_fhir_vital_observation_set_vitals_scope',
      MESSAGE = 'FHIR Observation set must link to its same-tenant, same-patient FHIR vitals row';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.validate_fhir_vital_observation_set_link() FROM PUBLIC;

DO $trigger$
BEGIN
  DROP TRIGGER IF EXISTS fhir_vital_observation_set_link_scope
    ON public.fhir_vital_observation_sets;
  CREATE TRIGGER fhir_vital_observation_set_link_scope
  BEFORE INSERT OR UPDATE OF tenant_id, set_fingerprint, patient_uid, observed_at, vitals_chart_id,
    news2_effects_completed_at, news2_effects_claimed_at, news2_effects_claim_token,
    news2_effects_attempts, news2_effects_next_retry_at,
    anomaly_effects_completed_at, anomaly_effects_claimed_at, anomaly_effects_claim_token,
    anomaly_effects_attempts, anomaly_effects_next_retry_at
  ON public.fhir_vital_observation_sets
  FOR EACH ROW EXECUTE FUNCTION public.validate_fhir_vital_observation_set_link();
END
$trigger$;

CREATE OR REPLACE FUNCTION public.validate_fhir_vital_observation_set_scope_deferred()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.vitals_chart_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.vitals_chart AS vitals
     WHERE vitals.id = NEW.vitals_chart_id
       AND vitals.tenant_id = NEW.tenant_id
       AND vitals.patient_uid = NEW.patient_uid
       AND vitals.source = 'fhir'
       AND vitals.source_device = NEW.set_fingerprint
       AND vitals.recorded_at = NEW.observed_at
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_fhir_vital_observation_set_vitals_scope_deferred',
      MESSAGE = 'FHIR Observation set final patient scope must match its linked vitals row';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.fhir_vital_observation_set_resources AS links
      JOIN public.fhir_vital_observation_receipts AS receipts
        ON receipts.tenant_id = links.tenant_id
       AND receipts.resource_fingerprint = links.resource_fingerprint
     WHERE links.tenant_id = NEW.tenant_id
       AND links.set_fingerprint = NEW.set_fingerprint
       AND (
         receipts.patient_uid IS DISTINCT FROM NEW.patient_uid
         OR receipts.observed_at IS DISTINCT FROM NEW.observed_at
       )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_fhir_vital_observation_set_receipt_scope_deferred',
      MESSAGE = 'FHIR Observation set final patient scope must match all owned receipts';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.validate_fhir_vital_observation_set_scope_deferred() FROM PUBLIC;

DO $deferred_scope_trigger$
BEGIN
  DROP TRIGGER IF EXISTS fhir_vital_observation_set_scope_deferred
    ON public.fhir_vital_observation_sets;
  CREATE CONSTRAINT TRIGGER fhir_vital_observation_set_scope_deferred
  AFTER INSERT OR UPDATE
  ON public.fhir_vital_observation_sets
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_fhir_vital_observation_set_scope_deferred();
END
$deferred_scope_trigger$;

CREATE OR REPLACE FUNCTION public.validate_fhir_vital_observation_resource_owner()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.fhir_vital_observation_sets observation_set
      JOIN public.fhir_vital_observation_receipts receipt
        ON receipt.tenant_id = observation_set.tenant_id
       AND receipt.resource_fingerprint = NEW.resource_fingerprint
       AND receipt.patient_uid = observation_set.patient_uid
       AND receipt.observed_at = observation_set.observed_at
     WHERE observation_set.tenant_id = NEW.tenant_id
       AND observation_set.set_fingerprint = NEW.set_fingerprint
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_fhir_vital_observation_resource_owner_scope',
      MESSAGE = 'FHIR Observation receipt must match its owning set patient and observation time';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.validate_fhir_vital_observation_resource_owner() FROM PUBLIC;

DO $resource_owner_trigger$
BEGIN
  DROP TRIGGER IF EXISTS fhir_vital_observation_resource_owner_scope
    ON public.fhir_vital_observation_set_resources;
  CREATE TRIGGER fhir_vital_observation_resource_owner_scope
  BEFORE INSERT OR UPDATE OF tenant_id, set_fingerprint, resource_fingerprint
  ON public.fhir_vital_observation_set_resources
  FOR EACH ROW EXECUTE FUNCTION public.validate_fhir_vital_observation_resource_owner();
END
$resource_owner_trigger$;

DO $rls$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'fhir_vital_observation_receipts',
    'fhir_vital_observation_sets',
    'fhir_vital_observation_set_resources'
  ]
  LOOP
    EXECUTE FORMAT('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE FORMAT('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE FORMAT('DROP POLICY IF EXISTS tenant_isolation ON public.%I', table_name);
    EXECUTE FORMAT($policy$
      CREATE POLICY tenant_isolation
        ON public.%I
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
    $policy$, table_name);
    EXECUTE FORMAT(
      'DROP POLICY IF EXISTS fhir_vital_observation_explicit_context ON public.%I',
      table_name
    );
    EXECUTE FORMAT($policy$
      CREATE POLICY fhir_vital_observation_explicit_context
        ON public.%I
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
    $policy$, table_name);
  END LOOP;
END
$rls$;

DO $runtime_privileges$
DECLARE
  runtime_role TEXT;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['vhhealth_app', 'vhhealth_runtime']
  LOOP
    IF pg_catalog.to_regrole(runtime_role) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE FORMAT(
      'REVOKE UPDATE, DELETE, TRUNCATE ON public.fhir_vital_observation_receipts FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT SELECT, INSERT, UPDATE (patient_uid) ON public.fhir_vital_observation_receipts TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE UPDATE, DELETE, TRUNCATE ON public.fhir_vital_observation_sets FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT SELECT, INSERT ON public.fhir_vital_observation_sets TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT UPDATE (patient_uid, vitals_chart_id, news2_effects_completed_at, anomaly_effects_completed_at, news2_effects_claimed_at, news2_effects_claim_token, news2_effects_attempts, news2_effects_next_retry_at, anomaly_effects_claimed_at, anomaly_effects_claim_token, anomaly_effects_attempts, anomaly_effects_next_retry_at) ON public.fhir_vital_observation_sets TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT SELECT, INSERT ON public.fhir_vital_observation_set_resources TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE UPDATE, DELETE, TRUNCATE ON public.fhir_vital_observation_set_resources FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.validate_fhir_vital_observation_receipt_update() FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.validate_fhir_vital_observation_receipt_scope_deferred() FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.validate_fhir_vital_observation_set_link() FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.validate_fhir_vital_observation_set_scope_deferred() FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.validate_fhir_vital_observation_resource_owner() FROM %I',
      runtime_role
    );
  END LOOP;
END
$runtime_privileges$;
