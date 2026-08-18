-- Migration 719: fix the migration-618 abdm_webhook_events DELETE no-op.
--
-- Bug (recorded in PR #878's body, pre-existing on main): migration 618's
-- assert_abdm_i16_receipt_immutable() ends with a single `RETURN NEW`. In a
-- BEFORE DELETE trigger NEW is NULL, and a BEFORE ROW trigger returning NULL
-- silently skips the operation for that row — so every DELETE on
-- abdm_webhook_events that reached the fall-through (rows with
-- receipt_source IS NULL, i.e. the legacy webhook ledger rows that predate
-- the I16 receipt contract) was silently dropped: DELETE reported 0 rows,
-- no error, and the rows stayed behind. Retention/cleanup deletes of legacy
-- rows therefore silently failed while appearing to succeed.
--
-- Intent evidence (618's own text):
--   * The guard's entire enforcement scope opens with
--     `IF OLD.receipt_source IS NOT NULL` — only I16 callback receipts are
--     append-only, and for those the DELETE leg already RAISEs
--     (SQLSTATE 23514, synthetic constraint label
--     chk_abdm_i16_receipt_append_only), pinned by
--     src/tests/deep/abdmCallbackRecoveryMigration.deep.test.js.
--   * 618's header: "The predicate is scoped to recovery rows so the
--     historical live access contract is not silently rewritten in this
--     PR." Legacy (non-receipt) rows keep their pre-618 contract, which
--     included being deletable.
--
-- Fix: recreate the function with an explicit DELETE fall-through that
-- returns OLD, so a DELETE of a non-receipt row actually deletes it. The
-- receipt legs are unchanged: DELETE of a receipt-sourced row still raises,
-- UPDATE immutability is untouched. The trigger binding
-- (abdm_i16_receipt_immutable BEFORE UPDATE OR DELETE) is unchanged and
-- keeps pointing at this function name.
--
-- Idempotent: CREATE OR REPLACE FUNCTION only; safe to re-run.

BEGIN;

CREATE OR REPLACE FUNCTION public.assert_abdm_i16_receipt_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.receipt_source IS NOT NULL THEN
    IF TG_OP OPERATOR(pg_catalog.=) 'DELETE' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_abdm_i16_receipt_append_only',
        MESSAGE = 'I16 callback receipts are append-only';
    END IF;

    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.external_event_id IS DISTINCT FROM OLD.external_event_id
       OR NEW.event_type IS DISTINCT FROM OLD.event_type
       OR NEW.receipt_source IS DISTINCT FROM OLD.receipt_source
       OR NEW.callback_path IS DISTINCT FROM OLD.callback_path
       OR NEW.provider_identity_kind IS DISTINCT FROM OLD.provider_identity_kind
       OR NEW.provider_identity_value IS DISTINCT FROM OLD.provider_identity_value
       OR NEW.raw_body_ciphertext IS DISTINCT FROM OLD.raw_body_ciphertext
       OR NEW.raw_body_sha256 IS DISTINCT FROM OLD.raw_body_sha256
       OR NEW.raw_body_bytes IS DISTINCT FROM OLD.raw_body_bytes
       OR NEW.auth_binding_sha256 IS DISTINCT FROM OLD.auth_binding_sha256
       OR NEW.authenticated_at IS DISTINCT FROM OLD.authenticated_at
       OR NEW.signature_verified IS DISTINCT FROM OLD.signature_verified
       OR (OLD.recovery_inbox_id IS NOT NULL AND (
         NEW.recovery_inbox_id IS DISTINCT FROM OLD.recovery_inbox_id
         OR NEW.recovery_interface_family IS DISTINCT FROM OLD.recovery_interface_family
         OR NEW.recovery_owner_uid IS DISTINCT FROM OLD.recovery_owner_uid
         OR NEW.recovery_owner_reason IS DISTINCT FROM OLD.recovery_owner_reason
         OR NEW.recovery_disposition IS DISTINCT FROM OLD.recovery_disposition
         OR NEW.source_partition IS DISTINCT FROM OLD.source_partition
         OR NEW.source_position IS DISTINCT FROM OLD.source_position
         OR NEW.source_token IS DISTINCT FROM OLD.source_token
         OR NEW.predecessor_token IS DISTINCT FROM OLD.predecessor_token
         OR NEW.duplicate_key IS DISTINCT FROM OLD.duplicate_key
         OR NEW.related_data_request_id IS DISTINCT FROM OLD.related_data_request_id
         OR NEW.status IS DISTINCT FROM OLD.status
       )) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_abdm_i16_receipt_append_only',
        MESSAGE = 'I16 callback receipt identity, exact bytes, and recovery disposition are immutable';
    END IF;
  END IF;

  -- 618's bug was here: an unconditional `RETURN NEW` is NULL under DELETE,
  -- which silently skips the delete of every non-receipt row. Legacy rows
  -- (receipt_source IS NULL) are outside the I16 append-only contract and
  -- must actually delete.
  IF TG_OP OPERATOR(pg_catalog.=) 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
