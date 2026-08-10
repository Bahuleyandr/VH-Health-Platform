-- Migration 656: durable FHIR vital-observation replay receipts.
--
-- One clinical vitals row may compose several same-patient, same-time FHIR
-- Observation resources. Per-resource receipts preserve that provenance while
-- the set receipt serializes exact concurrent replays and links the composite
-- write to its vitals_chart row in the same transaction.
-- @no-transaction
-- @statement_timeout: 0

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

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
    ON UPDATE NO ACTION ON DELETE NO ACTION,
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
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_fhir_vital_observation_set_importer
    FOREIGN KEY (tenant_id, imported_by) REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_fhir_vital_observation_set_vitals
    FOREIGN KEY (vitals_chart_id)
    REFERENCES public.vitals_chart(id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_fhir_vital_observation_set_fingerprint
    CHECK (set_fingerprint ~ '^fhir-set:[0-9a-f]{64}$')
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

CREATE OR REPLACE FUNCTION public.validate_fhir_vital_observation_set_link()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.vitals_chart_id IS NOT NULL AND (
      NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.set_fingerprint IS DISTINCT FROM OLD.set_fingerprint
      OR NEW.patient_uid IS DISTINCT FROM OLD.patient_uid
      OR NEW.observed_at IS DISTINCT FROM OLD.observed_at
      OR NEW.vitals_chart_id IS DISTINCT FROM OLD.vitals_chart_id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_fhir_vital_observation_set_link_immutable',
        MESSAGE = 'FHIR Observation set linkage is immutable after first assignment';
    END IF;
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
  BEFORE INSERT OR UPDATE OF tenant_id, set_fingerprint, patient_uid, observed_at, vitals_chart_id
  ON public.fhir_vital_observation_sets
  FOR EACH ROW EXECUTE FUNCTION public.validate_fhir_vital_observation_set_link();
END
$trigger$;

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
      'GRANT SELECT, INSERT ON public.fhir_vital_observation_receipts TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE UPDATE, DELETE, TRUNCATE ON public.fhir_vital_observation_receipts FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT SELECT, INSERT ON public.fhir_vital_observation_sets TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT UPDATE (vitals_chart_id) ON public.fhir_vital_observation_sets TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE DELETE, TRUNCATE ON public.fhir_vital_observation_sets FROM %I',
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
      'REVOKE ALL PRIVILEGES ON FUNCTION public.validate_fhir_vital_observation_set_link() FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.validate_fhir_vital_observation_resource_owner() FROM %I',
      runtime_role
    );
  END LOOP;
END
$runtime_privileges$;
