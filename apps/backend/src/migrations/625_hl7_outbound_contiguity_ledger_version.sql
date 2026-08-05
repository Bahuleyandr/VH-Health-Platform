-- Migration 625: index the I04 outbound contiguity scan by ledger generation.
--
-- Migration 610 introduced hl7_outbound_messages.ledger_version and backfilled
-- EVERY pre-existing row to ledger_version = 0 with
-- acknowledgement_state = 'legacy_unknown' (610:39-49). Those rows are held
-- deliberately: the old worker did not retain response bodies, so a historical
-- row can never prove a correlated MSA|AA and can never reach
-- acknowledgement_state = 'aa'.
--
-- The delivery contiguity predicate — "no earlier message on this subscription
-- is still unacknowledged" — must therefore be evaluated over the ledger
-- generation ONLY (ledger_version = 1). Scanning ledger_version = 0 rows makes
-- contiguity unsatisfiable forever on any feed that carries pre-610 history,
-- because message ids are IDENTITY-allocated and every new message sorts after
-- the whole legacy backlog. That predicate lives in service SQL
-- (services/hl7/hl7OutboundDeliveryLedgerService.js, claimPendingFeedMessages
-- and applyAcknowledgementToCursorTx) and is corrected in the same change as
-- this migration; there is no DDL-side contiguity rule to amend.
--
-- This migration adds the covering index that the corrected predicate needs.
-- Without it the "is there an earlier unacknowledged ledger message" probe has
-- no generation-aware index and degrades to scanning the subscription's whole
-- history on every delivery pass — precisely the environments that carry the
-- legacy backlog this defect was hiding behind.
--
-- Safe on an environment where 610 has already run, and on a fresh chain:
-- additive, no data is read or rewritten, and no existing index is dropped.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '180s';

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Matches the corrected predicate exactly:
--   earlier.tenant_id = ... AND earlier.subscription_id = ...
--   AND earlier.id < ... AND earlier.ledger_version = 1
--   AND earlier.acknowledgement_state <> 'aa'
-- so the NOT EXISTS resolves to a single index probe for the lowest
-- unacknowledged ledger message rather than a per-pass history scan.
CREATE INDEX IF NOT EXISTS idx_hl7_outbound_messages_contiguity_gap
  ON public.hl7_outbound_messages (tenant_id, subscription_id, id)
  WHERE ledger_version = 1 AND acknowledgement_state <> 'aa';

COMMENT ON INDEX public.idx_hl7_outbound_messages_contiguity_gap IS
  'I04 delivery contiguity: lowest unacknowledged ledger_version=1 message per '
  'subscription. Pre-610 rows (ledger_version=0) are excluded on purpose — they '
  'can never reach acknowledgement_state=''aa'' and must never gate delivery.';

COMMIT;
