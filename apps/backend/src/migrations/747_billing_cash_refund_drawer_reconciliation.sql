-- 747_billing_cash_refund_drawer_reconciliation.sql
--
-- Refund payout is money leaving the hospital. This migration makes every
-- supported payout rail carry immutable, tenant-bound execution evidence and
-- makes cash refunds part of the exact drawer that supplied the cash.

BEGIN;

ALTER TABLE cash_drawer_sessions
  ADD COLUMN IF NOT EXISTS cash_inflow_total NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS cash_refund_total NUMERIC(12,2);

-- Historical drawer closes pre-date explicit cash-refund membership. Preserve
-- their recorded net as inflow and truthfully record that no linked refund
-- evidence existed at the time.
UPDATE cash_drawer_sessions
   SET cash_inflow_total = system_total,
       cash_refund_total = 0
 WHERE status IN ('closed', 'reviewed')
   AND system_total IS NOT NULL
   AND cash_inflow_total IS NULL
   AND cash_refund_total IS NULL;

ALTER TABLE billing_refunds
  ADD COLUMN IF NOT EXISTS cash_drawer_session_id BIGINT,
  ADD COLUMN IF NOT EXISTS offline_electronic_evidence_id BIGINT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_cash_drawer_sessions_tenant_id_747
  ON cash_drawer_sessions (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_billing_payments_tenant_id_747
  ON billing_payments (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_billing_advances_tenant_id_747
  ON billing_advances (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_billing_refunds_tenant_id_747
  ON billing_refunds (tenant_id, id);

ALTER TABLE cash_drawer_sessions
  DROP CONSTRAINT IF EXISTS chk_cash_drawer_reconciliation_747,
  DROP CONSTRAINT IF EXISTS fk_cash_drawer_tenant_747,
  DROP CONSTRAINT IF EXISTS fk_cash_drawer_cashier_tenant_747,
  DROP CONSTRAINT IF EXISTS fk_cash_drawer_reviewer_tenant_747;

ALTER TABLE cash_drawer_sessions
  ADD CONSTRAINT chk_cash_drawer_reconciliation_747 CHECK (
    (
      status = 'open'
      AND closed_at IS NULL
      AND counted_total IS NULL
      AND counted_denominations IS NULL
      AND system_total IS NULL
      AND cash_inflow_total IS NULL
      AND cash_refund_total IS NULL
      AND variance IS NULL
      AND reviewed_by IS NULL
      AND reviewed_at IS NULL
    )
    OR
    (
      status IN ('closed', 'reviewed')
      AND closed_at IS NOT NULL
      AND counted_total IS NOT NULL
      AND counted_total >= 0
      AND counted_denominations IS NOT NULL
      AND jsonb_typeof(counted_denominations) = 'object'
      AND cash_inflow_total IS NOT NULL
      AND cash_inflow_total >= 0
      AND cash_refund_total IS NOT NULL
      AND cash_refund_total >= 0
      AND system_total = cash_inflow_total - cash_refund_total
      AND variance = counted_total - (opening_float + system_total)
      AND short_count = (variance < 0)
      AND over_count = (variance > 0)
      AND NOT (short_count AND over_count)
      AND (
        (status = 'closed' AND requires_review = TRUE)
        OR
        (status = 'reviewed' AND requires_review = FALSE
          AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
      )
      AND (
        requires_review = FALSE
        OR length(btrim(COALESCE(variance_reason, ''))) BETWEEN 1 AND 500
      )
    )
  ) NOT VALID,
  ADD CONSTRAINT fk_cash_drawer_tenant_747
    FOREIGN KEY (tenant_id)
    REFERENCES tenants (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    NOT VALID,
  ADD CONSTRAINT fk_cash_drawer_cashier_tenant_747
    FOREIGN KEY (tenant_id, cashier_uid)
    REFERENCES users (tenant_id, uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    NOT VALID,
  ADD CONSTRAINT fk_cash_drawer_reviewer_tenant_747
    FOREIGN KEY (tenant_id, reviewed_by)
    REFERENCES users (tenant_id, uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    NOT VALID;

ALTER TABLE billing_refunds
  DROP CONSTRAINT IF EXISTS fk_billing_refund_tenant_747,
  DROP CONSTRAINT IF EXISTS fk_billing_refund_patient_tenant_747,
  DROP CONSTRAINT IF EXISTS fk_billing_refund_invoice_tenant_747,
  DROP CONSTRAINT IF EXISTS fk_billing_refund_advance_tenant_747,
  DROP CONSTRAINT IF EXISTS fk_billing_refund_raiser_tenant_747,
  DROP CONSTRAINT IF EXISTS fk_billing_refund_approver_tenant_747,
  DROP CONSTRAINT IF EXISTS fk_billing_refund_rejector_tenant_747,
  DROP CONSTRAINT IF EXISTS fk_billing_refund_payer_tenant_747;

ALTER TABLE billing_refunds
  ADD CONSTRAINT fk_billing_refund_tenant_747
    FOREIGN KEY (tenant_id)
    REFERENCES tenants (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    NOT VALID,
  ADD CONSTRAINT fk_billing_refund_patient_tenant_747
    FOREIGN KEY (tenant_id, patient_uid)
    REFERENCES users (tenant_id, uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    NOT VALID,
  ADD CONSTRAINT fk_billing_refund_invoice_tenant_747
    FOREIGN KEY (tenant_id, invoice_id)
    REFERENCES billing_invoices (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    NOT VALID,
  ADD CONSTRAINT fk_billing_refund_advance_tenant_747
    FOREIGN KEY (tenant_id, advance_id)
    REFERENCES billing_advances (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    NOT VALID,
  ADD CONSTRAINT fk_billing_refund_raiser_tenant_747
    FOREIGN KEY (tenant_id, raised_by)
    REFERENCES users (tenant_id, uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    NOT VALID,
  ADD CONSTRAINT fk_billing_refund_approver_tenant_747
    FOREIGN KEY (tenant_id, approved_by)
    REFERENCES users (tenant_id, uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    NOT VALID,
  ADD CONSTRAINT fk_billing_refund_rejector_tenant_747
    FOREIGN KEY (tenant_id, rejected_by)
    REFERENCES users (tenant_id, uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    NOT VALID,
  ADD CONSTRAINT fk_billing_refund_payer_tenant_747
    FOREIGN KEY (tenant_id, paid_by)
    REFERENCES users (tenant_id, uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    NOT VALID;

CREATE TABLE billing_refund_offline_electronic_evidence (
  id                         BIGSERIAL PRIMARY KEY,
  tenant_id                  UUID NOT NULL,
  refund_id                  INTEGER NOT NULL,
  original_payment_id        INTEGER,
  original_advance_id        INTEGER,
  mode                       VARCHAR(20) NOT NULL,
  amount                     NUMERIC(12,2) NOT NULL,
  provider_name              VARCHAR(120) NOT NULL,
  original_payment_reference VARCHAR(255) NOT NULL,
  provider_refund_reference  VARCHAR(255) NOT NULL,
  provider_refunded_at       TIMESTAMPTZ NOT NULL,
  recorded_by                UUID NOT NULL,
  recorded_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_offline_refund_original_source_747 CHECK (
    (original_payment_id IS NOT NULL) <> (original_advance_id IS NOT NULL)
  ),
  CONSTRAINT chk_offline_refund_mode_747 CHECK (
    mode IN ('CARD', 'UPI', 'NETBANKING', 'WALLET')
  ),
  CONSTRAINT chk_offline_refund_amount_747 CHECK (amount > 0),
  CONSTRAINT chk_offline_refund_provider_name_747 CHECK (
    length(btrim(provider_name)) BETWEEN 1 AND 120
    AND provider_name !~ '[[:cntrl:]]'
  ),
  CONSTRAINT chk_offline_refund_original_reference_747 CHECK (
    length(btrim(original_payment_reference)) BETWEEN 1 AND 255
    AND original_payment_reference !~ '[[:cntrl:]]'
  ),
  CONSTRAINT chk_offline_refund_provider_reference_747 CHECK (
    length(btrim(provider_refund_reference)) BETWEEN 1 AND 255
    AND provider_refund_reference !~ '[[:cntrl:]]'
  ),
  CONSTRAINT chk_offline_refund_timestamps_747 CHECK (
    provider_refunded_at <= recorded_at + INTERVAL '5 minutes'
  ),
  CONSTRAINT ux_offline_refund_evidence_tenant_id_747
    UNIQUE (tenant_id, id),
  CONSTRAINT ux_offline_refund_evidence_tenant_refund_747
    UNIQUE (tenant_id, refund_id),
  CONSTRAINT ux_offline_refund_evidence_tenant_refund_id_747
    UNIQUE (tenant_id, refund_id, id),
  CONSTRAINT fk_offline_refund_evidence_tenant_747
    FOREIGN KEY (tenant_id)
    REFERENCES tenants (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_offline_refund_evidence_refund_747
    FOREIGN KEY (tenant_id, refund_id)
    REFERENCES billing_refunds (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_offline_refund_evidence_payment_747
    FOREIGN KEY (tenant_id, original_payment_id)
    REFERENCES billing_payments (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_offline_refund_evidence_advance_747
    FOREIGN KEY (tenant_id, original_advance_id)
    REFERENCES billing_advances (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_offline_refund_evidence_actor_747
    FOREIGN KEY (tenant_id, recorded_by)
    REFERENCES users (tenant_id, uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE UNIQUE INDEX ux_offline_refund_provider_reference_747
  ON billing_refund_offline_electronic_evidence (
    tenant_id,
    lower(btrim(provider_refund_reference))
  );
CREATE INDEX idx_offline_refund_original_payment_747
  ON billing_refund_offline_electronic_evidence (tenant_id, original_payment_id)
  WHERE original_payment_id IS NOT NULL;
CREATE INDEX idx_offline_refund_original_advance_747
  ON billing_refund_offline_electronic_evidence (tenant_id, original_advance_id)
  WHERE original_advance_id IS NOT NULL;

ALTER TABLE billing_refunds
  DROP CONSTRAINT IF EXISTS chk_billing_refund_payout_rail,
  DROP CONSTRAINT IF EXISTS chk_billing_refund_lifecycle_status_747,
  DROP CONSTRAINT IF EXISTS chk_billing_refund_paid_evidence_747,
  DROP CONSTRAINT IF EXISTS chk_billing_refund_evidence_not_premature_747,
  DROP CONSTRAINT IF EXISTS fk_billing_refund_cash_drawer_747,
  DROP CONSTRAINT IF EXISTS fk_billing_refund_offline_evidence_747;

ALTER TABLE billing_refunds
  ADD CONSTRAINT chk_billing_refund_lifecycle_status_747 CHECK (
    approval_status IN ('PENDING', 'APPROVED', 'REJECTED', 'PAID')
  ) NOT VALID,
  ADD CONSTRAINT chk_billing_refund_payout_rail CHECK (
    (
      payout_rail IS NULL
      AND payout_rail_claimed_at IS NULL
      AND gateway_refund_id IS NULL
      AND cash_drawer_session_id IS NULL
      AND offline_electronic_evidence_id IS NULL
    )
    OR
    (
      payout_rail = 'manual'
      AND payout_rail_claimed_at IS NOT NULL
      AND gateway_refund_id IS NULL
      AND offline_electronic_evidence_id IS NULL
      AND (cash_drawer_session_id IS NULL OR UPPER(mode) = 'CASH')
    )
    OR
    (
      payout_rail = 'gateway'
      AND payout_rail_claimed_at IS NOT NULL
      AND gateway_refund_id IS NOT NULL
      AND cash_drawer_session_id IS NULL
      AND offline_electronic_evidence_id IS NULL
    )
    OR
    (
      payout_rail = 'offline_electronic'
      AND payout_rail_claimed_at IS NOT NULL
      AND gateway_refund_id IS NULL
      AND cash_drawer_session_id IS NULL
      AND offline_electronic_evidence_id IS NOT NULL
    )
  ) NOT VALID,
  ADD CONSTRAINT chk_billing_refund_paid_evidence_747 CHECK (
    approval_status <> 'PAID'
    OR (
      approved_by IS NOT NULL
      AND approved_at IS NOT NULL
      AND paid_at IS NOT NULL
      AND paid_at >= approved_at
      AND payout_rail_claimed_at IS NOT NULL
      AND payout_rail_claimed_at <= paid_at
      AND length(btrim(COALESCE(reference, ''))) BETWEEN 1 AND 255
      AND reference !~ '[[:cntrl:]]'
      AND (
        (
          payout_rail = 'manual'
          AND paid_by IS NOT NULL
          AND paid_by <> approved_by
          AND gateway_refund_id IS NULL
          AND offline_electronic_evidence_id IS NULL
          AND (
            (UPPER(mode) = 'CASH' AND cash_drawer_session_id IS NOT NULL)
            OR
            (UPPER(mode) IN ('CHEQUE', 'DD') AND cash_drawer_session_id IS NULL)
          )
        )
        OR
        (
          payout_rail = 'gateway'
          AND UPPER(mode) IN ('CARD', 'UPI', 'NETBANKING', 'WALLET')
          AND paid_by IS NULL
          AND gateway_refund_id IS NOT NULL
          AND cash_drawer_session_id IS NULL
          AND offline_electronic_evidence_id IS NULL
        )
        OR
        (
          payout_rail = 'offline_electronic'
          AND UPPER(mode) IN ('CARD', 'UPI', 'NETBANKING', 'WALLET')
          AND paid_by IS NOT NULL
          AND paid_by <> approved_by
          AND gateway_refund_id IS NULL
          AND cash_drawer_session_id IS NULL
          AND offline_electronic_evidence_id IS NOT NULL
        )
      )
    )
  ) NOT VALID,
  ADD CONSTRAINT chk_billing_refund_evidence_not_premature_747 CHECK (
    approval_status = 'PAID'
    OR (
      cash_drawer_session_id IS NULL
      AND offline_electronic_evidence_id IS NULL
    )
  ) NOT VALID,
  ADD CONSTRAINT fk_billing_refund_cash_drawer_747
    FOREIGN KEY (tenant_id, cash_drawer_session_id)
    REFERENCES cash_drawer_sessions (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    DEFERRABLE INITIALLY IMMEDIATE,
  ADD CONSTRAINT fk_billing_refund_offline_evidence_747
    FOREIGN KEY (tenant_id, id, offline_electronic_evidence_id)
    REFERENCES billing_refund_offline_electronic_evidence (tenant_id, refund_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    DEFERRABLE INITIALLY IMMEDIATE;

DO $manual_reference_preflight_747$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM billing_refunds
     WHERE approval_status = 'PAID'
       AND payout_rail = 'manual'
       AND UPPER(mode) IN ('CASH', 'CHEQUE', 'DD')
       AND length(btrim(COALESCE(reference, ''))) > 0
     GROUP BY tenant_id, lower(btrim(reference))
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      '747 preflight: duplicate manual payout voucher/reference requires reconciliation'
      USING ERRCODE = '23505';
  END IF;
END
$manual_reference_preflight_747$;

CREATE UNIQUE INDEX ux_billing_refund_payout_reference_747
  ON billing_refunds (tenant_id, lower(btrim(reference)))
  WHERE approval_status = 'PAID'
    AND payout_rail IN ('manual', 'offline_electronic')
    AND reference IS NOT NULL
    AND length(btrim(reference)) > 0;

CREATE INDEX idx_billing_refund_cash_drawer_747
  ON billing_refunds (tenant_id, cash_drawer_session_id, paid_at, id)
  WHERE approval_status = 'PAID'
    AND payout_rail = 'manual'
    AND UPPER(mode) = 'CASH'
    AND cash_drawer_session_id IS NOT NULL;

CREATE OR REPLACE FUNCTION billing_refund_offline_electronic_evidence_guard_747()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  refund_row billing_refunds%ROWTYPE;
  payment_row billing_payments%ROWTYPE;
  advance_row billing_advances%ROWTYPE;
  relation_owner NAME;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(class.relowner)
    INTO relation_owner
    FROM pg_catalog.pg_class AS class
   WHERE class.oid = TG_RELID;

  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    IF current_setting('app.audit_bypass', TRUE) = 'on'
       AND current_user = relation_owner
    THEN
      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      END IF;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'offline electronic refund evidence is append-only'
      USING ERRCODE = '23514';
  END IF;

  IF current_setting('app.audit_bypass', TRUE) = 'on'
     AND current_user = relation_owner
  THEN
    RETURN NEW;
  END IF;

  NEW.id := nextval(pg_get_serial_sequence(
    'public.billing_refund_offline_electronic_evidence', 'id'
  )::regclass);
  NEW.mode := UPPER(btrim(NEW.mode));
  NEW.provider_name := btrim(NEW.provider_name);
  NEW.original_payment_reference := btrim(NEW.original_payment_reference);
  NEW.provider_refund_reference := btrim(NEW.provider_refund_reference);
  NEW.recorded_at := clock_timestamp();

  SELECT refund.* INTO refund_row
    FROM billing_refunds refund
   WHERE refund.tenant_id = NEW.tenant_id
     AND refund.id = NEW.refund_id
   FOR UPDATE;

  IF NOT FOUND
     OR refund_row.approval_status <> 'APPROVED'
     OR refund_row.approved_by IS NULL
     OR refund_row.approved_at IS NULL
     OR NEW.recorded_by = refund_row.approved_by
     OR UPPER(refund_row.mode) <> NEW.mode
     OR refund_row.amount <> NEW.amount
     OR NEW.mode NOT IN ('CARD', 'UPI', 'NETBANKING', 'WALLET')
     OR NEW.provider_refunded_at < refund_row.approved_at
     OR NEW.provider_refunded_at > NEW.recorded_at + INTERVAL '5 minutes'
  THEN
    RAISE EXCEPTION 'offline electronic refund evidence does not match an independently approved refund'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.original_payment_id IS NOT NULL THEN
    IF refund_row.invoice_id IS NULL OR refund_row.advance_id IS NOT NULL THEN
      RAISE EXCEPTION 'invoice refund requires original billing payment evidence'
        USING ERRCODE = '23514';
    END IF;

    SELECT payment.* INTO payment_row
      FROM billing_payments payment
     WHERE payment.tenant_id = NEW.tenant_id
       AND payment.id = NEW.original_payment_id
     FOR KEY SHARE;

    IF NOT FOUND
       OR payment_row.invoice_id IS DISTINCT FROM refund_row.invoice_id
       OR payment_row.patient_uid IS DISTINCT FROM refund_row.patient_uid
       OR payment_row.reversed IS DISTINCT FROM FALSE
       OR UPPER(payment_row.mode) <> NEW.mode
       OR payment_row.reference IS DISTINCT FROM NEW.original_payment_reference
       OR payment_row.amount < NEW.amount
       OR payment_row.collected_at IS NULL
       OR NEW.provider_refunded_at < payment_row.collected_at
    THEN
      RAISE EXCEPTION 'offline electronic refund original payment evidence is not exact'
        USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM payment_gateway_orders gateway_order
       WHERE gateway_order.tenant_id = NEW.tenant_id
         AND gateway_order.billing_payment_id = NEW.original_payment_id
    ) THEN
      RAISE EXCEPTION 'gateway-booked payment must use its integrated refund rail'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF refund_row.advance_id IS NULL OR refund_row.invoice_id IS NOT NULL THEN
      RAISE EXCEPTION 'advance refund requires original advance evidence'
        USING ERRCODE = '23514';
    END IF;

    SELECT advance.* INTO advance_row
      FROM billing_advances advance
     WHERE advance.tenant_id = NEW.tenant_id
       AND advance.id = NEW.original_advance_id
     FOR KEY SHARE;

    IF NOT FOUND
       OR advance_row.id IS DISTINCT FROM refund_row.advance_id
       OR advance_row.patient_uid IS DISTINCT FROM refund_row.patient_uid
       OR UPPER(advance_row.mode) <> NEW.mode
       OR advance_row.reference IS DISTINCT FROM NEW.original_payment_reference
       OR advance_row.amount < NEW.amount
       OR advance_row.collected_at IS NULL
       OR NEW.provider_refunded_at < advance_row.collected_at
    THEN
      RAISE EXCEPTION 'offline electronic refund original advance evidence is not exact'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END
$fn$;

CREATE TRIGGER billing_refund_offline_electronic_evidence_guard_747
  BEFORE INSERT OR UPDATE OR DELETE
  ON billing_refund_offline_electronic_evidence
  FOR EACH ROW
  EXECUTE FUNCTION billing_refund_offline_electronic_evidence_guard_747();

CREATE OR REPLACE FUNCTION billing_refund_offline_electronic_binding_guard_747()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM billing_refunds refund
     WHERE refund.tenant_id = NEW.tenant_id
       AND refund.id = NEW.refund_id
       AND refund.approval_status = 'PAID'
       AND refund.payout_rail = 'offline_electronic'
       AND refund.offline_electronic_evidence_id = NEW.id
       AND refund.cash_drawer_session_id IS NULL
       AND refund.gateway_refund_id IS NULL
       AND refund.paid_by = NEW.recorded_by
       AND refund.reference = NEW.provider_refund_reference
       AND UPPER(refund.mode) = NEW.mode
       AND refund.amount = NEW.amount
       AND refund.paid_at >= NEW.provider_refunded_at
  ) THEN
    RAISE EXCEPTION 'offline electronic evidence must be atomically bound to its paid refund'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END
$fn$;

CREATE CONSTRAINT TRIGGER billing_refund_offline_electronic_binding_guard_747
  AFTER INSERT ON billing_refund_offline_electronic_evidence
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION billing_refund_offline_electronic_binding_guard_747();

CREATE OR REPLACE FUNCTION billing_refund_payout_guard_747()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  drawer_row cash_drawer_sessions%ROWTYPE;
  cash_inflow NUMERIC(12,2);
  earlier_cash_refunds NUMERIC(12,2);
  available_cash NUMERIC(12,2);
  server_now TIMESTAMPTZ := transaction_timestamp();
  relation_owner NAME;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(class.relowner)
    INTO relation_owner
    FROM pg_catalog.pg_class AS class
   WHERE class.oid = TG_RELID;

  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.audit_bypass', TRUE) = 'on'
       AND current_user = relation_owner
    THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'billing refund lifecycle evidence is append-only'
      USING ERRCODE = '23514';
  END IF;

  IF current_setting('app.audit_bypass', TRUE) = 'on'
     AND current_user = relation_owner
  THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.id := nextval(pg_get_serial_sequence('public.billing_refunds', 'id')::regclass);
    NEW.raised_at := server_now;
    NEW.created_at := server_now;
    NEW.updated_at := server_now;

    IF NEW.approval_status <> 'PENDING'
       OR NEW.approved_by IS NOT NULL
       OR NEW.approved_at IS NOT NULL
       OR NEW.rejected_by IS NOT NULL
       OR NEW.rejected_at IS NOT NULL
       OR NEW.rejection_reason IS NOT NULL
       OR NEW.reference IS NOT NULL
       OR NEW.paid_by IS NOT NULL
       OR NEW.paid_at IS NOT NULL
       OR NEW.payout_rail IS NOT NULL
       OR NEW.payout_rail_claimed_at IS NOT NULL
       OR NEW.gateway_refund_id IS NOT NULL
       OR NEW.cash_drawer_session_id IS NOT NULL
       OR NEW.offline_electronic_evidence_id IS NOT NULL
    THEN
      RAISE EXCEPTION 'billing refund must start as an unapproved pending request'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.approval_status NOT IN ('PENDING', 'APPROVED', 'REJECTED', 'PAID')
     OR NEW.approval_status NOT IN ('PENDING', 'APPROVED', 'REJECTED', 'PAID')
  THEN
    RAISE EXCEPTION 'invalid billing refund lifecycle state'
      USING ERRCODE = '23514';
  END IF;

  IF (
    OLD.id,
    OLD.tenant_id,
    OLD.patient_uid,
    OLD.invoice_id,
    OLD.advance_id,
    OLD.amount,
    OLD.mode,
    OLD.reason,
    OLD.raised_by,
    OLD.raised_at,
    OLD.created_at,
    OLD.counter_sale_void_request_id
  ) IS DISTINCT FROM (
    NEW.id,
    NEW.tenant_id,
    NEW.patient_uid,
    NEW.invoice_id,
    NEW.advance_id,
    NEW.amount,
    NEW.mode,
    NEW.reason,
    NEW.raised_by,
    NEW.raised_at,
    NEW.created_at,
    NEW.counter_sale_void_request_id
  ) THEN
    RAISE EXCEPTION 'billing refund request identity, money, and source are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.approval_status IN ('REJECTED', 'PAID') THEN
    RAISE EXCEPTION 'terminal billing refund evidence is immutable'
      USING ERRCODE = '23514';
  END IF;

  NEW.updated_at := server_now;

  IF OLD.approval_status = 'PENDING' THEN
    IF OLD.approved_by IS NOT NULL
       OR OLD.approved_at IS NOT NULL
       OR OLD.rejected_by IS NOT NULL
       OR OLD.rejected_at IS NOT NULL
       OR OLD.rejection_reason IS NOT NULL
       OR OLD.paid_by IS NOT NULL
       OR OLD.paid_at IS NOT NULL
       OR OLD.payout_rail IS NOT NULL
       OR OLD.payout_rail_claimed_at IS NOT NULL
       OR OLD.gateway_refund_id IS NOT NULL
       OR OLD.cash_drawer_session_id IS NOT NULL
       OR OLD.offline_electronic_evidence_id IS NOT NULL
    THEN
      RAISE EXCEPTION 'pending billing refund contains premature lifecycle evidence'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.reference IS DISTINCT FROM OLD.reference THEN
      RAISE EXCEPTION 'pending billing refund request reference is immutable'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.approval_status = 'PENDING' THEN
      IF (
        NEW.approved_by,
        NEW.approved_at,
        NEW.rejected_by,
        NEW.rejected_at,
        NEW.rejection_reason,
        NEW.paid_by,
        NEW.paid_at,
        NEW.payout_rail,
        NEW.payout_rail_claimed_at,
        NEW.gateway_refund_id,
        NEW.cash_drawer_session_id,
        NEW.offline_electronic_evidence_id
      ) IS DISTINCT FROM (
        OLD.approved_by,
        OLD.approved_at,
        OLD.rejected_by,
        OLD.rejected_at,
        OLD.rejection_reason,
        OLD.paid_by,
        OLD.paid_at,
        OLD.payout_rail,
        OLD.payout_rail_claimed_at,
        OLD.gateway_refund_id,
        OLD.cash_drawer_session_id,
        OLD.offline_electronic_evidence_id
      ) THEN
        RAISE EXCEPTION 'pending billing refund may not acquire lifecycle evidence without a state transition'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;

    IF NEW.approval_status = 'APPROVED' THEN
      NEW.approved_at := server_now;
      IF NEW.approved_by IS NULL
         OR NEW.rejected_by IS NOT NULL
         OR NEW.rejected_at IS NOT NULL
         OR NEW.rejection_reason IS NOT NULL
         OR NEW.paid_by IS NOT NULL
         OR NEW.paid_at IS NOT NULL
         OR NEW.payout_rail IS NOT NULL
         OR NEW.payout_rail_claimed_at IS NOT NULL
         OR NEW.gateway_refund_id IS NOT NULL
         OR NEW.cash_drawer_session_id IS NOT NULL
         OR NEW.offline_electronic_evidence_id IS NOT NULL
      THEN
        RAISE EXCEPTION 'PENDING to APPROVED requires one exact approval actor and no payout evidence'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;

    IF NEW.approval_status = 'REJECTED' THEN
      NEW.rejected_at := server_now;
      NEW.rejection_reason := btrim(NEW.rejection_reason);
      IF NEW.rejected_by IS NULL
         OR length(btrim(COALESCE(NEW.rejection_reason, ''))) NOT BETWEEN 1 AND 255
         OR NEW.rejection_reason ~ '[[:cntrl:]]'
         OR NEW.approved_by IS NOT NULL
         OR NEW.approved_at IS NOT NULL
         OR NEW.paid_by IS NOT NULL
         OR NEW.paid_at IS NOT NULL
         OR NEW.payout_rail IS NOT NULL
         OR NEW.payout_rail_claimed_at IS NOT NULL
         OR NEW.gateway_refund_id IS NOT NULL
         OR NEW.cash_drawer_session_id IS NOT NULL
         OR NEW.offline_electronic_evidence_id IS NOT NULL
      THEN
        RAISE EXCEPTION 'PENDING to REJECTED requires one exact rejection actor, reason, and no payout evidence'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'billing refund can only leave PENDING through APPROVED or REJECTED'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.approval_status <> 'APPROVED'
     OR OLD.approved_by IS NULL
     OR OLD.approved_at IS NULL
     OR OLD.rejected_by IS NOT NULL
     OR OLD.rejected_at IS NOT NULL
     OR OLD.rejection_reason IS NOT NULL
     OR OLD.paid_by IS NOT NULL
     OR OLD.paid_at IS NOT NULL
     OR OLD.cash_drawer_session_id IS NOT NULL
     OR OLD.offline_electronic_evidence_id IS NOT NULL
  THEN
    RAISE EXCEPTION 'approved billing refund lacks immutable approval evidence'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.approved_by IS DISTINCT FROM OLD.approved_by
     OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
     OR NEW.rejected_by IS NOT NULL
     OR NEW.rejected_at IS NOT NULL
     OR NEW.rejection_reason IS NOT NULL
  THEN
    RAISE EXCEPTION 'billing refund approval evidence is immutable after approval'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.approval_status = 'APPROVED' THEN
    IF NEW.reference IS DISTINCT FROM OLD.reference
       OR NEW.paid_by IS NOT NULL
       OR NEW.paid_at IS NOT NULL
       OR NEW.cash_drawer_session_id IS NOT NULL
       OR NEW.offline_electronic_evidence_id IS NOT NULL
    THEN
      RAISE EXCEPTION 'approved billing refund cannot acquire settlement evidence before PAID'
        USING ERRCODE = '23514';
    END IF;

    IF OLD.payout_rail IS NULL THEN
      IF NEW.payout_rail IS NULL
         AND NEW.payout_rail_claimed_at IS NULL
         AND NEW.gateway_refund_id IS NULL
      THEN
        RETURN NEW;
      END IF;
      NEW.payout_rail_claimed_at := server_now;
    ELSIF OLD.payout_rail = 'gateway' THEN
      IF NEW.payout_rail IS DISTINCT FROM OLD.payout_rail
         OR NEW.payout_rail_claimed_at IS DISTINCT FROM OLD.payout_rail_claimed_at
      THEN
        RAISE EXCEPTION 'claimed gateway payout authority cannot be released or retimed'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.gateway_refund_id IS DISTINCT FROM OLD.gateway_refund_id
         AND NOT EXISTS (
           SELECT 1
             FROM payment_gateway_refunds prior
            WHERE prior.tenant_id = OLD.tenant_id
              AND prior.id = OLD.gateway_refund_id
              AND prior.billing_refund_id = OLD.id
              AND prior.status = 'failed'
         )
      THEN
        RAISE EXCEPTION 'gateway refund execution can only be replaced after exact failure evidence'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'manual and offline electronic payout evidence may only appear on APPROVED to PAID'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.payout_rail <> 'gateway'
       OR NEW.gateway_refund_id IS NULL
       OR NOT EXISTS (
         SELECT 1
           FROM payment_gateway_refunds execution
           JOIN users actor
             ON actor.tenant_id = execution.tenant_id
            AND actor.uid = execution.initiated_by
          WHERE execution.tenant_id = NEW.tenant_id
            AND execution.id = NEW.gateway_refund_id
            AND execution.billing_refund_id = NEW.id
            AND execution.amount = NEW.amount
            AND execution.status IN ('initiated', 'pending', 'processed')
            AND execution.initiated_at >= NEW.approved_at
            AND execution.initiated_by <> NEW.approved_by
       )
    THEN
      RAISE EXCEPTION 'gateway payout reservation lacks exact independently initiated execution evidence'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.approval_status <> 'PAID' THEN
    RAISE EXCEPTION 'refund payout must transition APPROVED -> PAID'
      USING ERRCODE = '23514';
  END IF;

  NEW.paid_at := server_now;
  NEW.reference := btrim(NEW.reference);
  IF OLD.payout_rail IS NULL THEN
    IF OLD.payout_rail_claimed_at IS NOT NULL OR OLD.gateway_refund_id IS NOT NULL THEN
      RAISE EXCEPTION 'unclaimed refund contains premature payout authority'
        USING ERRCODE = '23514';
    END IF;
    NEW.payout_rail_claimed_at := server_now;
  ELSIF OLD.payout_rail = 'gateway' THEN
    IF NEW.payout_rail <> 'gateway'
       OR NEW.payout_rail_claimed_at IS DISTINCT FROM OLD.payout_rail_claimed_at
       OR NEW.gateway_refund_id IS DISTINCT FROM OLD.gateway_refund_id
    THEN
      RAISE EXCEPTION 'claimed gateway payout authority is immutable through settlement'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'pre-claimed manual or offline electronic payout authority is forbidden'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.payout_rail_claimed_at IS NULL
     OR NEW.payout_rail_claimed_at > NEW.paid_at
     OR length(btrim(COALESCE(NEW.reference, ''))) NOT BETWEEN 1 AND 255
     OR NEW.reference ~ '[[:cntrl:]]'
  THEN
    RAISE EXCEPTION 'paid refund lacks valid approval and immutable payout evidence'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.payout_rail = 'manual' THEN
    IF UPPER(NEW.mode) NOT IN ('CASH', 'CHEQUE', 'DD')
       OR NEW.paid_by IS NULL
       OR NEW.paid_by = NEW.approved_by
       OR NEW.gateway_refund_id IS NOT NULL
       OR NEW.offline_electronic_evidence_id IS NOT NULL
    THEN
      RAISE EXCEPTION 'manual payout is restricted to cash, cheque, or demand draft with an independent payer'
        USING ERRCODE = '23514';
    END IF;

    IF UPPER(NEW.mode) = 'CASH' THEN
      IF NEW.cash_drawer_session_id IS NULL THEN
        RAISE EXCEPTION 'cash refund requires an exact open drawer'
          USING ERRCODE = '23514';
      END IF;

      SELECT drawer.* INTO drawer_row
        FROM cash_drawer_sessions drawer
       WHERE drawer.tenant_id = NEW.tenant_id
         AND drawer.id = NEW.cash_drawer_session_id
       FOR UPDATE;

      IF NOT FOUND
         OR drawer_row.status <> 'open'
         OR drawer_row.cashier_uid IS DISTINCT FROM NEW.paid_by
         OR NEW.paid_at < drawer_row.opened_at
      THEN
        RAISE EXCEPTION 'cash refund drawer is missing, closed, cross-tenant, or owned by another cashier'
          USING ERRCODE = '23514';
      END IF;

      SELECT COALESCE(SUM(payment.amount), 0)::NUMERIC(12,2)
        INTO cash_inflow
        FROM billing_payments payment
       WHERE payment.tenant_id = NEW.tenant_id
         AND UPPER(payment.mode) = 'CASH'
         AND payment.reversed = FALSE
         AND payment.collected_by = drawer_row.cashier_uid
         AND payment.shift = drawer_row.shift
         AND payment.collected_at >= drawer_row.opened_at
         AND payment.collected_at <= NEW.paid_at;

      SELECT COALESCE(SUM(refund.amount), 0)::NUMERIC(12,2)
        INTO earlier_cash_refunds
        FROM billing_refunds refund
       WHERE refund.tenant_id = NEW.tenant_id
         AND refund.cash_drawer_session_id = drawer_row.id
         AND refund.approval_status = 'PAID'
         AND refund.payout_rail = 'manual'
         AND UPPER(refund.mode) = 'CASH';

      available_cash := drawer_row.opening_float + cash_inflow - earlier_cash_refunds;
      IF NEW.amount > available_cash THEN
        RAISE EXCEPTION 'cash refund exceeds cash available in the owned drawer'
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.cash_drawer_session_id IS NOT NULL THEN
      RAISE EXCEPTION 'cheque and demand-draft refunds cannot claim a cash drawer'
        USING ERRCODE = '23514';
    END IF;

  ELSIF NEW.payout_rail = 'offline_electronic' THEN
    IF UPPER(NEW.mode) NOT IN ('CARD', 'UPI', 'NETBANKING', 'WALLET')
       OR NEW.paid_by IS NULL
       OR NEW.paid_by = NEW.approved_by
       OR NEW.gateway_refund_id IS NOT NULL
       OR NEW.cash_drawer_session_id IS NOT NULL
       OR NEW.offline_electronic_evidence_id IS NULL
       OR NOT EXISTS (
         SELECT 1
           FROM billing_refund_offline_electronic_evidence evidence
          WHERE evidence.tenant_id = NEW.tenant_id
            AND evidence.id = NEW.offline_electronic_evidence_id
            AND evidence.refund_id = NEW.id
            AND evidence.mode = UPPER(NEW.mode)
            AND evidence.amount = NEW.amount
            AND evidence.provider_refund_reference = NEW.reference
            AND evidence.recorded_by = NEW.paid_by
            AND evidence.recorded_by <> NEW.approved_by
            AND evidence.provider_refunded_at <= NEW.paid_at
       )
    THEN
      RAISE EXCEPTION 'offline electronic payout lacks exact immutable provider evidence'
        USING ERRCODE = '23514';
    END IF;

  ELSIF NEW.payout_rail = 'gateway' THEN
    IF UPPER(NEW.mode) NOT IN ('CARD', 'UPI', 'NETBANKING', 'WALLET')
       OR NEW.paid_by IS NOT NULL
       OR NEW.gateway_refund_id IS NULL
       OR NEW.cash_drawer_session_id IS NOT NULL
       OR NEW.offline_electronic_evidence_id IS NOT NULL
       OR NOT EXISTS (
         SELECT 1
           FROM payment_gateway_refunds execution
           JOIN users actor
             ON actor.tenant_id = execution.tenant_id
            AND actor.uid = execution.initiated_by
          WHERE execution.tenant_id = NEW.tenant_id
            AND execution.id = NEW.gateway_refund_id
            AND execution.billing_refund_id = NEW.id
            AND execution.status = 'processed'
            AND execution.amount = NEW.amount
            AND execution.provider_refund_id = NEW.reference
            AND execution.processed_at IS NOT NULL
            AND execution.initiated_at >= NEW.approved_at
            AND execution.processed_at >= NEW.approved_at
            AND execution.processed_at <= NEW.paid_at
            AND execution.initiated_by <> NEW.approved_by
       )
    THEN
      RAISE EXCEPTION 'gateway payout lacks exact processed execution by an independent actor'
        USING ERRCODE = '23514';
    END IF;

  ELSE
    RAISE EXCEPTION 'unsupported refund payout rail or mode'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$fn$;

CREATE TRIGGER billing_refund_payout_guard_747
  BEFORE INSERT OR UPDATE OR DELETE ON billing_refunds
  FOR EACH ROW
  EXECUTE FUNCTION billing_refund_payout_guard_747();

CREATE OR REPLACE FUNCTION cash_drawer_reconciliation_guard_747()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  calculated_inflow NUMERIC(12,2);
  calculated_refunds NUMERIC(12,2);
  calculated_net NUMERIC(12,2);
  calculated_variance NUMERIC(12,2);
  server_now TIMESTAMPTZ := transaction_timestamp();
  relation_owner NAME;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(class.relowner)
    INTO relation_owner
    FROM pg_catalog.pg_class AS class
   WHERE class.oid = TG_RELID;

  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.audit_bypass', TRUE) = 'on'
       AND current_user = relation_owner
    THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'cash drawer lifecycle evidence is append-only'
      USING ERRCODE = '23514';
  END IF;

  IF current_setting('app.audit_bypass', TRUE) = 'on'
     AND current_user = relation_owner
  THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.id := nextval(pg_get_serial_sequence('public.cash_drawer_sessions', 'id')::regclass);
    NEW.opened_at := server_now;
    NEW.created_at := server_now;
    NEW.updated_at := server_now;

    IF NEW.status <> 'open'
       OR NEW.opening_float < 0
       OR NEW.closed_at IS NOT NULL
       OR NEW.counted_total IS NOT NULL
       OR NEW.counted_denominations IS NOT NULL
       OR NEW.cash_inflow_total IS NOT NULL
       OR NEW.cash_refund_total IS NOT NULL
       OR NEW.system_total IS NOT NULL
       OR NEW.variance IS NOT NULL
       OR NEW.short_count IS DISTINCT FROM FALSE
       OR NEW.over_count IS DISTINCT FROM FALSE
       OR NEW.requires_review IS DISTINCT FROM FALSE
       OR NEW.variance_reason IS NOT NULL
       OR NEW.reviewed_by IS NOT NULL
       OR NEW.reviewed_at IS NOT NULL
       OR NEW.review_notes IS NOT NULL
    THEN
      RAISE EXCEPTION 'cash drawer must start open without close or review evidence'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF (
    OLD.id,
    OLD.tenant_id,
    OLD.cashier_uid,
    OLD.shift,
    OLD.opened_at,
    OLD.opening_float,
    OLD.created_at
  ) IS DISTINCT FROM (
    NEW.id,
    NEW.tenant_id,
    NEW.cashier_uid,
    NEW.shift,
    NEW.opened_at,
    NEW.opening_float,
    NEW.created_at
  ) THEN
    RAISE EXCEPTION 'cash drawer identity and opening float are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'reviewed' THEN
    RAISE EXCEPTION 'reviewed cash drawer evidence is immutable'
      USING ERRCODE = '23514';
  END IF;

  NEW.updated_at := server_now;

  IF OLD.status = 'closed' THEN
    IF NEW.status <> 'reviewed'
       OR OLD.requires_review IS DISTINCT FROM TRUE
       OR NEW.requires_review IS DISTINCT FROM FALSE
       OR NEW.reviewed_by IS NULL
    THEN
      RAISE EXCEPTION 'closed cash drawer can only transition to reviewed'
        USING ERRCODE = '23514';
    END IF;
    NEW.reviewed_at := server_now;
    IF (
      OLD.closed_at,
      OLD.counted_total,
      OLD.counted_denominations,
      OLD.cash_inflow_total,
      OLD.cash_refund_total,
      OLD.system_total,
      OLD.variance,
      OLD.short_count,
      OLD.over_count,
      OLD.variance_reason,
      OLD.status
    ) IS DISTINCT FROM (
      NEW.closed_at,
      NEW.counted_total,
      NEW.counted_denominations,
      NEW.cash_inflow_total,
      NEW.cash_refund_total,
      NEW.system_total,
      NEW.variance,
      NEW.short_count,
      NEW.over_count,
      NEW.variance_reason,
      'closed'
    ) THEN
      RAISE EXCEPTION 'closed cash drawer reconciliation totals are immutable'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status <> 'open' OR NEW.status NOT IN ('open', 'closed', 'reviewed') THEN
    RAISE EXCEPTION 'invalid cash drawer status transition'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'open' THEN
    IF (
      OLD.closed_at,
      OLD.counted_total,
      OLD.counted_denominations,
      OLD.cash_inflow_total,
      OLD.cash_refund_total,
      OLD.system_total,
      OLD.variance,
      OLD.short_count,
      OLD.over_count,
      OLD.requires_review,
      OLD.variance_reason,
      OLD.reviewed_by,
      OLD.reviewed_at,
      OLD.review_notes
    ) IS DISTINCT FROM (
      NEW.closed_at,
      NEW.counted_total,
      NEW.counted_denominations,
      NEW.cash_inflow_total,
      NEW.cash_refund_total,
      NEW.system_total,
      NEW.variance,
      NEW.short_count,
      NEW.over_count,
      NEW.requires_review,
      NEW.variance_reason,
      NEW.reviewed_by,
      NEW.reviewed_at,
      NEW.review_notes
    ) THEN
      RAISE EXCEPTION 'open cash drawer cannot acquire close or review evidence without closing'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  NEW.closed_at := server_now;
  IF NEW.status = 'closed' THEN
    IF NEW.requires_review IS DISTINCT FROM TRUE
       OR NEW.reviewed_by IS NOT NULL
       OR NEW.reviewed_at IS NOT NULL
       OR NEW.review_notes IS NOT NULL
    THEN
      RAISE EXCEPTION 'closed cash drawer requires unresolved variance review evidence'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.requires_review IS DISTINCT FROM FALSE
       OR NEW.reviewed_by IS NULL
       OR NEW.reviewed_by IS DISTINCT FROM NEW.cashier_uid
       OR NEW.review_notes IS NOT NULL
    THEN
      RAISE EXCEPTION 'immediately reconciled cash drawer requires exact reviewer evidence'
        USING ERRCODE = '23514';
    END IF;
    NEW.reviewed_at := server_now;
  END IF;

  SELECT COALESCE(SUM(payment.amount), 0)::NUMERIC(12,2)
    INTO calculated_inflow
    FROM billing_payments payment
   WHERE payment.tenant_id = NEW.tenant_id
     AND UPPER(payment.mode) = 'CASH'
     AND payment.reversed = FALSE
     AND payment.collected_by = NEW.cashier_uid
     AND payment.shift = NEW.shift
     AND payment.collected_at >= NEW.opened_at
     AND payment.collected_at <= NEW.closed_at;

  SELECT COALESCE(SUM(refund.amount), 0)::NUMERIC(12,2)
    INTO calculated_refunds
    FROM billing_refunds refund
   WHERE refund.tenant_id = NEW.tenant_id
     AND refund.cash_drawer_session_id = NEW.id
     AND refund.approval_status = 'PAID'
     AND refund.payout_rail = 'manual'
     AND UPPER(refund.mode) = 'CASH';

  calculated_net := calculated_inflow - calculated_refunds;
  calculated_variance := NEW.counted_total - (NEW.opening_float + calculated_net);

  IF NEW.closed_at IS NULL
     OR NEW.counted_total IS NULL
     OR NEW.cash_inflow_total IS DISTINCT FROM calculated_inflow
     OR NEW.cash_refund_total IS DISTINCT FROM calculated_refunds
     OR NEW.system_total IS DISTINCT FROM calculated_net
     OR NEW.variance IS DISTINCT FROM calculated_variance
     OR NEW.short_count IS DISTINCT FROM (calculated_variance < 0)
     OR NEW.over_count IS DISTINCT FROM (calculated_variance > 0)
  THEN
    RAISE EXCEPTION 'cash drawer close totals do not match exact cash inflow minus linked paid cash refunds'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$fn$;

CREATE TRIGGER cash_drawer_reconciliation_guard_747
  BEFORE INSERT OR UPDATE OR DELETE ON cash_drawer_sessions
  FOR EACH ROW
  EXECUTE FUNCTION cash_drawer_reconciliation_guard_747();

CREATE OR REPLACE FUNCTION billing_cash_payment_reversal_guard_747()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF OLD.reversed = FALSE
     AND NEW.reversed = TRUE
     AND UPPER(OLD.mode) = 'CASH'
  THEN
    PERFORM 1
      FROM cash_drawer_sessions drawer
     WHERE drawer.tenant_id = OLD.tenant_id
       AND drawer.cashier_uid = OLD.collected_by
       AND drawer.shift = OLD.shift
       AND OLD.collected_at >= drawer.opened_at
       AND (drawer.closed_at IS NULL OR OLD.collected_at <= drawer.closed_at)
     FOR SHARE;

    IF EXISTS (
      SELECT 1
        FROM cash_drawer_sessions drawer
       WHERE drawer.tenant_id = OLD.tenant_id
         AND drawer.cashier_uid = OLD.collected_by
         AND drawer.shift = OLD.shift
         AND drawer.status IN ('closed', 'reviewed')
         AND drawer.closed_at IS NOT NULL
         AND OLD.collected_at >= drawer.opened_at
         AND OLD.collected_at <= drawer.closed_at
    ) THEN
      RAISE EXCEPTION 'cash receipt belongs to an immutable closed drawer; post a governed refund through the current open drawer instead'
        USING ERRCODE = '23514',
              CONSTRAINT = 'billing_cash_payment_reversal_guard_747';
    END IF;
  END IF;

  RETURN NEW;
END
$fn$;

CREATE TRIGGER billing_cash_payment_reversal_guard_747
  BEFORE UPDATE OF reversed ON billing_payments
  FOR EACH ROW
  EXECUTE FUNCTION billing_cash_payment_reversal_guard_747();

ALTER TABLE billing_refund_offline_electronic_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_refund_offline_electronic_evidence FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation
  ON billing_refund_offline_electronic_evidence
  USING (
    current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = COALESCE(
      NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid,
      '00000000-0000-4000-8000-000000000001'::uuid
    )
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = COALESCE(
      NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid,
      '00000000-0000-4000-8000-000000000001'::uuid
    )
  );

CREATE POLICY explicit_tenant_context
  ON billing_refund_offline_electronic_evidence
  AS RESTRICTIVE
  USING (
    current_setting('app.current_tenant_id', true) IS NOT NULL
    AND current_setting('app.current_tenant_id', true) <> ''
    AND current_setting('app.current_tenant_id', true) <> 'bypass'
    AND tenant_id = app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NOT NULL
    AND current_setting('app.current_tenant_id', true) <> ''
    AND current_setting('app.current_tenant_id', true) <> 'bypass'
    AND tenant_id = app_current_tenant_id_uuid()
  );

DO $billing_refund_runtime_privileges_747$
DECLARE
  runtime_role TEXT;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['vhhealth_app', 'vhhealth_runtime']::TEXT[]
  LOOP
    IF pg_catalog.to_regrole(runtime_role) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE public.billing_refund_offline_electronic_evidence FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT SELECT ON TABLE public.billing_refund_offline_electronic_evidence TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT INSERT (tenant_id, refund_id, original_payment_id, original_advance_id, mode, amount, provider_name, original_payment_reference, provider_refund_reference, provider_refunded_at, recorded_by) ON TABLE public.billing_refund_offline_electronic_evidence TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON SEQUENCE public.billing_refund_offline_electronic_evidence_id_seq FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT USAGE, SELECT ON SEQUENCE public.billing_refund_offline_electronic_evidence_id_seq TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE public.billing_refunds FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT SELECT ON TABLE public.billing_refunds TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT INSERT (patient_uid, invoice_id, advance_id, amount, reason, mode, approval_status, raised_by, tenant_id, counter_sale_void_request_id) ON TABLE public.billing_refunds TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT UPDATE (reference, approval_status, approved_by, approved_at, rejected_by, rejected_at, rejection_reason, paid_at, paid_by, updated_at, payout_rail, payout_rail_claimed_at, gateway_refund_id, cash_drawer_session_id, offline_electronic_evidence_id) ON TABLE public.billing_refunds TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON SEQUENCE public.billing_refunds_id_seq FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT USAGE, SELECT ON SEQUENCE public.billing_refunds_id_seq TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE public.cash_drawer_sessions FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT SELECT ON TABLE public.cash_drawer_sessions TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT INSERT (tenant_id, cashier_uid, shift, opening_float) ON TABLE public.cash_drawer_sessions TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT UPDATE (closed_at, counted_total, counted_denominations, system_total, variance, short_count, over_count, requires_review, variance_reason, status, reviewed_by, reviewed_at, review_notes, updated_at, cash_inflow_total, cash_refund_total) ON TABLE public.cash_drawer_sessions TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON SEQUENCE public.cash_drawer_sessions_id_seq FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT USAGE, SELECT ON SEQUENCE public.cash_drawer_sessions_id_seq TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.billing_refund_offline_electronic_evidence_guard_747() FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.billing_refund_offline_electronic_binding_guard_747() FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.billing_refund_payout_guard_747() FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.cash_drawer_reconciliation_guard_747() FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.billing_cash_payment_reversal_guard_747() FROM %I',
      runtime_role
    );
  END LOOP;
END
$billing_refund_runtime_privileges_747$;

REVOKE ALL PRIVILEGES ON FUNCTION billing_refund_offline_electronic_evidence_guard_747() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION billing_refund_offline_electronic_binding_guard_747() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION billing_refund_payout_guard_747() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION cash_drawer_reconciliation_guard_747() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION billing_cash_payment_reversal_guard_747() FROM PUBLIC;

COMMENT ON COLUMN cash_drawer_sessions.cash_inflow_total IS
  'Exact non-reversed CASH billing-payments total for this cashier/shift from drawer open through close.';
COMMENT ON COLUMN cash_drawer_sessions.cash_refund_total IS
  'Exact PAID CASH refund total explicitly linked to this drawer session.';
COMMENT ON COLUMN cash_drawer_sessions.system_total IS
  'Net drawer movement: cash_inflow_total minus cash_refund_total. Opening float remains separate.';
COMMENT ON COLUMN billing_refunds.cash_drawer_session_id IS
  'Exact open same-tenant drawer owned by paid_by for a manual CASH payout; immutable after settlement.';
COMMENT ON COLUMN billing_refunds.offline_electronic_evidence_id IS
  'Exact immutable offline terminal/acquirer payout evidence for an offline_electronic refund rail.';
COMMENT ON TABLE billing_refund_offline_electronic_evidence IS
  'Append-only evidence for CARD/UPI/NETBANKING/WALLET refunds paid outside the integrated gateway: exact original collection, provider identity/reference/time, amount, and authenticated payout actor.';
COMMENT ON COLUMN billing_refund_offline_electronic_evidence.original_advance_id IS
  'Original advance collection for an advance refund. Exactly one of original_payment_id or original_advance_id is required.';
COMMENT ON COLUMN billing_refunds.payout_rail IS
  'Atomic payout authority: manual for CASH/CHEQUE/DD, gateway for integrated provider execution, or offline_electronic for governed terminal/acquirer evidence.';
COMMENT ON FUNCTION billing_cash_payment_reversal_guard_747() IS
  'Prevents post-close reversal of an inferred CASH receipt from falsifying immutable drawer reconciliation totals.';

COMMIT;
