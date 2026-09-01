-- 749_prisma_relation_cardinality_contracts.sql
-- Preserve exact MED-03 relationship invariants without exposing false
-- one-to-one cardinality to Prisma introspection.

BEGIN;

ALTER TABLE billing_refunds
  DROP CONSTRAINT IF EXISTS fk_billing_refund_offline_evidence_747;

CREATE OR REPLACE FUNCTION billing_refund_offline_evidence_reference_guard_749()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF NEW.offline_electronic_evidence_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM billing_refund_offline_electronic_evidence evidence
     WHERE evidence.tenant_id = NEW.tenant_id
       AND evidence.refund_id = NEW.id
       AND evidence.id = NEW.offline_electronic_evidence_id
  ) THEN
    RAISE EXCEPTION 'billing refund offline evidence reference is not exact'
      USING ERRCODE = '23503';
  END IF;

  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION billing_refund_offline_evidence_reverse_guard_749()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM billing_refunds refund
     WHERE refund.tenant_id = OLD.tenant_id
       AND refund.id = OLD.refund_id
       AND refund.offline_electronic_evidence_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'referenced billing refund offline evidence is immutable'
      USING ERRCODE = '23503';
  END IF;

  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS billing_refund_offline_evidence_reference_749
  ON billing_refunds;
CREATE CONSTRAINT TRIGGER billing_refund_offline_evidence_reference_749
  AFTER INSERT OR UPDATE OF tenant_id, id, offline_electronic_evidence_id
  ON billing_refunds
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.offline_electronic_evidence_id IS NOT NULL)
  EXECUTE FUNCTION billing_refund_offline_evidence_reference_guard_749();

DROP TRIGGER IF EXISTS billing_refund_offline_evidence_reverse_update_749
  ON billing_refund_offline_electronic_evidence;
CREATE CONSTRAINT TRIGGER billing_refund_offline_evidence_reverse_update_749
  AFTER UPDATE OF tenant_id, refund_id, id
  ON billing_refund_offline_electronic_evidence
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (
    OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.refund_id IS DISTINCT FROM NEW.refund_id
    OR OLD.id IS DISTINCT FROM NEW.id
  )
  EXECUTE FUNCTION billing_refund_offline_evidence_reverse_guard_749();

DROP TRIGGER IF EXISTS billing_refund_offline_evidence_reverse_delete_749
  ON billing_refund_offline_electronic_evidence;
CREATE CONSTRAINT TRIGGER billing_refund_offline_evidence_reverse_delete_749
  AFTER DELETE
  ON billing_refund_offline_electronic_evidence
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION billing_refund_offline_evidence_reverse_guard_749();

ALTER TABLE mar_medication_exception_cases
  DROP CONSTRAINT IF EXISTS fk_mar_medication_exception_order_context;

CREATE OR REPLACE FUNCTION mar_medication_exception_order_context_guard_749()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF NEW.clinical_order_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM medication_administrations administration
        WHERE administration.tenant_id = NEW.tenant_id
          AND administration.id = NEW.medication_administration_id
          AND administration.clinical_order_id = NEW.clinical_order_id
     )
  THEN
    RAISE EXCEPTION 'MAR medication exception order context does not match the administration'
      USING ERRCODE = '23503';
  END IF;

  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION mar_medication_exception_order_context_parent_guard_749()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF OLD.clinical_order_id IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM mar_medication_exception_cases exception_case
        WHERE exception_case.tenant_id = OLD.tenant_id
          AND exception_case.medication_administration_id = OLD.id
          AND exception_case.clinical_order_id = OLD.clinical_order_id
     )
  THEN
    RAISE EXCEPTION 'MAR administration order context is referenced by medication exception evidence'
      USING ERRCODE = '23503';
  END IF;

  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS mar_medication_exception_order_context_749
  ON mar_medication_exception_cases;
CREATE TRIGGER mar_medication_exception_order_context_749
  BEFORE INSERT OR UPDATE OF tenant_id, medication_administration_id, clinical_order_id
  ON mar_medication_exception_cases
  FOR EACH ROW
  EXECUTE FUNCTION mar_medication_exception_order_context_guard_749();

DROP TRIGGER IF EXISTS mar_medication_exception_order_context_parent_749
  ON medication_administrations;
CREATE TRIGGER mar_medication_exception_order_context_parent_749
  BEFORE UPDATE OF tenant_id, id, clinical_order_id
  ON medication_administrations
  FOR EACH ROW
  WHEN (
    OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.id IS DISTINCT FROM NEW.id
    OR OLD.clinical_order_id IS DISTINCT FROM NEW.clinical_order_id
  )
  EXECUTE FUNCTION mar_medication_exception_order_context_parent_guard_749();

DO $runtime_function_acl_749$
DECLARE
  runtime_role TEXT;
  function_name TEXT;
BEGIN
  FOREACH function_name IN ARRAY ARRAY[
    'billing_refund_offline_evidence_reference_guard_749',
    'billing_refund_offline_evidence_reverse_guard_749',
    'mar_medication_exception_order_context_guard_749',
    'mar_medication_exception_order_context_parent_guard_749'
  ]::TEXT[]
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.%I() FROM PUBLIC',
      function_name
    );

    FOREACH runtime_role IN ARRAY ARRAY['vhhealth_app', 'vhhealth_runtime']::TEXT[]
    LOOP
      IF pg_catalog.to_regrole(runtime_role) IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON FUNCTION public.%I() FROM %I',
          function_name,
          runtime_role
        );
      END IF;
    END LOOP;
  END LOOP;
END
$runtime_function_acl_749$;

COMMENT ON FUNCTION billing_refund_offline_evidence_reference_guard_749() IS
  'Deferred exact-reference replacement for the Prisma-incompatible composite refund evidence foreign key.';
COMMENT ON FUNCTION billing_refund_offline_evidence_reverse_guard_749() IS
  'Prevents audit-owner maintenance from orphaning exact offline refund evidence bindings.';
COMMENT ON FUNCTION mar_medication_exception_order_context_guard_749() IS
  'Preserves the medication-administration clinical-order match while allowing repeated resolved exception history.';
COMMENT ON FUNCTION mar_medication_exception_order_context_parent_guard_749() IS
  'Prevents medication administration order-context changes from orphaning exception evidence.';

COMMIT;
