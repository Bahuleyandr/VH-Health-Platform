-- 746_pharmacy_counter_sale_void_obligations.sql
--
-- Counter-sale voids are a two-owner workflow, not a pharmacy shortcut:
-- pharmacy may request a same-day void, while billing retains approval and
-- payout authority. Stock is returned only after the one refund created for
-- the request is durably PAID with evidence for its selected payout rail.

BEGIN;

ALTER TABLE pharmacy_counter_sales
  DROP CONSTRAINT IF EXISTS chk_pharmacy_counter_sale_status,
  ADD CONSTRAINT chk_pharmacy_counter_sale_status
    CHECK (status IN (
      'IN_PROGRESS', 'COMPLETED', 'VOID_PENDING_REFUND', 'VOIDED', 'FAILED'
    )),
  DROP CONSTRAINT IF EXISTS chk_pharmacy_counter_sale_invoice_when_completed,
  ADD CONSTRAINT chk_pharmacy_counter_sale_invoice_when_completed
    CHECK (
      status NOT IN ('COMPLETED', 'VOID_PENDING_REFUND', 'VOIDED')
      OR invoice_id IS NOT NULL
    );

CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_counter_sales_tenant_id_746
  ON pharmacy_counter_sales (tenant_id, id);

CREATE TABLE pharmacy_counter_sale_void_requests (
  id                    BIGSERIAL PRIMARY KEY,
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  counter_sale_id       BIGINT NOT NULL,
  invoice_id            INTEGER NOT NULL,
  patient_uid           UUID NOT NULL,
  refund_id             INTEGER,
  amount                NUMERIC(12, 2) NOT NULL
    CONSTRAINT chk_counter_sale_void_amount_positive CHECK (amount > 0),
  refund_mode           VARCHAR(20) NOT NULL
    CONSTRAINT chk_counter_sale_void_refund_mode CHECK (
      refund_mode IN ('CASH', 'CARD', 'UPI', 'NETBANKING', 'CHEQUE', 'DD', 'WALLET')
    ),
  disposition           VARCHAR(30) NOT NULL
    CONSTRAINT chk_counter_sale_void_disposition CHECK (
      disposition = 'NEVER_HANDED_OVER'
    ),
  reason                VARCHAR(255) NOT NULL
    CONSTRAINT chk_counter_sale_void_reason CHECK (length(btrim(reason)) BETWEEN 1 AND 255),
  requested_by          UUID NOT NULL,
  requested_by_name     VARCHAR(255),
  requested_by_role     VARCHAR(80) NOT NULL,
  command_key           VARCHAR(200) NOT NULL
    CONSTRAINT chk_counter_sale_void_command_key CHECK (
      command_key ~ '^[A-Za-z0-9_\-:.]{1,200}$'
    ),
  request_fingerprint   CHAR(64) NOT NULL
    CONSTRAINT chk_counter_sale_void_fingerprint CHECK (
      request_fingerprint ~ '^[0-9a-f]{64}$'
    ),
  status                VARCHAR(30) NOT NULL DEFAULT 'CREATING'
    CONSTRAINT chk_counter_sale_void_request_status CHECK (
      status IN (
        'CREATING', 'PENDING_REFUND', 'REFUND_REJECTED_REVIEW',
        'CANCELLED_HANDOVER_CONFIRMED', 'COMPLETED'
      )
    ),
  task_stage            VARCHAR(30) NOT NULL DEFAULT 'approval'
    CONSTRAINT chk_counter_sale_void_task_stage CHECK (
      task_stage IN ('approval', 'payout', 'reconciliation', 'rejected_review', 'completed', 'cancelled')
    ),
  task_id               INTEGER,
  workflow_sla_instance_id UUID,
  requested_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_checked_at       TIMESTAMPTZ,
  reconciled_at         TIMESTAMPTZ,
  reconciled_by         UUID,
  reconciliation_source VARCHAR(20)
    CONSTRAINT chk_counter_sale_void_reconciliation_source CHECK (
      reconciliation_source IS NULL OR reconciliation_source IN ('manual', 'system')
    ),
  rejection_resolved_at TIMESTAMPTZ,
  rejection_resolved_by UUID,
  rejection_resolution  VARCHAR(40)
    CONSTRAINT chk_counter_sale_void_rejection_resolution CHECK (
      rejection_resolution IS NULL OR rejection_resolution = 'CUSTOMER_HANDOVER_CONFIRMED'
    ),
  rejection_resolution_reason VARCHAR(255),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_counter_sale_void_request_evidence CHECK (
    (status = 'CREATING' AND refund_id IS NULL
      AND task_id IS NULL AND workflow_sla_instance_id IS NULL
      AND reconciled_at IS NULL AND reconciled_by IS NULL AND reconciliation_source IS NULL
      AND rejection_resolved_at IS NULL AND rejection_resolved_by IS NULL
      AND rejection_resolution IS NULL AND rejection_resolution_reason IS NULL)
    OR
    (status IN ('PENDING_REFUND', 'REFUND_REJECTED_REVIEW') AND refund_id IS NOT NULL
      AND reconciled_at IS NULL AND reconciled_by IS NULL AND reconciliation_source IS NULL
      AND rejection_resolved_at IS NULL AND rejection_resolved_by IS NULL
      AND rejection_resolution IS NULL AND rejection_resolution_reason IS NULL)
    OR
    (status IN ('CANCELLED_HANDOVER_CONFIRMED', 'COMPLETED')
      AND refund_id IS NOT NULL AND reconciled_at IS NOT NULL
       AND task_id IS NOT NULL AND workflow_sla_instance_id IS NOT NULL
       AND (
         (reconciliation_source = 'manual' AND reconciled_by IS NOT NULL)
         OR (reconciliation_source = 'system' AND reconciled_by IS NULL)
       )
       AND (
         (status = 'COMPLETED'
           AND rejection_resolved_at IS NULL AND rejection_resolved_by IS NULL
           AND rejection_resolution IS NULL AND rejection_resolution_reason IS NULL)
         OR
         (status = 'CANCELLED_HANDOVER_CONFIRMED'
           AND rejection_resolved_at IS NOT NULL AND rejection_resolved_by IS NOT NULL
           AND rejection_resolution = 'CUSTOMER_HANDOVER_CONFIRMED'
           AND length(btrim(rejection_resolution_reason)) BETWEEN 1 AND 255)
       ))
  )
);

CREATE UNIQUE INDEX ux_counter_sale_void_request_tenant_id
  ON pharmacy_counter_sale_void_requests (tenant_id, id);
CREATE UNIQUE INDEX ux_counter_sale_void_request_command
  ON pharmacy_counter_sale_void_requests (tenant_id, requested_by, command_key);
CREATE UNIQUE INDEX ux_counter_sale_void_request_refund
  ON pharmacy_counter_sale_void_requests (tenant_id, refund_id)
  WHERE refund_id IS NOT NULL;
CREATE UNIQUE INDEX ux_counter_sale_void_request_active_sale
  ON pharmacy_counter_sale_void_requests (tenant_id, counter_sale_id)
  WHERE status IN ('CREATING', 'PENDING_REFUND', 'REFUND_REJECTED_REVIEW');
CREATE UNIQUE INDEX ux_counter_sale_void_request_completed_sale
  ON pharmacy_counter_sale_void_requests (tenant_id, counter_sale_id)
  WHERE status = 'COMPLETED';
CREATE UNIQUE INDEX ux_counter_sale_void_request_task
  ON pharmacy_counter_sale_void_requests (tenant_id, task_id)
  WHERE task_id IS NOT NULL;
CREATE INDEX idx_counter_sale_void_request_reconciliation
  ON pharmacy_counter_sale_void_requests (tenant_id, status, requested_at, id)
  WHERE status = 'PENDING_REFUND';

ALTER TABLE billing_refunds
  ADD COLUMN IF NOT EXISTS counter_sale_void_request_id BIGINT;

CREATE UNIQUE INDEX ux_billing_refund_counter_sale_void_request
  ON billing_refunds (tenant_id, counter_sale_void_request_id)
  WHERE counter_sale_void_request_id IS NOT NULL;

