-- 649_pharmacy_order_status_transition_guard.sql
--
-- 2026-08-10 full re-review, finding H2: the legacy staff pharmacy endpoint
-- (services/staff/pharmacyService.updatePharmacyOrderStatus) could write any
-- string into pharmacy_orders.status — it bypassed both the
-- ORDER_STATUS_TRANSITIONS state machine (config/pharmacyConfig.js) and the
-- BCMA pharmacist-verification gate, and stamped off-vocabulary lowercase
-- statuses ('dispensed', 'preparing'). That endpoint is deleted in the same
-- change; this trigger is the DB backstop so no future code path can bypass
-- the state machine again.
--
-- Enforced here (BEFORE INSERT OR UPDATE trigger — transition validation
-- needs OLD row context, so a CHECK constraint cannot express it):
--   1. Vocabulary — a NEW or CHANGED status must be one of the canonical
--      UPPERCASE values live code writes:
--        PENDING CONFIRMED PREPARING READY DISPATCHED DELIVERED DISPENSED
--        UNAVAILABLE CANCELLED  (+ FHIR-import-only ON_HOLD / REJECTED,
--        services/import/patientDataImport.js statusMap).
--   2. Transitions — the union of every legitimate app path:
--        orderService.updateOrderStatus (ORDER_STATUS_TRANSITIONS),
--        pharmacyOrderController confirm / markPreparing / dispatchOrder /
--        markDelivered / markCounterDispensed / markUnavailable / cancelOrder.
--      DELIVERED / DISPENSED / CANCELLED / UNAVAILABLE are terminal.
--
-- Deliberately NOT enforced here: the pharmacist clinical-verification gate.
-- BCMA_CONFIG.requirePharmacistVerification is an env-toggleable staged-
-- rollout switch (config/pharmacyConfig.js) that the DB cannot see; with the
-- legacy endpoint gone, every remaining writer passes through the app gate,
-- and this trigger's transition closure means DISPENSED/DISPATCHED/DELIVERED
-- are unreachable without walking the gated states.
--
-- Grandfathering: rows already carrying a legacy off-vocabulary status are
-- untouched (the trigger fires only on new writes, and non-status column
-- updates on such rows stay legal). A status CHANGE away from an
-- off-vocabulary value may go to any canonical status — the data-repair
-- path — but never to another off-vocabulary value.
--
-- Raise style follows migrations 609/610: SQLSTATE 23514 with a synthetic
-- CONSTRAINT label for client pattern-matching (no pg_constraint row exists
-- by that name).

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.validate_pharmacy_order_status_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  canonical CONSTANT text[] := ARRAY[
    'PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'DISPATCHED',
    'DELIVERED', 'DISPENSED', 'UNAVAILABLE', 'CANCELLED',
    'ON_HOLD', 'REJECTED'
  ];
  allowed text[];
BEGIN
  -- Only status writes are policed: INSERTs, and UPDATEs that change status.
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS NULL OR NOT (NEW.status = ANY (canonical)) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_pharmacy_order_status_vocabulary',
      MESSAGE = FORMAT('Pharmacy order status %L is not in the canonical vocabulary', NEW.status);
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Legacy off-vocabulary rows: any canonical target is a permitted
    -- repair; no transition map applies.
    IF OLD.status IS NULL OR NOT (OLD.status = ANY (canonical)) THEN
      RETURN NEW;
    END IF;

    allowed := CASE OLD.status
      WHEN 'PENDING'    THEN ARRAY['CONFIRMED', 'DISPENSED', 'UNAVAILABLE', 'CANCELLED']
      WHEN 'CONFIRMED'  THEN ARRAY['PREPARING', 'DISPATCHED', 'DISPENSED', 'UNAVAILABLE', 'CANCELLED']
      WHEN 'PREPARING'  THEN ARRAY['READY', 'DISPATCHED', 'UNAVAILABLE', 'CANCELLED']
      WHEN 'READY'      THEN ARRAY['DISPATCHED', 'UNAVAILABLE', 'CANCELLED']
      WHEN 'DISPATCHED' THEN ARRAY['DELIVERED', 'UNAVAILABLE', 'CANCELLED']
      WHEN 'ON_HOLD'    THEN ARRAY['UNAVAILABLE', 'CANCELLED']
      WHEN 'REJECTED'   THEN ARRAY['UNAVAILABLE', 'CANCELLED']
      ELSE ARRAY[]::text[]  -- DELIVERED / DISPENSED / CANCELLED / UNAVAILABLE are terminal
    END;

    IF NOT (NEW.status = ANY (allowed)) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_pharmacy_order_status_transition',
        MESSAGE = FORMAT('Pharmacy order transition %s -> %s is not allowed', OLD.status, NEW.status);
    END IF;
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS pharmacy_order_status_transition_guard
  ON public.pharmacy_orders;
CREATE TRIGGER pharmacy_order_status_transition_guard
BEFORE INSERT OR UPDATE ON public.pharmacy_orders
FOR EACH ROW EXECUTE FUNCTION public.validate_pharmacy_order_status_transition();

COMMIT;