ALTER TABLE pharmacy_counter_sale_void_requests
  ADD CONSTRAINT fk_counter_sale_void_sale_tenant
    FOREIGN KEY (tenant_id, counter_sale_id)
    REFERENCES pharmacy_counter_sales (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT fk_counter_sale_void_invoice_tenant
    FOREIGN KEY (tenant_id, invoice_id)
    REFERENCES billing_invoices (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT fk_counter_sale_void_patient_tenant
    FOREIGN KEY (tenant_id, patient_uid)
    REFERENCES users (tenant_id, uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    DEFERRABLE INITIALLY IMMEDIATE,
  ADD CONSTRAINT fk_counter_sale_void_requester_tenant
    FOREIGN KEY (tenant_id, requested_by)
    REFERENCES users (tenant_id, uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT fk_counter_sale_void_reconciler_tenant
    FOREIGN KEY (tenant_id, reconciled_by)
    REFERENCES users (tenant_id, uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT fk_counter_sale_void_rejection_resolver_tenant
    FOREIGN KEY (tenant_id, rejection_resolved_by)
    REFERENCES users (tenant_id, uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT fk_counter_sale_void_task_tenant
    FOREIGN KEY (tenant_id, task_id)
    REFERENCES tasks (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT fk_counter_sale_void_sla_tenant
    FOREIGN KEY (tenant_id, workflow_sla_instance_id)
    REFERENCES workflow_sla_instances (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT fk_counter_sale_void_refund_tenant
    FOREIGN KEY (tenant_id, refund_id)
    REFERENCES billing_refunds (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE billing_refunds
  ADD CONSTRAINT fk_billing_refund_counter_sale_void_request
    FOREIGN KEY (tenant_id, counter_sale_void_request_id)
    REFERENCES pharmacy_counter_sale_void_requests (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE pharmacy_counter_sales
  ADD CONSTRAINT fk_counter_sale_void_refund_tenant_746
    FOREIGN KEY (tenant_id, void_refund_id)
    REFERENCES billing_refunds (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    DEFERRABLE INITIALLY IMMEDIATE;

CREATE OR REPLACE FUNCTION counter_sale_void_request_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  bound_refund billing_refunds%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.audit_bypass', TRUE) = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'counter-sale void request evidence is append-only'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.requested_at := transaction_timestamp();
    NEW.created_at := NEW.requested_at;
    NEW.updated_at := NEW.requested_at;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IN ('CANCELLED_HANDOVER_CONFIRMED', 'COMPLETED')
       AND NEW IS DISTINCT FROM OLD
    THEN
      RAISE EXCEPTION 'terminal counter-sale void request evidence is immutable'
        USING ERRCODE = '23514';
    END IF;

    IF (OLD.tenant_id, OLD.counter_sale_id, OLD.invoice_id, OLD.patient_uid,
        OLD.amount, OLD.refund_mode, OLD.disposition, OLD.reason, OLD.requested_by,
        OLD.requested_by_name, OLD.requested_by_role, OLD.command_key, OLD.request_fingerprint,
        OLD.requested_at, OLD.created_at)
       IS DISTINCT FROM
       (NEW.tenant_id, NEW.counter_sale_id, NEW.invoice_id, NEW.patient_uid,
        NEW.amount, NEW.refund_mode, NEW.disposition, NEW.reason, NEW.requested_by,
        NEW.requested_by_name, NEW.requested_by_role, NEW.command_key, NEW.request_fingerprint,
        NEW.requested_at, NEW.created_at)
    THEN
      RAISE EXCEPTION 'counter-sale void request identity is immutable'
        USING ERRCODE = '23514';
    END IF;

    IF OLD.refund_id IS DISTINCT FROM NEW.refund_id
       AND NOT (
         OLD.status = 'CREATING'
         AND OLD.refund_id IS NULL
         AND NEW.refund_id IS NOT NULL
       )
    THEN
      RAISE EXCEPTION 'counter-sale void request refund binding is immutable'
        USING ERRCODE = '23514';
    END IF;

    IF (OLD.task_id, OLD.workflow_sla_instance_id) IS DISTINCT FROM
       (NEW.task_id, NEW.workflow_sla_instance_id)
       AND NOT (
         OLD.status = 'PENDING_REFUND'
         AND OLD.task_id IS NULL
         AND OLD.workflow_sla_instance_id IS NULL
         AND NEW.task_id IS NOT NULL
         AND NEW.workflow_sla_instance_id IS NOT NULL
       )
    THEN
      RAISE EXCEPTION 'counter-sale void task and SLA binding is immutable'
        USING ERRCODE = '23514';
    END IF;

    IF OLD.status <> NEW.status AND NOT (
      (OLD.status = 'CREATING' AND NEW.status = 'PENDING_REFUND')
      OR (OLD.status = 'PENDING_REFUND'
          AND NEW.status IN ('REFUND_REJECTED_REVIEW', 'COMPLETED'))
      OR (OLD.status = 'REFUND_REJECTED_REVIEW'
          AND NEW.status = 'CANCELLED_HANDOVER_CONFIRMED')
    ) THEN
      RAISE EXCEPTION 'invalid counter-sale void request transition % -> %', OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;

    IF OLD.task_stage <> NEW.task_stage AND NOT (
      (OLD.task_stage = 'approval'
        AND NEW.task_stage IN ('payout', 'reconciliation', 'rejected_review'))
      OR (OLD.task_stage = 'payout'
        AND NEW.task_stage IN ('reconciliation', 'rejected_review'))
      OR (OLD.task_stage = 'reconciliation' AND NEW.task_stage = 'completed')
      OR (OLD.task_stage = 'rejected_review' AND NEW.task_stage = 'cancelled')
    ) THEN
      RAISE EXCEPTION 'invalid counter-sale void task stage transition % -> %',
        OLD.task_stage, NEW.task_stage
        USING ERRCODE = '23514';
    END IF;
  END IF;

  NEW.requested_by_role := UPPER(BTRIM(NEW.requested_by_role));
  IF TG_OP = 'INSERT' AND (
    NEW.requested_by_role NOT IN ('ADMIN', 'PHARMACY_INCHARGE')
    OR NOT EXISTS (
       SELECT 1
         FROM users requester
        WHERE requester.tenant_id = NEW.tenant_id
          AND requester.uid = NEW.requested_by
          AND UPPER(BTRIM(requester.role)) = NEW.requested_by_role
          AND COALESCE(requester.is_active, TRUE)
          AND NOT COALESCE(requester.is_deleted, FALSE)
     )
  )
  THEN
    RAISE EXCEPTION 'counter-sale void requester lacks active pharmacy void authority'
      USING ERRCODE = '23514';
  END IF;

  IF (NEW.task_id IS NULL) IS DISTINCT FROM
     (NEW.workflow_sla_instance_id IS NULL)
  THEN
    RAISE EXCEPTION 'counter-sale void task and SLA must be bound together'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pharmacy_counter_sales sale
      JOIN billing_invoices invoice
        ON invoice.tenant_id = sale.tenant_id
       AND invoice.id = sale.invoice_id
     WHERE sale.tenant_id = NEW.tenant_id
       AND sale.id = NEW.counter_sale_id
       AND sale.invoice_id = NEW.invoice_id
       AND invoice.patient_uid = NEW.patient_uid
       AND sale.total_amount = NEW.amount
       AND invoice.total_amount = NEW.amount
       AND UPPER(sale.payment_mode) = NEW.refund_mode
       AND invoice.invoice_type = 'PHARMACY'
       AND (
         (TG_OP = 'INSERT' AND sale.status = 'COMPLETED')
         OR (TG_OP = 'UPDATE'
             AND sale.status IN ('COMPLETED', 'VOID_PENDING_REFUND', 'VOIDED'))
       )
       AND (sale.created_at AT TIME ZONE 'Asia/Kolkata')::date =
           (NEW.requested_at AT TIME ZONE 'Asia/Kolkata')::date
       AND NEW.requested_at <= NOW() + INTERVAL '5 minutes'
       AND (
         (TG_OP = 'UPDATE' AND OLD.status <> 'CREATING')
         OR (
           invoice.amount_paid = NEW.amount
           AND invoice.status = 'PAID'
           AND (
             NEW.refund_mode = 'CASH'
             OR length(btrim(COALESCE(sale.payment_reference, ''))) > 0
           )
           AND EXISTS (
             SELECT 1
               FROM billing_payments payment
              WHERE payment.tenant_id = NEW.tenant_id
                AND payment.invoice_id = NEW.invoice_id
                AND payment.reversed = FALSE
              HAVING COUNT(*) = 1
                 AND SUM(payment.amount) = NEW.amount
                 AND bool_and(UPPER(payment.mode) = NEW.refund_mode)
                 AND bool_and(payment.reference IS NOT DISTINCT FROM sale.payment_reference)
           )
           AND NOT EXISTS (
             SELECT 1
               FROM billing_refunds other_refund
              WHERE other_refund.tenant_id = NEW.tenant_id
                AND other_refund.invoice_id = NEW.invoice_id
                AND other_refund.approval_status <> 'REJECTED'
                AND other_refund.id IS DISTINCT FROM NEW.refund_id
           )
         )
       )
  ) THEN
    RAISE EXCEPTION 'counter-sale void request does not match its exact sale and invoice'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.task_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM tasks task
      JOIN workflow_sla_instances sla
        ON sla.tenant_id = task.tenant_id
       AND sla.id = task.workflow_sla_instance_id
     WHERE task.tenant_id = NEW.tenant_id
       AND task.id = NEW.task_id
       AND task.workflow_sla_instance_id = NEW.workflow_sla_instance_id
       AND task.related_resource_type = 'pharmacy_counter_sale_void_requests'
       AND task.related_resource_id = NEW.id::text
       AND task.metadata->>'task_contract' = 'counter_sale_void_refund_v1'
       AND task.metadata->>'counter_sale_void_request_id' = NEW.id::text
       AND task.sla_completion_semantics = 'domain_evidence'
       AND sla.rule_code = 'counter_sale_void_refund'
       AND sla.source_table = task.related_resource_type
       AND sla.source_id = task.related_resource_id
  ) THEN
    RAISE EXCEPTION 'counter-sale void task and SLA binding is not exact'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status <> 'CREATING' THEN
    SELECT refund.* INTO bound_refund
      FROM billing_refunds refund
     WHERE refund.tenant_id = NEW.tenant_id
       AND refund.id = NEW.refund_id
       AND refund.counter_sale_void_request_id = NEW.id;

    IF NOT FOUND
       OR bound_refund.invoice_id IS DISTINCT FROM NEW.invoice_id
       OR bound_refund.patient_uid IS DISTINCT FROM NEW.patient_uid
       OR bound_refund.amount IS DISTINCT FROM NEW.amount
       OR UPPER(bound_refund.mode) IS DISTINCT FROM NEW.refund_mode
       OR bound_refund.raised_by IS DISTINCT FROM NEW.requested_by
    THEN
      RAISE EXCEPTION 'counter-sale void request refund identity mismatch'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.status IN ('REFUND_REJECTED_REVIEW', 'CANCELLED_HANDOVER_CONFIRMED')
       AND bound_refund.approval_status <> 'REJECTED'
    THEN
      RAISE EXCEPTION 'counter-sale void request rejection lacks rejected refund evidence'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.status = 'COMPLETED'
       AND bound_refund.approval_status <> 'PAID'
    THEN
      RAISE EXCEPTION 'counter-sale void request completion lacks paid refund evidence'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.status = 'CREATING' AND NEW.task_stage <> 'approval' THEN
    RAISE EXCEPTION 'creating counter-sale void request must start in approval stage'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'REFUND_REJECTED_REVIEW'
     AND NEW.task_stage <> 'rejected_review'
  THEN
    RAISE EXCEPTION 'rejected counter-sale void must remain in explicit review'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'CANCELLED_HANDOVER_CONFIRMED'
     AND NEW.task_stage <> 'cancelled'
  THEN
    RAISE EXCEPTION 'handover-confirmed cancellation must close its task stage'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'COMPLETED' AND NEW.task_stage <> 'completed' THEN
    RAISE EXCEPTION 'completed counter-sale void must close its task stage'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.reconciliation_source = 'manual' AND (
    NEW.reconciled_by IS NULL
    OR NOT EXISTS (
      SELECT 1
        FROM users reconciler
       WHERE reconciler.tenant_id = NEW.tenant_id
         AND reconciler.uid = NEW.reconciled_by
         AND UPPER(BTRIM(reconciler.role)) IN ('ADMIN', 'PHARMACY_INCHARGE')
         AND COALESCE(reconciler.is_active, TRUE)
         AND NOT COALESCE(reconciler.is_deleted, FALSE)
    )
  ) THEN
    RAISE EXCEPTION 'manual counter-sale void reconciliation lacks active pharmacy authority'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'CANCELLED_HANDOVER_CONFIRMED' AND NOT EXISTS (
    SELECT 1
      FROM users resolver
     WHERE resolver.tenant_id = NEW.tenant_id
       AND resolver.uid = NEW.rejection_resolved_by
       AND UPPER(BTRIM(resolver.role)) IN ('ADMIN', 'PHARMACY_INCHARGE')
       AND COALESCE(resolver.is_active, TRUE)
       AND NOT COALESCE(resolver.is_deleted, FALSE)
  ) THEN
    RAISE EXCEPTION 'rejected-refund custody resolution lacks active pharmacy authority'
      USING ERRCODE = '23514';
  END IF;

  NEW.updated_at := NOW();
  RETURN NEW;
END
$fn$;

CREATE TRIGGER counter_sale_void_request_guard
  BEFORE INSERT OR UPDATE OR DELETE ON pharmacy_counter_sale_void_requests
  FOR EACH ROW EXECUTE FUNCTION counter_sale_void_request_guard();

CREATE OR REPLACE FUNCTION counter_sale_void_refund_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  request_row pharmacy_counter_sale_void_requests%ROWTYPE;
  cash_drawer_id TEXT;
  offline_evidence_id TEXT;
  offline_evidence_accepted BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.counter_sale_void_request_id IS NOT NULL THEN
      RAISE EXCEPTION 'a counter-sale void refund is immutable evidence'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.counter_sale_void_request_id IS NOT NULL
     AND NEW.counter_sale_void_request_id IS DISTINCT FROM OLD.counter_sale_void_request_id
  THEN
    RAISE EXCEPTION 'counter-sale void refund cannot be detached or rebound'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.counter_sale_void_request_id IS NOT NULL
     AND OLD.approval_status IN ('PAID', 'REJECTED')
     AND NEW IS DISTINCT FROM OLD
  THEN
    RAISE EXCEPTION 'terminal counter-sale void refund evidence is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.counter_sale_void_request_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT request.* INTO request_row
    FROM pharmacy_counter_sale_void_requests request
   WHERE request.tenant_id = NEW.tenant_id
     AND request.id = NEW.counter_sale_void_request_id;

  IF NOT FOUND
     OR NEW.invoice_id IS DISTINCT FROM request_row.invoice_id
     OR NEW.advance_id IS NOT NULL
     OR NEW.patient_uid IS DISTINCT FROM request_row.patient_uid
     OR NEW.amount IS DISTINCT FROM request_row.amount
     OR UPPER(NEW.mode) IS DISTINCT FROM request_row.refund_mode
     OR NEW.raised_by IS DISTINCT FROM request_row.requested_by
  THEN
    RAISE EXCEPTION 'counter-sale void refund identity mismatch'
      USING ERRCODE = '23514';
  END IF;

  cash_drawer_id := NULLIF(to_jsonb(NEW)->>'cash_drawer_session_id', '');
  offline_evidence_id := NULLIF(
    to_jsonb(NEW)->>'offline_electronic_evidence_id',
    ''
  );

  IF TG_OP = 'UPDATE' AND (
    OLD.counter_sale_void_request_id,
    OLD.tenant_id,
    OLD.invoice_id,
    OLD.advance_id,
    OLD.patient_uid,
    OLD.amount,
    OLD.mode,
    OLD.raised_by
  ) IS DISTINCT FROM (
    NEW.counter_sale_void_request_id,
    NEW.tenant_id,
    NEW.invoice_id,
    NEW.advance_id,
    NEW.patient_uid,
    NEW.amount,
    NEW.mode,
    NEW.raised_by
  ) THEN
    RAISE EXCEPTION 'counter-sale void refund binding is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' AND NEW.approval_status <> 'PENDING' THEN
    RAISE EXCEPTION 'counter-sale void refund must start pending'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.approval_status IS DISTINCT FROM NEW.approval_status
     AND NOT (
       (OLD.approval_status = 'PENDING'
         AND NEW.approval_status IN ('APPROVED', 'REJECTED'))
       OR (OLD.approval_status = 'APPROVED'
         AND NEW.approval_status = 'PAID')
     )
  THEN
    RAISE EXCEPTION 'invalid counter-sale void refund transition % -> %',
      OLD.approval_status, NEW.approval_status
      USING ERRCODE = '23514';
  END IF;

  IF NEW.approval_status = 'PENDING' AND (
    NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL
    OR NEW.rejected_by IS NOT NULL OR NEW.rejected_at IS NOT NULL
    OR NEW.rejection_reason IS NOT NULL OR NEW.paid_by IS NOT NULL
    OR NEW.paid_at IS NOT NULL OR NEW.payout_rail IS NOT NULL
    OR NEW.payout_rail_claimed_at IS NOT NULL OR NEW.gateway_refund_id IS NOT NULL
    OR NEW.reference IS NOT NULL OR cash_drawer_id IS NOT NULL
    OR offline_evidence_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'pending counter-sale void refund carries premature authority evidence'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.approval_status = 'APPROVED' AND (
    NEW.approved_by IS NULL OR NEW.approved_at IS NULL
    OR NEW.approved_by = request_row.requested_by
    OR NEW.rejected_by IS NOT NULL OR NEW.rejected_at IS NOT NULL
    OR NEW.rejection_reason IS NOT NULL OR NEW.paid_by IS NOT NULL
    OR NEW.paid_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'approved counter-sale void refund lacks independent approval evidence'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.approval_status = 'REJECTED' AND (
    NEW.rejected_by IS NULL OR NEW.rejected_at IS NULL
    OR NEW.rejected_by = request_row.requested_by
    OR NOT EXISTS (
      SELECT 1
        FROM users rejector
       WHERE rejector.tenant_id = NEW.tenant_id
         AND rejector.uid = NEW.rejected_by
         AND UPPER(BTRIM(rejector.role)) IN ('ADMIN', 'SUPER_ADMIN')
         AND COALESCE(rejector.is_active, TRUE)
         AND NOT COALESCE(rejector.is_deleted, FALSE)
    )
    OR length(btrim(COALESCE(NEW.rejection_reason, ''))) = 0
    OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL
    OR NEW.paid_by IS NOT NULL OR NEW.paid_at IS NOT NULL
    OR NEW.payout_rail IS NOT NULL OR NEW.payout_rail_claimed_at IS NOT NULL
    OR NEW.gateway_refund_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'rejected counter-sale void refund lacks independent rejection evidence'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.approval_status IN ('APPROVED', 'PAID') AND (
    NEW.approved_by IS NULL OR NEW.approved_at IS NULL
    OR NEW.approved_by = request_row.requested_by
    OR (
      NEW.approval_status = 'APPROVED'
      AND NOT EXISTS (
      SELECT 1
        FROM users approver
       WHERE approver.tenant_id = NEW.tenant_id
         AND approver.uid = NEW.approved_by
         AND UPPER(BTRIM(approver.role)) IN ('ADMIN', 'SUPER_ADMIN')
         AND COALESCE(approver.is_active, TRUE)
         AND NOT COALESCE(approver.is_deleted, FALSE)
      )
    )
  ) THEN
    RAISE EXCEPTION 'counter-sale void refund requires independent billing approval'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.approval_status = 'PAID' THEN
    IF NEW.paid_at IS NULL
       OR NEW.payout_rail_claimed_at IS NULL
       OR NEW.payout_rail NOT IN ('manual', 'gateway', 'offline_electronic')
       OR NEW.rejected_by IS NOT NULL OR NEW.rejected_at IS NOT NULL
       OR NEW.rejection_reason IS NOT NULL
    THEN
      RAISE EXCEPTION 'counter-sale void refund lacks payout evidence'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.payout_rail = 'manual' AND (
      NEW.paid_by IS NULL
      OR NEW.paid_by = request_row.requested_by
      OR NEW.paid_by = NEW.approved_by
      OR length(btrim(COALESCE(NEW.reference, ''))) = 0
      OR UPPER(NEW.mode) NOT IN ('CASH', 'CHEQUE', 'DD')
      OR NEW.gateway_refund_id IS NOT NULL
      OR offline_evidence_id IS NOT NULL
      OR NOT EXISTS (
        SELECT 1
          FROM users payer
         WHERE payer.tenant_id = NEW.tenant_id
           AND payer.uid = NEW.paid_by
           AND UPPER(BTRIM(payer.role)) IN (
             'FINANCE_INCHARGE', 'BILLING_INCHARGE',
             'BILLING_STAFF', 'CASHIER'
           )
           AND COALESCE(payer.is_active, TRUE)
           AND NOT COALESCE(payer.is_deleted, FALSE)
      )
    ) THEN
      RAISE EXCEPTION 'counter-sale void manual payout lacks independent rail evidence'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.payout_rail = 'manual'
       AND UPPER(NEW.mode) = 'CASH'
       AND (
         cash_drawer_id IS NULL
         OR NOT EXISTS (
           SELECT 1
             FROM cash_drawer_sessions drawer
            WHERE drawer.tenant_id = NEW.tenant_id
              AND drawer.id::text = cash_drawer_id
              AND drawer.cashier_uid = NEW.paid_by
              AND drawer.status = 'open'
         )
       )
    THEN
      RAISE EXCEPTION 'counter-sale cash refund lacks open owned drawer evidence'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.payout_rail = 'manual'
       AND UPPER(NEW.mode) IN ('CHEQUE', 'DD')
       AND cash_drawer_id IS NOT NULL
    THEN
      RAISE EXCEPTION 'non-cash manual refund cannot claim a cash drawer'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.payout_rail = 'gateway' AND (
      NEW.paid_by IS NOT NULL
      OR NEW.gateway_refund_id IS NULL
      OR cash_drawer_id IS NOT NULL
      OR offline_evidence_id IS NOT NULL
      OR UPPER(NEW.mode) NOT IN ('CARD', 'UPI', 'NETBANKING', 'WALLET')
      OR length(btrim(COALESCE(NEW.reference, ''))) = 0
      OR NOT EXISTS (
        SELECT 1
          FROM payment_gateway_refunds execution
          JOIN payment_gateway_orders gateway_order
            ON gateway_order.tenant_id = execution.tenant_id
           AND gateway_order.id = execution.gateway_order_id
          JOIN billing_payments payment
            ON payment.tenant_id = gateway_order.tenant_id
           AND payment.id = gateway_order.billing_payment_id
          JOIN pharmacy_counter_sales sale
            ON sale.tenant_id = request_row.tenant_id
           AND sale.id = request_row.counter_sale_id
          JOIN users payout_actor
            ON payout_actor.tenant_id = execution.tenant_id
           AND payout_actor.uid = execution.initiated_by
         WHERE execution.tenant_id = NEW.tenant_id
           AND execution.id = NEW.gateway_refund_id
           AND execution.billing_refund_id = NEW.id
           AND execution.status = 'processed'
           AND execution.amount = NEW.amount
           AND execution.provider_refund_id = NEW.reference
           AND execution.processed_at IS NOT NULL
           AND execution.initiated_by NOT IN (request_row.requested_by, NEW.approved_by)
           AND gateway_order.provider = execution.provider
           AND gateway_order.environment = execution.environment
           AND gateway_order.invoice_id = request_row.invoice_id
           AND gateway_order.patient_uid = request_row.patient_uid
           AND gateway_order.amount = request_row.amount
           AND gateway_order.status = 'paid'
           AND gateway_order.provider_payment_id = execution.provider_payment_id
           AND payment.invoice_id = request_row.invoice_id
           AND payment.patient_uid = request_row.patient_uid
           AND payment.amount = request_row.amount
           AND UPPER(payment.mode) = request_row.refund_mode
           AND payment.reference = sale.payment_reference
           AND payment.reference = execution.provider_payment_id
           AND payment.reversed = FALSE
           AND UPPER(BTRIM(payout_actor.role)) IN (
             'FINANCE_INCHARGE', 'BILLING_INCHARGE',
             'BILLING_STAFF', 'CASHIER'
           )
           AND COALESCE(payout_actor.is_active, TRUE)
           AND NOT COALESCE(payout_actor.is_deleted, FALSE)
      )
    ) THEN
      RAISE EXCEPTION 'counter-sale void gateway payout lacks execution evidence'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.payout_rail = 'offline_electronic' AND (
      NEW.paid_by IS NULL
      OR NEW.paid_by = request_row.requested_by
      OR NEW.paid_by = NEW.approved_by
      OR NEW.gateway_refund_id IS NOT NULL
      OR cash_drawer_id IS NOT NULL
      OR offline_evidence_id IS NULL
      OR UPPER(NEW.mode) NOT IN ('CARD', 'UPI', 'NETBANKING', 'WALLET')
      OR length(btrim(COALESCE(NEW.reference, ''))) = 0
      OR NOT EXISTS (
        SELECT 1
          FROM users payer
         WHERE payer.tenant_id = NEW.tenant_id
           AND payer.uid = NEW.paid_by
           AND UPPER(BTRIM(payer.role)) IN (
             'FINANCE_INCHARGE', 'BILLING_INCHARGE',
             'BILLING_STAFF', 'CASHIER'
           )
           AND COALESCE(payer.is_active, TRUE)
           AND NOT COALESCE(payer.is_deleted, FALSE)
      )
    ) THEN
      RAISE EXCEPTION 'counter-sale offline electronic payout lacks exact evidence'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.payout_rail = 'offline_electronic' THEN
      EXECUTE $sql$
        SELECT EXISTS (
          SELECT 1
            FROM public.billing_refund_offline_electronic_evidence evidence
            JOIN public.billing_payments payment
              ON payment.tenant_id = evidence.tenant_id
             AND payment.id = evidence.original_payment_id
            JOIN public.pharmacy_counter_sales sale
              ON sale.tenant_id = evidence.tenant_id
             AND sale.id = $1::bigint
           WHERE evidence.tenant_id = $2::uuid
             AND evidence.id::text = $3
             AND evidence.refund_id = $4::int
             AND evidence.original_payment_id IS NOT NULL
             AND evidence.original_advance_id IS NULL
             AND evidence.original_payment_reference = payment.reference
             AND evidence.provider_refund_reference = $5
             AND evidence.recorded_by = $6::uuid
             AND payment.invoice_id = $7::int
             AND payment.patient_uid = $8::uuid
             AND payment.amount = $9::numeric
             AND UPPER(payment.mode) = $10
             AND payment.reversed = FALSE
             AND sale.invoice_id = $7::int
             AND sale.total_amount = $9::numeric
             AND UPPER(sale.payment_mode) = $10
             AND sale.payment_reference = payment.reference
             AND sale.status = 'VOID_PENDING_REFUND'
             AND sale.void_refund_id = $4::int
        )
      $sql$
        INTO offline_evidence_accepted
        USING request_row.counter_sale_id,
              NEW.tenant_id,
              offline_evidence_id,
              NEW.id,
              NEW.reference,
              NEW.paid_by,
              request_row.invoice_id,
              request_row.patient_uid,
              request_row.amount,
              request_row.refund_mode;
      IF NOT offline_evidence_accepted THEN
        RAISE EXCEPTION 'counter-sale offline electronic payout does not match the original sale receipt'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END
$fn$;

CREATE TRIGGER counter_sale_void_refund_guard
  BEFORE INSERT OR UPDATE OR DELETE ON billing_refunds
  FOR EACH ROW EXECUTE FUNCTION counter_sale_void_refund_guard();

CREATE OR REPLACE FUNCTION counter_sale_void_has_paid_evidence(
  p_request_id BIGINT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  request_row pharmacy_counter_sale_void_requests%ROWTYPE;
  refund_row billing_refunds%ROWTYPE;
  refund_json JSONB;
  cash_drawer_id TEXT;
  offline_evidence_id TEXT;
  accepted BOOLEAN := FALSE;
BEGIN
  SELECT request.* INTO request_row
    FROM pharmacy_counter_sale_void_requests request
   WHERE request.id = p_request_id;
  IF NOT FOUND OR request_row.refund_id IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT refund.* INTO refund_row
    FROM billing_refunds refund
   WHERE refund.tenant_id = request_row.tenant_id
     AND refund.id = request_row.refund_id
     AND refund.counter_sale_void_request_id = request_row.id;
  IF NOT FOUND
     OR refund_row.invoice_id IS DISTINCT FROM request_row.invoice_id
     OR refund_row.advance_id IS NOT NULL
     OR refund_row.patient_uid IS DISTINCT FROM request_row.patient_uid
     OR refund_row.amount IS DISTINCT FROM request_row.amount
     OR UPPER(refund_row.mode) IS DISTINCT FROM request_row.refund_mode
     OR refund_row.approval_status <> 'PAID'
     OR refund_row.approved_by IS NULL
     OR refund_row.approved_at IS NULL
     OR refund_row.approved_by = request_row.requested_by
     OR refund_row.paid_at IS NULL
     OR refund_row.payout_rail_claimed_at IS NULL
     OR length(btrim(COALESCE(refund_row.reference, ''))) = 0
  THEN
    RETURN FALSE;
  END IF;

  refund_json := to_jsonb(refund_row);
  cash_drawer_id := NULLIF(refund_json->>'cash_drawer_session_id', '');
  offline_evidence_id := NULLIF(
    refund_json->>'offline_electronic_evidence_id',
    ''
  );

  IF refund_row.payout_rail = 'manual' THEN
    IF refund_row.paid_by IS NULL
       OR refund_row.paid_by IN (request_row.requested_by, refund_row.approved_by)
       OR refund_row.gateway_refund_id IS NOT NULL
       OR offline_evidence_id IS NOT NULL
       OR UPPER(refund_row.mode) NOT IN ('CASH', 'CHEQUE', 'DD')
    THEN
      RETURN FALSE;
    END IF;
    IF UPPER(refund_row.mode) = 'CASH' THEN
      RETURN cash_drawer_id IS NOT NULL AND EXISTS (
        SELECT 1
          FROM cash_drawer_sessions drawer
         WHERE drawer.tenant_id = refund_row.tenant_id
           AND drawer.id::text = cash_drawer_id
           AND drawer.cashier_uid = refund_row.paid_by
           AND drawer.opened_at <= refund_row.paid_at
           AND (drawer.closed_at IS NULL OR drawer.closed_at >= refund_row.paid_at)
      );
    END IF;
    RETURN cash_drawer_id IS NULL;
  END IF;

  IF refund_row.payout_rail = 'gateway' THEN
    RETURN refund_row.paid_by IS NULL
      AND refund_row.gateway_refund_id IS NOT NULL
      AND cash_drawer_id IS NULL
      AND offline_evidence_id IS NULL
      AND UPPER(refund_row.mode) IN ('CARD', 'UPI', 'NETBANKING', 'WALLET')
      AND EXISTS (
        SELECT 1
          FROM payment_gateway_refunds execution
          JOIN payment_gateway_orders gateway_order
            ON gateway_order.tenant_id = execution.tenant_id
           AND gateway_order.id = execution.gateway_order_id
          JOIN billing_payments payment
            ON payment.tenant_id = gateway_order.tenant_id
           AND payment.id = gateway_order.billing_payment_id
          JOIN pharmacy_counter_sales sale
            ON sale.tenant_id = request_row.tenant_id
           AND sale.id = request_row.counter_sale_id
         WHERE execution.tenant_id = refund_row.tenant_id
           AND execution.id = refund_row.gateway_refund_id
           AND execution.billing_refund_id = refund_row.id
           AND execution.status = 'processed'
           AND execution.amount = refund_row.amount
           AND execution.provider_refund_id = refund_row.reference
           AND execution.processed_at IS NOT NULL
           AND execution.initiated_by NOT IN (
             request_row.requested_by,
             refund_row.approved_by
           )
           AND gateway_order.provider = execution.provider
           AND gateway_order.environment = execution.environment
           AND gateway_order.invoice_id = request_row.invoice_id
           AND gateway_order.patient_uid = request_row.patient_uid
           AND gateway_order.amount = request_row.amount
           AND gateway_order.status = 'paid'
           AND gateway_order.provider_payment_id = execution.provider_payment_id
           AND payment.invoice_id = request_row.invoice_id
           AND payment.patient_uid = request_row.patient_uid
           AND payment.amount = request_row.amount
           AND UPPER(payment.mode) = request_row.refund_mode
           AND payment.reference = sale.payment_reference
           AND payment.reference = execution.provider_payment_id
           AND payment.reversed = FALSE
      );
  END IF;

  IF refund_row.payout_rail = 'offline_electronic' THEN
    IF to_regclass('public.billing_refund_offline_electronic_evidence') IS NULL
       OR offline_evidence_id IS NULL
       OR refund_row.paid_by IS NULL
       OR refund_row.paid_by IN (request_row.requested_by, refund_row.approved_by)
       OR refund_row.gateway_refund_id IS NOT NULL
       OR cash_drawer_id IS NOT NULL
       OR UPPER(refund_row.mode) NOT IN ('CARD', 'UPI', 'NETBANKING', 'WALLET')
    THEN
      RETURN FALSE;
    END IF;
    EXECUTE $sql$
      SELECT EXISTS (
        SELECT 1
          FROM public.billing_refund_offline_electronic_evidence evidence
          JOIN public.billing_payments payment
            ON payment.tenant_id = evidence.tenant_id
           AND payment.id = evidence.original_payment_id
          JOIN public.pharmacy_counter_sales sale
            ON sale.tenant_id = evidence.tenant_id
           AND sale.id = $11::bigint
         WHERE evidence.tenant_id = $1::uuid
           AND evidence.id::text = $2
           AND evidence.refund_id = $3::int
           AND evidence.original_payment_id IS NOT NULL
           AND evidence.original_advance_id IS NULL
           AND evidence.mode = $4
           AND evidence.amount = $5::numeric
           AND length(btrim(evidence.provider_name)) > 0
           AND evidence.original_payment_reference = payment.reference
           AND evidence.provider_refund_reference = $6
           AND evidence.provider_refunded_at IS NOT NULL
           AND evidence.recorded_at IS NOT NULL
           AND evidence.recorded_by = $7::uuid
           AND evidence.recorded_by NOT IN ($8::uuid, $9::uuid)
           AND payment.invoice_id = $10::int
           AND payment.patient_uid = $12::uuid
           AND payment.reversed = FALSE
           AND payment.amount = $5::numeric
           AND UPPER(payment.mode) = $4
           AND sale.invoice_id = $10::int
           AND sale.total_amount = $5::numeric
           AND UPPER(sale.payment_mode) = $4
           AND sale.payment_reference = payment.reference
           AND sale.status IN ('VOID_PENDING_REFUND', 'VOIDED')
           AND sale.void_refund_id = $3::int
      )
    $sql$
      INTO accepted
      USING refund_row.tenant_id,
            offline_evidence_id,
            refund_row.id,
            request_row.refund_mode,
            refund_row.amount,
            refund_row.reference,
            refund_row.paid_by,
            request_row.requested_by,
            refund_row.approved_by,
            request_row.invoice_id,
            request_row.counter_sale_id,
            request_row.patient_uid;
    RETURN accepted;
  END IF;

  RETURN FALSE;
END;
$fn$;

CREATE OR REPLACE FUNCTION counter_sale_void_stock_return_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.reference_type = 'pharmacy_counter_sale_void' THEN
      RAISE EXCEPTION 'counter-sale void stock-return evidence is immutable'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND (
    OLD.reference_type = 'pharmacy_counter_sale_void'
    OR NEW.reference_type = 'pharmacy_counter_sale_void'
  ) AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'counter-sale void stock-return evidence is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.reference_type IS DISTINCT FROM 'pharmacy_counter_sale_void' THEN
    RETURN NEW;
  END IF;

  IF NEW.reference_id !~ '^[1-9][0-9]*$'
     OR NEW.movement_kind <> 'return'
     OR NEW.inventory_batch_id IS NULL
     OR NEW.quantity_delta <= 0
     OR NOT EXISTS (
       SELECT 1
         FROM pharmacy_counter_sale_void_requests request
         JOIN pharmacy_counter_sale_lines line
           ON line.tenant_id = request.tenant_id
          AND line.counter_sale_id = request.counter_sale_id
         JOIN pharmacy_counter_sale_allocations allocation
           ON allocation.tenant_id = line.tenant_id
          AND allocation.counter_sale_line_id = line.id
        WHERE request.tenant_id = NEW.tenant_id
          AND request.counter_sale_id = NEW.reference_id::bigint
          AND request.status = 'PENDING_REFUND'
          AND request.disposition = 'NEVER_HANDED_OVER'
          AND request.requested_by = NEW.performed_by
          AND line.inventory_item_id = NEW.inventory_item_id
          AND allocation.inventory_batch_id = NEW.inventory_batch_id
          AND allocation.quantity = NEW.quantity_delta
          AND allocation.return_movement_id IS NULL
          AND counter_sale_void_has_paid_evidence(request.id)
     )
  THEN
    RAISE EXCEPTION 'counter-sale stock return requires its exact paid void obligation'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$fn$;

CREATE TRIGGER counter_sale_void_stock_return_guard
  BEFORE INSERT OR UPDATE OR DELETE ON pharmacy_stock_movements
  FOR EACH ROW EXECUTE FUNCTION counter_sale_void_stock_return_guard();

CREATE OR REPLACE FUNCTION counter_sale_void_allocation_return_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF OLD.return_movement_id IS NOT NULL
     AND NEW.return_movement_id IS DISTINCT FROM OLD.return_movement_id
  THEN
    RAISE EXCEPTION 'counter-sale allocation return evidence is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.return_movement_id IS NULL AND NEW.return_movement_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM pharmacy_counter_sale_lines line
         JOIN pharmacy_counter_sale_void_requests request
           ON request.tenant_id = line.tenant_id
          AND request.counter_sale_id = line.counter_sale_id
         JOIN pharmacy_stock_movements movement
           ON movement.tenant_id = NEW.tenant_id
          AND movement.id = NEW.return_movement_id
        WHERE line.tenant_id = NEW.tenant_id
          AND line.id = NEW.counter_sale_line_id
          AND request.status = 'PENDING_REFUND'
          AND request.disposition = 'NEVER_HANDED_OVER'
          AND movement.inventory_item_id = line.inventory_item_id
          AND movement.inventory_batch_id = NEW.inventory_batch_id
          AND movement.movement_kind = 'return'
          AND movement.quantity_delta = NEW.quantity
          AND movement.reference_type = 'pharmacy_counter_sale_void'
          AND movement.reference_id = line.counter_sale_id::text
          AND movement.performed_by = request.requested_by
          AND counter_sale_void_has_paid_evidence(request.id)
     )
  THEN
    RAISE EXCEPTION 'counter-sale allocation cannot restock before exact paid-refund evidence'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$fn$;

CREATE TRIGGER counter_sale_void_allocation_return_guard
  BEFORE UPDATE OF return_movement_id ON pharmacy_counter_sale_allocations
  FOR EACH ROW EXECUTE FUNCTION counter_sale_void_allocation_return_guard();

CREATE OR REPLACE FUNCTION counter_sale_void_sale_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  request_row pharmacy_counter_sale_void_requests%ROWTYPE;
BEGIN
  IF OLD.status = 'VOIDED' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'voided counter sale is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'VOID_PENDING_REFUND'
     AND NEW.status NOT IN ('VOID_PENDING_REFUND', 'COMPLETED', 'VOIDED')
  THEN
    RAISE EXCEPTION 'invalid counter-sale void transition % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'VOID_PENDING_REFUND' AND (
    OLD.tenant_id,
    OLD.id,
    OLD.patient_uid,
    OLD.invoice_id,
    OLD.payment_mode,
    OLD.payment_reference,
    OLD.total_amount
  ) IS DISTINCT FROM (
    NEW.tenant_id,
    NEW.id,
    NEW.patient_uid,
    NEW.invoice_id,
    NEW.payment_mode,
    NEW.payment_reference,
    NEW.total_amount
  ) THEN
    RAISE EXCEPTION 'pending counter-sale void financial identity is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'VOID_PENDING_REFUND'
     AND NEW.status IN ('VOID_PENDING_REFUND', 'VOIDED')
     AND NEW.void_refund_id IS DISTINCT FROM OLD.void_refund_id
  THEN
    RAISE EXCEPTION 'pending counter-sale void refund binding is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status NOT IN ('VOID_PENDING_REFUND', 'VOIDED')
     AND NEW.void_refund_id IS NOT NULL
  THEN
    RAISE EXCEPTION 'ordinary counter sale cannot retain void refund evidence'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status <> 'VOIDED' AND (
    NEW.voided_at IS NOT NULL OR NEW.voided_by IS NOT NULL
    OR NEW.void_reason IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'non-voided counter sale cannot carry terminal void evidence'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'VOID_PENDING_REFUND' THEN
    IF OLD.status NOT IN ('COMPLETED', 'VOID_PENDING_REFUND') THEN
      RAISE EXCEPTION 'counter-sale void can start only from completed'
        USING ERRCODE = '23514';
    END IF;
    SELECT request.* INTO request_row
      FROM pharmacy_counter_sale_void_requests request
     WHERE request.tenant_id = NEW.tenant_id
       AND request.counter_sale_id = NEW.id
       AND request.refund_id = NEW.void_refund_id
       AND request.status IN ('PENDING_REFUND', 'REFUND_REJECTED_REVIEW');
    IF NOT FOUND
       OR request_row.task_id IS NULL
       OR request_row.workflow_sla_instance_id IS NULL
       OR (NEW.created_at AT TIME ZONE 'Asia/Kolkata')::date <>
          (request_row.requested_at AT TIME ZONE 'Asia/Kolkata')::date
    THEN
      RAISE EXCEPTION 'pending counter-sale void lacks its exact refund request'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF OLD.status = 'VOID_PENDING_REFUND' AND NEW.status = 'COMPLETED' THEN
    SELECT request.* INTO request_row
      FROM pharmacy_counter_sale_void_requests request
     WHERE request.tenant_id = OLD.tenant_id
       AND request.counter_sale_id = OLD.id
       AND request.refund_id = OLD.void_refund_id
       AND request.status = 'CANCELLED_HANDOVER_CONFIRMED';
    IF NOT FOUND OR NEW.void_refund_id IS NOT NULL
       OR EXISTS (
         SELECT 1
           FROM pharmacy_counter_sale_allocations allocation
           JOIN pharmacy_counter_sale_lines line
             ON line.tenant_id = allocation.tenant_id
            AND line.id = allocation.counter_sale_line_id
          WHERE line.tenant_id = NEW.tenant_id
            AND line.counter_sale_id = NEW.id
            AND allocation.return_movement_id IS NOT NULL
       )
    THEN
      RAISE EXCEPTION 'counter-sale void can reopen only after explicit handover resolution without restock'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.status = 'VOIDED' THEN
    IF OLD.status <> 'VOID_PENDING_REFUND'
       OR NEW.void_refund_id IS NULL
       OR NEW.voided_at IS NULL OR NEW.voided_by IS NULL
       OR length(btrim(COALESCE(NEW.void_reason, ''))) = 0
    THEN
      RAISE EXCEPTION 'counter sale cannot become voided without complete terminal evidence'
        USING ERRCODE = '23514';
    END IF;
    SELECT request.* INTO request_row
      FROM pharmacy_counter_sale_void_requests request
     WHERE request.tenant_id = NEW.tenant_id
       AND request.counter_sale_id = NEW.id
       AND request.refund_id = NEW.void_refund_id
       AND request.status = 'COMPLETED';
    IF NOT FOUND
       OR NOT counter_sale_void_has_paid_evidence(request_row.id)
       OR NEW.voided_by IS DISTINCT FROM request_row.requested_by
       OR NEW.void_reason IS DISTINCT FROM request_row.reason
       OR NOT EXISTS (
         SELECT 1
           FROM pharmacy_counter_sale_allocations allocation
           JOIN pharmacy_counter_sale_lines line
             ON line.tenant_id = allocation.tenant_id
            AND line.id = allocation.counter_sale_line_id
          WHERE line.tenant_id = NEW.tenant_id
            AND line.counter_sale_id = NEW.id
       )
       OR EXISTS (
         SELECT 1
           FROM pharmacy_counter_sale_allocations allocation
           JOIN pharmacy_counter_sale_lines line
             ON line.tenant_id = allocation.tenant_id
            AND line.id = allocation.counter_sale_line_id
          WHERE line.tenant_id = NEW.tenant_id
            AND line.counter_sale_id = NEW.id
            AND (
              allocation.return_movement_id IS NULL
              OR NOT EXISTS (
                SELECT 1
                  FROM pharmacy_stock_movements movement
                 WHERE movement.tenant_id = allocation.tenant_id
                   AND movement.id = allocation.return_movement_id
                   AND movement.inventory_item_id = line.inventory_item_id
                   AND movement.inventory_batch_id = allocation.inventory_batch_id
                   AND movement.movement_kind = 'return'
                   AND movement.quantity_delta = allocation.quantity
                   AND movement.reference_type = 'pharmacy_counter_sale_void'
                   AND movement.reference_id = NEW.id::text
              )
              OR (
                (line.schedule_class IN ('H', 'H1', 'X') OR line.is_narcotic)
                AND NOT EXISTS (
                  SELECT 1
                    FROM pharmacy_schedule_register register
                   WHERE register.tenant_id = allocation.tenant_id
                     AND register.inventory_item_id = line.inventory_item_id
                     AND register.inventory_batch_id = allocation.inventory_batch_id
                     AND register.movement_kind = 'return'
                     AND register.quantity = allocation.quantity
                     AND register.reference_movement_id = allocation.return_movement_id
                )
              )
            )
       )
    THEN
      RAISE EXCEPTION 'voided counter sale lacks exact paid refund evidence'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END
$fn$;

CREATE TRIGGER counter_sale_void_sale_guard
  BEFORE UPDATE ON pharmacy_counter_sales
  FOR EACH ROW EXECUTE FUNCTION counter_sale_void_sale_guard();

CREATE OR REPLACE FUNCTION counter_sale_void_request_terminal_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  current_request pharmacy_counter_sale_void_requests%ROWTYPE;
BEGIN
  SELECT request.* INTO current_request
    FROM pharmacy_counter_sale_void_requests request
   WHERE request.tenant_id = NEW.tenant_id
     AND request.id = NEW.id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF current_request.status = 'CREATING' THEN
    RAISE EXCEPTION 'counter-sale void request cannot commit before refund binding'
      USING ERRCODE = '23514';
  END IF;

  IF current_request.status IN ('PENDING_REFUND', 'REFUND_REJECTED_REVIEW')
     AND (
       current_request.task_id IS NULL
       OR current_request.workflow_sla_instance_id IS NULL
       OR NOT EXISTS (
         SELECT 1
           FROM pharmacy_counter_sales sale
           JOIN tasks task
             ON task.tenant_id = current_request.tenant_id
            AND task.id = current_request.task_id
           JOIN workflow_sla_instances sla
             ON sla.tenant_id = current_request.tenant_id
            AND sla.id = current_request.workflow_sla_instance_id
          WHERE sale.tenant_id = current_request.tenant_id
            AND sale.id = current_request.counter_sale_id
            AND sale.status = 'VOID_PENDING_REFUND'
            AND sale.void_refund_id = current_request.refund_id
            AND task.workflow_sla_instance_id = sla.id
            AND task.status IN ('open', 'in_progress', 'blocked', 'overdue')
            AND sla.completed_at IS NULL
            AND sla.status IN ('active', 'breached', 'escalated')
       )
     )
  THEN
    RAISE EXCEPTION 'pending counter-sale void request is not active on its sale'
      USING ERRCODE = '23514';
  END IF;

  IF current_request.status = 'REFUND_REJECTED_REVIEW'
     AND NOT EXISTS (
       SELECT 1
         FROM billing_refunds refund
        WHERE refund.tenant_id = current_request.tenant_id
          AND refund.id = current_request.refund_id
          AND refund.counter_sale_void_request_id = current_request.id
          AND refund.approval_status = 'REJECTED'
     )
  THEN
    RAISE EXCEPTION 'rejected counter-sale void review lacks exact rejected refund'
      USING ERRCODE = '23514';
  END IF;

  IF current_request.status = 'CANCELLED_HANDOVER_CONFIRMED' AND NOT EXISTS (
    SELECT 1
      FROM pharmacy_counter_sales sale
      JOIN tasks task
        ON task.tenant_id = current_request.tenant_id
       AND task.id = current_request.task_id
      JOIN workflow_sla_instances sla
        ON sla.tenant_id = current_request.tenant_id
       AND sla.id = current_request.workflow_sla_instance_id
     WHERE sale.tenant_id = current_request.tenant_id
       AND sale.id = current_request.counter_sale_id
       AND sale.status = 'COMPLETED'
       AND sale.void_refund_id IS NULL
       AND task.status = 'completed'
       AND task.completed_at IS NOT NULL
       AND sla.completed_at = task.completed_at
       AND sla.metadata->'completion_evidence'->>'kind' = 'counter_sale_void_handover_confirmed'
       AND sla.metadata->'completion_evidence'->>'resource_id' = current_request.id::text
  ) THEN
    RAISE EXCEPTION 'handover-confirmed cancellation lacks closed task, SLA, and sale evidence'
      USING ERRCODE = '23514';
  END IF;

  IF current_request.status = 'COMPLETED' AND (
    NOT counter_sale_void_has_paid_evidence(current_request.id)
    OR NOT EXISTS (
      SELECT 1
        FROM pharmacy_counter_sales sale
       WHERE sale.tenant_id = current_request.tenant_id
         AND sale.id = current_request.counter_sale_id
         AND sale.status = 'VOIDED'
         AND sale.void_refund_id = current_request.refund_id
    )
    OR NOT EXISTS (
      SELECT 1
        FROM tasks task
        JOIN workflow_sla_instances sla
          ON sla.tenant_id = task.tenant_id
         AND sla.id = task.workflow_sla_instance_id
       WHERE task.tenant_id = current_request.tenant_id
         AND task.id = current_request.task_id
         AND task.status = 'completed'
         AND task.completed_at IS NOT NULL
         AND sla.id = current_request.workflow_sla_instance_id
         AND sla.completed_at = task.completed_at
         AND sla.metadata->'completion_evidence'->>'kind' = 'counter_sale_void_completed'
         AND sla.metadata->'completion_evidence'->>'resource_id' = current_request.id::text
    )
  ) THEN
    RAISE EXCEPTION 'completed counter-sale void request lacks terminal sale/refund evidence'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END
$fn$;

CREATE CONSTRAINT TRIGGER counter_sale_void_request_terminal_evidence
  AFTER INSERT OR UPDATE OF status ON pharmacy_counter_sale_void_requests
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION counter_sale_void_request_terminal_evidence();

CREATE OR REPLACE FUNCTION counter_sale_void_task_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  sla_record workflow_sla_instances%ROWTYPE;
  request_record pharmacy_counter_sale_void_requests%ROWTYPE;
  sale_patient_uid UUID;
  metadata_value JSONB := COALESCE(NEW.metadata, '{}'::jsonb);
  expected_role TEXT;
BEGIN
  IF jsonb_typeof(metadata_value) IS DISTINCT FROM 'object'
     OR metadata_value->>'task_contract' IS DISTINCT FROM 'counter_sale_void_refund_v1'
     OR NEW.related_resource_type IS DISTINCT FROM 'pharmacy_counter_sale_void_requests'
     OR NEW.related_resource_id !~ '^[1-9][0-9]*$'
     OR NEW.workflow_sla_instance_id IS NULL
     OR NEW.sla_completion_semantics IS DISTINCT FROM 'domain_evidence'
     OR NEW.encounter_id IS NOT NULL
  THEN
    RAISE EXCEPTION 'counter-sale void task contract is invalid'
      USING ERRCODE = '23514';
  END IF;

  SELECT request.*
    INTO request_record
    FROM pharmacy_counter_sale_void_requests request
   WHERE request.tenant_id = NEW.tenant_id
     AND request.id = NEW.related_resource_id::bigint;
  SELECT sale.patient_uid
    INTO sale_patient_uid
    FROM pharmacy_counter_sales sale
   WHERE sale.tenant_id = request_record.tenant_id
     AND sale.id = request_record.counter_sale_id;
  IF NOT FOUND
     OR metadata_value->>'counter_sale_void_request_id' IS DISTINCT FROM request_record.id::text
     OR metadata_value->>'refund_id' IS DISTINCT FROM request_record.refund_id::text
     OR NEW.patient_uid IS DISTINCT FROM sale_patient_uid
  THEN
    RAISE EXCEPTION 'counter-sale void task does not match its exact request'
      USING ERRCODE = '23514';
  END IF;

  SELECT sla.* INTO sla_record
    FROM workflow_sla_instances sla
   WHERE sla.tenant_id = NEW.tenant_id
     AND sla.id = NEW.workflow_sla_instance_id
   FOR KEY SHARE;
  IF NOT FOUND
     OR sla_record.rule_code <> 'counter_sale_void_refund'
     OR sla_record.source_table IS DISTINCT FROM NEW.related_resource_type
     OR sla_record.source_id IS DISTINCT FROM NEW.related_resource_id
     OR sla_record.patient_uid IS DISTINCT FROM NEW.patient_uid
     OR sla_record.due_at IS NULL
  THEN
    RAISE EXCEPTION 'counter-sale void task and SLA source are not exact'
      USING ERRCODE = '23514';
  END IF;

  expected_role := CASE request_record.task_stage
    WHEN 'approval' THEN 'ADMIN'
    WHEN 'payout' THEN 'BILLING_INCHARGE'
    WHEN 'reconciliation' THEN 'PHARMACY_INCHARGE'
    WHEN 'rejected_review' THEN 'ADMIN'
    ELSE NEW.assigned_to_role
  END;

  IF NEW.status IN ('open', 'in_progress', 'blocked', 'overdue') AND (
    request_record.status NOT IN ('PENDING_REFUND', 'REFUND_REJECTED_REVIEW')
    OR sla_record.completed_at IS NOT NULL
    OR sla_record.status NOT IN ('active', 'breached', 'escalated')
    OR NEW.assigned_to_uid IS NOT NULL
    OR NEW.assigned_to_role IS DISTINCT FROM expected_role
  ) THEN
    RAISE EXCEPTION 'actionable counter-sale void task lacks exact stage ownership'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'completed' AND (
    request_record.status NOT IN ('COMPLETED', 'CANCELLED_HANDOVER_CONFIRMED')
    OR NEW.completed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'counter-sale void task completion lacks domain evidence'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'cancelled' THEN
    RAISE EXCEPTION 'counter-sale void task cannot be cancelled'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.workflow_sla_instance_id IS NOT NULL
     AND NEW.workflow_sla_instance_id IS DISTINCT FROM OLD.workflow_sla_instance_id
  THEN
    RAISE EXCEPTION 'counter-sale void task SLA binding is immutable'
      USING ERRCODE = '23514';
  END IF;

  NEW.due_at := sla_record.due_at;
  NEW.metadata := metadata_value || jsonb_build_object(
    'sla_instance_id', sla_record.id::text,
    'sla_key', sla_record.rule_code,
    'task_stage', request_record.task_stage
  );
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_tasks_workflow_sla_compat_insert ON tasks;
CREATE TRIGGER trg_tasks_workflow_sla_compat_insert
  BEFORE INSERT ON tasks
  FOR EACH ROW
  WHEN (COALESCE(NEW.metadata->>'task_contract', '') NOT IN (
    'ward_medication_obligation_v1',
    'mar_medication_exception_v1',
    'clinical_alert_delivery_recovery_v1',
    'counter_sale_void_refund_v1'
  ))
  EXECUTE FUNCTION tasks_sync_workflow_sla_compat();

DROP TRIGGER IF EXISTS trg_tasks_workflow_sla_compat_update ON tasks;
CREATE TRIGGER trg_tasks_workflow_sla_compat_update
  BEFORE UPDATE OF
    tenant_id, status, workflow_step_id, related_resource_type,
    related_resource_id, workflow_sla_instance_id, sla_completion_semantics,
    due_at, metadata
  ON tasks
  FOR EACH ROW
  WHEN (COALESCE(NEW.metadata->>'task_contract', '') NOT IN (
    'ward_medication_obligation_v1',
    'mar_medication_exception_v1',
    'clinical_alert_delivery_recovery_v1',
    'counter_sale_void_refund_v1'
  ))
  EXECUTE FUNCTION tasks_sync_workflow_sla_compat();

CREATE TRIGGER trg_tasks_workflow_sla_compat_counter_sale_void_insert
  BEFORE INSERT ON tasks
  FOR EACH ROW
  WHEN (NEW.metadata->>'task_contract' = 'counter_sale_void_refund_v1')
  EXECUTE FUNCTION counter_sale_void_task_sync();

CREATE TRIGGER trg_tasks_workflow_sla_compat_counter_sale_void_update
  BEFORE UPDATE OF
    tenant_id, status, workflow_step_id, encounter_id, related_resource_type,
    related_resource_id, workflow_sla_instance_id, sla_completion_semantics,
    due_at, metadata, assigned_to_uid, assigned_to_role
  ON tasks
  FOR EACH ROW
  WHEN (NEW.metadata->>'task_contract' = 'counter_sale_void_refund_v1')
  EXECUTE FUNCTION counter_sale_void_task_sync();

ALTER FUNCTION public.care_pathway_assert_task_sla_source_binding(UUID, INTEGER)
  RENAME TO care_pathway_assert_task_sla_source_binding_pre_746;

CREATE OR REPLACE FUNCTION public.care_pathway_assert_task_sla_source_binding(
  target_tenant_id UUID,
  target_task_id INTEGER
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  task_record tasks%ROWTYPE;
  sla_record workflow_sla_instances%ROWTYPE;
  request_record pharmacy_counter_sale_void_requests%ROWTYPE;
  sale_patient_uid UUID;
BEGIN
  SELECT task.*
    INTO task_record
    FROM tasks task
   WHERE task.tenant_id = target_tenant_id
     AND task.id = target_task_id;

  IF NOT FOUND
     OR task_record.metadata->>'task_contract'
          IS DISTINCT FROM 'counter_sale_void_refund_v1'
  THEN
    PERFORM public.care_pathway_assert_task_sla_source_binding_pre_746(
      target_tenant_id,
      target_task_id
    );
    RETURN;
  END IF;

  SELECT sla.*
    INTO sla_record
    FROM workflow_sla_instances sla
   WHERE sla.tenant_id = task_record.tenant_id
     AND sla.id = task_record.workflow_sla_instance_id;
  SELECT request.*
    INTO request_record
    FROM pharmacy_counter_sale_void_requests request
   WHERE request.tenant_id = task_record.tenant_id
     AND request.id::text = task_record.related_resource_id;
  SELECT sale.patient_uid
    INTO sale_patient_uid
    FROM pharmacy_counter_sales sale
   WHERE sale.tenant_id = request_record.tenant_id
     AND sale.id = request_record.counter_sale_id;

  IF sla_record.id IS NULL
     OR request_record.id IS NULL
     OR task_record.task_kind IS DISTINCT FROM 'review'
     OR task_record.related_resource_type
          IS DISTINCT FROM 'pharmacy_counter_sale_void_requests'
     OR task_record.sla_completion_semantics IS DISTINCT FROM 'domain_evidence'
     OR task_record.encounter_id IS NOT NULL
     OR task_record.patient_uid IS DISTINCT FROM sale_patient_uid
     OR task_record.created_by IS DISTINCT FROM request_record.requested_by
     OR request_record.task_id IS DISTINCT FROM task_record.id
     OR request_record.workflow_sla_instance_id IS DISTINCT FROM sla_record.id
     OR sla_record.rule_code IS DISTINCT FROM 'counter_sale_void_refund'
     OR sla_record.source_table IS DISTINCT FROM task_record.related_resource_type
     OR sla_record.source_id IS DISTINCT FROM task_record.related_resource_id
     OR sla_record.patient_uid IS DISTINCT FROM task_record.patient_uid
     OR task_record.due_at IS DISTINCT FROM sla_record.due_at
     OR task_record.metadata->>'counter_sale_void_request_id'
          IS DISTINCT FROM request_record.id::text
     OR task_record.metadata->>'counter_sale_id'
          IS DISTINCT FROM request_record.counter_sale_id::text
     OR task_record.metadata->>'refund_id'
          IS DISTINCT FROM request_record.refund_id::text
     OR task_record.metadata->>'invoice_id'
          IS DISTINCT FROM request_record.invoice_id::text
     OR task_record.metadata->>'sla_instance_id'
          IS DISTINCT FROM sla_record.id::text
     OR task_record.metadata->>'sla_key'
          IS DISTINCT FROM sla_record.rule_code
     OR task_record.metadata->>'task_stage'
          IS DISTINCT FROM request_record.task_stage
  THEN
    RAISE EXCEPTION 'counter-sale void task and linked SLA do not describe the same obligation'
      USING ERRCODE = '23514';
  END IF;
END
$fn$;

ALTER FUNCTION public.care_pathway_assert_task_sla_completion_receipt(UUID, INTEGER)
  RENAME TO care_pathway_assert_task_sla_completion_receipt_pre_746;

CREATE OR REPLACE FUNCTION public.care_pathway_assert_task_sla_completion_receipt(
  target_tenant_id UUID,
  target_task_id INTEGER
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  task_record tasks%ROWTYPE;
  sla_record workflow_sla_instances%ROWTYPE;
  request_record pharmacy_counter_sale_void_requests%ROWTYPE;
  task_evidence JSONB;
  sla_evidence JSONB;
  expected_evidence_kind TEXT;
  expected_actor_uid UUID;
  expected_task_stage TEXT;
BEGIN
  SELECT task.*
    INTO task_record
    FROM tasks task
   WHERE task.tenant_id = target_tenant_id
     AND task.id = target_task_id;

  IF NOT FOUND
     OR task_record.metadata->>'task_contract'
          IS DISTINCT FROM 'counter_sale_void_refund_v1'
  THEN
    PERFORM public.care_pathway_assert_task_sla_completion_receipt_pre_746(
      target_tenant_id,
      target_task_id
    );
    RETURN;
  END IF;

  SELECT sla.*
    INTO sla_record
    FROM workflow_sla_instances sla
   WHERE sla.tenant_id = task_record.tenant_id
     AND sla.id = task_record.workflow_sla_instance_id;
  SELECT request.*
    INTO request_record
    FROM pharmacy_counter_sale_void_requests request
   WHERE request.tenant_id = task_record.tenant_id
     AND request.id::text = task_record.related_resource_id
     AND request.task_id = task_record.id
     AND request.workflow_sla_instance_id = task_record.workflow_sla_instance_id;

  IF sla_record.id IS NULL
     OR request_record.id IS NULL
     OR task_record.sla_completion_semantics IS DISTINCT FROM 'domain_evidence'
     OR task_record.due_at IS DISTINCT FROM sla_record.due_at
     OR sla_record.rule_code IS DISTINCT FROM 'counter_sale_void_refund'
     OR sla_record.source_table
          IS DISTINCT FROM 'pharmacy_counter_sale_void_requests'
     OR sla_record.source_id IS DISTINCT FROM task_record.related_resource_id
  THEN
    RAISE EXCEPTION 'counter-sale void task has no exact SLA receipt contract'
      USING ERRCODE = '23514';
  END IF;

  IF task_record.status IN ('open', 'in_progress', 'blocked', 'overdue') THEN
    IF request_record.status NOT IN ('PENDING_REFUND', 'REFUND_REJECTED_REVIEW')
       OR sla_record.completed_at IS NOT NULL
       OR sla_record.status NOT IN ('active', 'breached', 'escalated')
       OR task_record.completed_at IS NOT NULL
       OR COALESCE(sla_record.metadata, '{}'::jsonb) ?| ARRAY[
            'completed_via',
            'completed_by_task',
            'completed_by',
            'completion_evidence'
          ]
       OR COALESCE(task_record.metadata, '{}'::jsonb) ?| ARRAY[
            'completion_via',
            'completion_evidence'
          ]
    THEN
      RAISE EXCEPTION 'actionable counter-sale void task requires a clean open SLA receipt'
        USING ERRCODE = '23514';
    END IF;
    RETURN;
  END IF;

  expected_evidence_kind := CASE request_record.status
    WHEN 'COMPLETED' THEN 'counter_sale_void_completed'
    WHEN 'CANCELLED_HANDOVER_CONFIRMED' THEN 'counter_sale_void_handover_confirmed'
    ELSE NULL
  END;
  expected_actor_uid := CASE request_record.status
    WHEN 'COMPLETED' THEN COALESCE(
      request_record.reconciled_by,
      request_record.requested_by
    )
    WHEN 'CANCELLED_HANDOVER_CONFIRMED' THEN request_record.rejection_resolved_by
    ELSE NULL
  END;
  expected_task_stage := CASE request_record.status
    WHEN 'COMPLETED' THEN 'completed'
    WHEN 'CANCELLED_HANDOVER_CONFIRMED' THEN 'cancelled'
    ELSE NULL
  END;
  task_evidence := task_record.metadata->'completion_evidence';
  sla_evidence := sla_record.metadata->'completion_evidence';

  IF expected_evidence_kind IS NULL
     OR expected_actor_uid IS NULL
     OR task_record.status IS DISTINCT FROM 'completed'
     OR task_record.completed_at IS NULL
     OR sla_record.completed_at IS DISTINCT FROM task_record.completed_at
     OR sla_record.status NOT IN ('completed', 'breached', 'escalated')
     OR task_record.metadata->>'task_stage' IS DISTINCT FROM expected_task_stage
     OR task_record.metadata->>'completion_via' IS DISTINCT FROM 'domain_evidence'
     OR sla_record.metadata->>'completed_via' IS DISTINCT FROM 'domain_evidence'
     OR sla_record.metadata->>'completed_by_task' IS DISTINCT FROM task_record.id::text
     OR sla_record.metadata->>'completed_by' IS DISTINCT FROM expected_actor_uid::text
     OR jsonb_typeof(task_evidence) IS DISTINCT FROM 'object'
     OR jsonb_typeof(sla_evidence) IS DISTINCT FROM 'object'
     OR task_evidence->>'kind' IS DISTINCT FROM expected_evidence_kind
     OR sla_evidence->>'kind' IS DISTINCT FROM expected_evidence_kind
     OR task_evidence->>'resource_type'
          IS DISTINCT FROM 'pharmacy_counter_sale_void_requests'
     OR sla_evidence->>'resource_type'
          IS DISTINCT FROM 'pharmacy_counter_sale_void_requests'
     OR task_evidence->>'resource_id' IS DISTINCT FROM request_record.id::text
     OR sla_evidence->>'resource_id' IS DISTINCT FROM request_record.id::text
     OR task_evidence->>'recorded_at' IS NULL
     OR NOT pg_input_is_valid(task_evidence->>'recorded_at', 'timestamp with time zone')
     OR (task_evidence->>'recorded_at')::timestamptz
          IS DISTINCT FROM task_record.completed_at
     OR sla_evidence->>'occurred_at' IS NULL
     OR NOT pg_input_is_valid(sla_evidence->>'occurred_at', 'timestamp with time zone')
     OR (sla_evidence->>'occurred_at')::timestamptz
          IS DISTINCT FROM sla_record.completed_at
     OR sla_evidence->>'recorded_at' IS NULL
     OR NOT pg_input_is_valid(sla_evidence->>'recorded_at', 'timestamp with time zone')
     OR (sla_evidence->>'recorded_at')::timestamptz
          IS DISTINCT FROM sla_record.completed_at
  THEN
    RAISE EXCEPTION 'terminal counter-sale void task lacks its exact domain receipt'
      USING ERRCODE = '23514';
  END IF;
END
$fn$;

CREATE OR REPLACE FUNCTION counter_sale_void_task_binding_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pharmacy_counter_sale_void_requests request
      JOIN tasks task
        ON task.tenant_id = request.tenant_id
       AND task.id = request.task_id
      JOIN workflow_sla_instances sla
        ON sla.tenant_id = request.tenant_id
       AND sla.id = request.workflow_sla_instance_id
     WHERE request.tenant_id = NEW.tenant_id
       AND request.id::text = NEW.related_resource_id
       AND request.task_id = NEW.id
       AND task.workflow_sla_instance_id = sla.id
       AND task.metadata->>'task_contract' = 'counter_sale_void_refund_v1'
       AND sla.rule_code = 'counter_sale_void_refund'
  ) THEN
    RAISE EXCEPTION 'counter-sale void task lacks exact request and SLA binding'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$fn$;

CREATE CONSTRAINT TRIGGER counter_sale_void_task_binding_evidence
  AFTER INSERT OR UPDATE ON tasks
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.metadata->>'task_contract' = 'counter_sale_void_refund_v1')
  EXECUTE FUNCTION counter_sale_void_task_binding_evidence();

INSERT INTO workflow_sla_rules
  (tenant_id, rule_code, title, trigger_event_type, target_minutes, severity,
   owner_role_codes, escalation_role_codes, metadata)
VALUES
  (NULL, 'counter_sale_void_refund',
   'Counter-sale void refund closure', 'pharmacy.counter_sale.void_requested',
   30, 'high',
   ARRAY['ADMIN', 'SUPER_ADMIN', 'BILLING_INCHARGE', 'FINANCE_INCHARGE']::TEXT[],
   ARRAY['FINANCE_INCHARGE', 'ADMIN', 'SUPER_ADMIN']::TEXT[],
   '{"med_03":true,"surface":"counter_sale_void"}'::jsonb)
ON CONFLICT (
  (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)),
  rule_code
)
DO UPDATE SET
  title = EXCLUDED.title,
  trigger_event_type = EXCLUDED.trigger_event_type,
  target_minutes = EXCLUDED.target_minutes,
  severity = EXCLUDED.severity,
  owner_role_codes = EXCLUDED.owner_role_codes,
  escalation_role_codes = EXCLUDED.escalation_role_codes,
  metadata = EXCLUDED.metadata,
  updated_at = NOW();

ALTER TABLE pharmacy_counter_sale_void_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_counter_sale_void_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pharmacy_counter_sale_void_requests
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
CREATE POLICY explicit_tenant_context ON pharmacy_counter_sale_void_requests
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

DO $counter_sale_void_runtime_privileges$
DECLARE
  runtime_role TEXT;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['vhhealth_app', 'vhhealth_runtime']::TEXT[]
  LOOP
    IF pg_catalog.to_regrole(runtime_role) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE public.pharmacy_counter_sale_void_requests FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT SELECT ON TABLE public.pharmacy_counter_sale_void_requests TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT INSERT (tenant_id, counter_sale_id, invoice_id, patient_uid, amount, refund_mode, disposition, reason, requested_by, requested_by_name, requested_by_role, command_key, request_fingerprint, status, task_stage) ON TABLE public.pharmacy_counter_sale_void_requests TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT UPDATE (refund_id, status, task_stage, task_id, workflow_sla_instance_id, last_checked_at, reconciled_at, reconciled_by, reconciliation_source, rejection_resolved_at, rejection_resolved_by, rejection_resolution, rejection_resolution_reason, updated_at) ON TABLE public.pharmacy_counter_sale_void_requests TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON SEQUENCE public.pharmacy_counter_sale_void_requests_id_seq FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT USAGE, SELECT ON SEQUENCE public.pharmacy_counter_sale_void_requests_id_seq TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.counter_sale_void_request_guard() FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.counter_sale_void_refund_guard() FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.counter_sale_void_sale_guard() FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.counter_sale_void_stock_return_guard() FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.counter_sale_void_allocation_return_guard() FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.counter_sale_void_request_terminal_evidence() FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.counter_sale_void_task_sync() FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.counter_sale_void_task_binding_evidence() FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.counter_sale_void_has_paid_evidence(BIGINT) FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION public.counter_sale_void_has_paid_evidence(BIGINT) TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.care_pathway_assert_task_sla_source_binding(UUID, INTEGER) FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION public.care_pathway_assert_task_sla_source_binding(UUID, INTEGER) TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.care_pathway_assert_task_sla_source_binding_pre_746(UUID, INTEGER) FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION public.care_pathway_assert_task_sla_source_binding_pre_746(UUID, INTEGER) TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.care_pathway_assert_task_sla_completion_receipt(UUID, INTEGER) FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION public.care_pathway_assert_task_sla_completion_receipt(UUID, INTEGER) TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.care_pathway_assert_task_sla_completion_receipt_pre_746(UUID, INTEGER) FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION public.care_pathway_assert_task_sla_completion_receipt_pre_746(UUID, INTEGER) TO %I',
      runtime_role
    );
  END LOOP;
END
$counter_sale_void_runtime_privileges$;

REVOKE ALL PRIVILEGES ON FUNCTION counter_sale_void_request_guard() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION counter_sale_void_refund_guard() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION counter_sale_void_sale_guard() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION counter_sale_void_stock_return_guard() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION counter_sale_void_allocation_return_guard() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION counter_sale_void_request_terminal_evidence() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION counter_sale_void_task_sync() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION counter_sale_void_task_binding_evidence() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION counter_sale_void_has_paid_evidence(BIGINT) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION care_pathway_assert_task_sla_source_binding(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION care_pathway_assert_task_sla_source_binding_pre_746(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION care_pathway_assert_task_sla_completion_receipt(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION care_pathway_assert_task_sla_completion_receipt_pre_746(UUID, INTEGER) FROM PUBLIC;

COMMENT ON TABLE pharmacy_counter_sale_void_requests IS
  'Tenant-bound same-day counter-sale void obligation. Pharmacy creates one dedicated PENDING billing refund; only the existing billing approval/payout or gateway workflow can make it PAID, after which reconciliation atomically restocks exact allocations and closes the sale.';
COMMENT ON COLUMN billing_refunds.counter_sale_void_request_id IS
  'Immutable exact counter-sale void obligation this dedicated refund serves. Identity, amount, patient, invoice, mode, independent approval, and payout evidence are trigger-enforced.';
COMMENT ON COLUMN pharmacy_counter_sales.status IS
  'IN_PROGRESS -> COMPLETED | FAILED. COMPLETED -> VOID_PENDING_REFUND after a same-day pharmacy request creates one dedicated pending billing refund; only exact paid-refund reconciliation may transition to VOIDED.';

COMMIT;
