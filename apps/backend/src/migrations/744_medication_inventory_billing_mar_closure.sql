-- Migration 744: MED-03 medication inventory, billing, MAR, and notification closure.
--
-- This migration does not activate notification delivery, deploy production
-- code, or authorize controlled-drug, credit-payout, or clinical-override
-- operations. It adds the tenant-bound evidence rails those separately
-- authorized workflows require.

BEGIN;

-- ---------------------------------------------------------------------------
-- Direct clinical-order identity on MAR
-- ---------------------------------------------------------------------------

ALTER TABLE medication_administrations
  ADD COLUMN clinical_order_id INTEGER,
  ADD COLUMN supply_quantity_per_dose NUMERIC(14, 4),
  ADD COLUMN held_by UUID,
  ADD COLUMN held_at TIMESTAMPTZ,
  ADD COLUMN missed_by UUID,
  ADD COLUMN missed_at TIMESTAMPTZ;

-- Older hold writes used administered_by for the holding nurse. Preserve that
-- attribution only when it still resolves to an active tenant identity, then
-- clear administered_by so it once again means "the nurse who gave the dose".
UPDATE medication_administrations administration
   SET held_by = administration.administered_by,
       held_at = COALESCE(administration.updated_at, administration.created_at, NOW())
 WHERE LOWER(administration.status) = 'held'
   AND administration.administered_by IS NOT NULL
   AND EXISTS (
     SELECT 1
       FROM users actor
      WHERE actor.tenant_id = administration.tenant_id
        AND actor.uid = administration.administered_by
   );

UPDATE medication_administrations
   SET administered_by = NULL,
       held_at = COALESCE(held_at, updated_at, created_at, NOW())
 WHERE LOWER(status) = 'held';

UPDATE medication_administrations
   SET missed_at = COALESCE(updated_at, created_at, NOW())
 WHERE LOWER(status) = 'missed';

WITH order_markers AS (
  SELECT administration.id,
         administration.tenant_id,
         ARRAY_AGG(DISTINCT marker.capture[1]::INTEGER) AS order_ids
    FROM medication_administrations administration
    CROSS JOIN LATERAL REGEXP_MATCHES(
      COALESCE(administration.notes, ''),
      'clinical_order_id:([0-9]+)',
      'g'
    ) AS marker(capture)
   GROUP BY administration.id, administration.tenant_id
), unambiguous_markers AS (
  SELECT id, tenant_id, order_ids[1] AS clinical_order_id
    FROM order_markers
   WHERE CARDINALITY(order_ids) = 1
)
UPDATE medication_administrations administration
   SET clinical_order_id = marker.clinical_order_id
  FROM unambiguous_markers marker
  JOIN clinical_orders clinical_order
    ON clinical_order.tenant_id = marker.tenant_id
   AND clinical_order.id = marker.clinical_order_id
   AND clinical_order.order_type = 'medication'
 WHERE administration.id = marker.id
   AND administration.tenant_id = marker.tenant_id
   AND administration.patient_uid = clinical_order.patient_uid
   AND administration.clinical_order_id IS NULL;

CREATE UNIQUE INDEX ux_medication_administrations_tenant_id_med03
  ON medication_administrations (tenant_id, id);
CREATE UNIQUE INDEX ux_medication_administrations_order_identity_med03
  ON medication_administrations (tenant_id, id, clinical_order_id);
CREATE INDEX idx_medication_administrations_clinical_order
  ON medication_administrations (tenant_id, clinical_order_id, scheduled_time)
  WHERE clinical_order_id IS NOT NULL;
CREATE INDEX idx_medication_administrations_order_status
  ON medication_administrations (tenant_id, clinical_order_id, status, scheduled_time)
  WHERE clinical_order_id IS NOT NULL;
CREATE INDEX idx_medication_administrations_held_actor
  ON medication_administrations (tenant_id, held_by, held_at DESC)
  WHERE held_by IS NOT NULL;
CREATE INDEX idx_medication_administrations_missed_actor
  ON medication_administrations (tenant_id, missed_by, missed_at DESC)
  WHERE missed_by IS NOT NULL;

ALTER TABLE medication_administrations
  ADD CONSTRAINT fk_medication_administrations_clinical_order_tenant_med03
    FOREIGN KEY (tenant_id, clinical_order_id)
    REFERENCES clinical_orders (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  ADD CONSTRAINT medication_administrations_supply_quantity_check
    CHECK (supply_quantity_per_dose IS NULL OR supply_quantity_per_dose > 0),
  ADD CONSTRAINT medication_administrations_hold_attribution_check
    CHECK (held_by IS NULL OR held_at IS NOT NULL),
  ADD CONSTRAINT medication_administrations_missed_attribution_check
    CHECK (missed_by IS NULL OR missed_at IS NOT NULL),
  ADD CONSTRAINT fk_medication_administrations_held_actor_med03
    FOREIGN KEY (tenant_id, held_by)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  ADD CONSTRAINT fk_medication_administrations_missed_actor_med03
    FOREIGN KEY (tenant_id, missed_by)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE;

CREATE OR REPLACE FUNCTION medication_administration_require_order_context()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
DECLARE
  order_patient_uid UUID;
BEGIN
  IF NEW.clinical_order_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT clinical_order.patient_uid
    INTO order_patient_uid
    FROM clinical_orders clinical_order
   WHERE clinical_order.tenant_id = NEW.tenant_id
     AND clinical_order.id = NEW.clinical_order_id
     AND clinical_order.order_type = 'medication';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MAR clinical order is missing from the same tenant or is not medication'
      USING ERRCODE = '23503';
  END IF;
  IF NEW.patient_uid IS DISTINCT FROM order_patient_uid THEN
    RAISE EXCEPTION 'MAR clinical order must match the administration patient'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS medication_administration_order_context
  ON medication_administrations;
CREATE TRIGGER medication_administration_order_context
  BEFORE INSERT OR UPDATE OF tenant_id, patient_uid, clinical_order_id
  ON medication_administrations
  FOR EACH ROW EXECUTE FUNCTION medication_administration_require_order_context();

-- ---------------------------------------------------------------------------
-- Substitution acknowledgement and reusable tenant-composite parent keys
-- ---------------------------------------------------------------------------

ALTER TABLE ward_indent_items
  ADD COLUMN substitution_acknowledged_by UUID,
  ADD COLUMN substitution_acknowledged_at TIMESTAMPTZ,
  ADD COLUMN substitution_acknowledged_event_version INTEGER;

ALTER TABLE ward_indent_items
  ADD CONSTRAINT ward_indent_items_substitution_ack_evidence_check CHECK (
    (
      substitution_acknowledged_by IS NULL
      AND substitution_acknowledged_at IS NULL
      AND substitution_acknowledged_event_version IS NULL
    )
    OR
    (
      substitution_status = 'approved'
      AND substitution_acknowledged_by IS NOT NULL
      AND substitution_acknowledged_at IS NOT NULL
      AND substitution_acknowledged_event_version > 0
    )
  ),
  ADD CONSTRAINT fk_ward_indent_items_substitution_ack_actor_med03
    FOREIGN KEY (tenant_id, substitution_acknowledged_by)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE;

CREATE UNIQUE INDEX ux_ward_indent_items_tenant_indent_id_med03
  ON ward_indent_items (tenant_id, id, ward_indent_id);
CREATE UNIQUE INDEX ux_ward_indent_items_tenant_id_med03
  ON ward_indent_items (tenant_id, id);
CREATE UNIQUE INDEX ux_pharmacy_inventory_batches_tenant_item_id_med03
  ON pharmacy_inventory_batches (tenant_id, id, inventory_item_id);
CREATE UNIQUE INDEX ux_billing_invoices_tenant_id_med03
  ON billing_invoices (tenant_id, id);
CREATE UNIQUE INDEX ux_billing_invoice_items_tenant_id_med03
  ON billing_invoice_items (tenant_id, id);
CREATE UNIQUE INDEX ux_billing_refunds_tenant_id_med03
  ON billing_refunds (tenant_id, id);
CREATE UNIQUE INDEX ux_ward_indent_events_tenant_identity_med03
  ON ward_indent_events (tenant_id, id, ward_indent_id, state_version);

-- ---------------------------------------------------------------------------
-- Exact ward reservation and movement lineage
-- ---------------------------------------------------------------------------

CREATE TABLE ward_indent_inventory_allocations (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  ward_indent_id INTEGER NOT NULL,
  ward_indent_item_id INTEGER NOT NULL,
  inventory_item_id INTEGER NOT NULL,
  inventory_batch_id INTEGER NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'reserved',
  reserved_quantity NUMERIC(14, 4) NOT NULL,
  issued_quantity NUMERIC(14, 4) NOT NULL DEFAULT 0,
  received_quantity NUMERIC(14, 4) NOT NULL DEFAULT 0,
  consumed_quantity NUMERIC(14, 4) NOT NULL DEFAULT 0,
  returned_quantity NUMERIC(14, 4) NOT NULL DEFAULT 0,
  reservation_key VARCHAR(200) NOT NULL,
  reserved_by UUID NOT NULL,
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_by UUID,
  released_at TIMESTAMPTZ,
  release_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ward_indent_inventory_allocations_status_check CHECK (
    status IN ('reserved', 'partially_issued', 'issued', 'released', 'reconciled')
  ),
  CONSTRAINT ward_indent_inventory_allocations_quantity_check CHECK (
    reserved_quantity > 0
    AND issued_quantity >= 0
    AND received_quantity >= 0
    AND consumed_quantity >= 0
    AND returned_quantity >= 0
    AND issued_quantity <= reserved_quantity
    AND received_quantity <= issued_quantity
    AND consumed_quantity + returned_quantity <= received_quantity
  ),
  CONSTRAINT ward_indent_inventory_allocations_release_check CHECK (
    (
      status = 'released'
      AND issued_quantity = 0
      AND released_by IS NOT NULL
      AND released_at IS NOT NULL
      AND release_reason IS NOT NULL
      AND BTRIM(release_reason) <> ''
    )
    OR
    (
      status <> 'released'
      AND released_by IS NULL
      AND released_at IS NULL
      AND release_reason IS NULL
    )
  ),
  CONSTRAINT ward_indent_inventory_allocations_reservation_key_check
    CHECK (BTRIM(reservation_key) <> ''),
  CONSTRAINT fk_ward_indent_inventory_allocations_tenant
    FOREIGN KEY (tenant_id)
    REFERENCES tenants (id)
    ON DELETE NO ACTION,
  CONSTRAINT fk_ward_indent_inventory_allocations_indent_item
    FOREIGN KEY (tenant_id, ward_indent_item_id, ward_indent_id)
    REFERENCES ward_indent_items (tenant_id, id, ward_indent_id)
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_ward_indent_inventory_allocations_inventory_item
    FOREIGN KEY (tenant_id, inventory_item_id)
    REFERENCES pharmacy_inventory_items (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_ward_indent_inventory_allocations_batch_item
    FOREIGN KEY (tenant_id, inventory_batch_id, inventory_item_id)
    REFERENCES pharmacy_inventory_batches (tenant_id, id, inventory_item_id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_ward_indent_inventory_allocations_reserved_by
    FOREIGN KEY (tenant_id, reserved_by)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_ward_indent_inventory_allocations_released_by
    FOREIGN KEY (tenant_id, released_by)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT ux_ward_indent_inventory_allocations_tenant_id
    UNIQUE (tenant_id, id),
  CONSTRAINT ux_ward_indent_inventory_allocations_reservation_key
    UNIQUE (tenant_id, reservation_key),
  CONSTRAINT ux_ward_indent_inventory_allocations_lineage
    UNIQUE (tenant_id, id, ward_indent_item_id, inventory_batch_id)
);

CREATE UNIQUE INDEX ux_ward_indent_inventory_allocations_active_batch
  ON ward_indent_inventory_allocations
    (tenant_id, ward_indent_item_id, inventory_batch_id)
  WHERE status IN ('reserved', 'partially_issued', 'issued');
CREATE INDEX idx_ward_indent_inventory_allocations_indent
  ON ward_indent_inventory_allocations
    (tenant_id, ward_indent_id, ward_indent_item_id, id);
CREATE INDEX idx_ward_indent_inventory_allocations_batch_reservations
  ON ward_indent_inventory_allocations
    (tenant_id, inventory_batch_id, status)
  WHERE status IN ('reserved', 'partially_issued', 'issued');
CREATE INDEX idx_wi_alloc_batch_item_fk_med03
  ON ward_indent_inventory_allocations
    (tenant_id, inventory_batch_id, inventory_item_id);
CREATE INDEX idx_wi_alloc_inventory_item_fk_med03
  ON ward_indent_inventory_allocations (tenant_id, inventory_item_id);
CREATE INDEX idx_wi_alloc_reserved_by_fk_med03
  ON ward_indent_inventory_allocations (tenant_id, reserved_by);
CREATE INDEX idx_wi_alloc_released_by_fk_med03
  ON ward_indent_inventory_allocations (tenant_id, released_by)
  WHERE released_by IS NOT NULL;

CREATE TABLE ward_indent_inventory_movement_links (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  allocation_id BIGINT NOT NULL,
  stock_movement_id INTEGER NOT NULL,
  controlled_register_id INTEGER,
  movement_purpose VARCHAR(20) NOT NULL,
  quantity NUMERIC(14, 4) NOT NULL,
  ward_indent_state_version INTEGER NOT NULL,
  command_key VARCHAR(200) NOT NULL,
  linked_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ward_indent_inventory_movement_links_purpose_check CHECK (
    movement_purpose IN ('issue', 'return', 'compensation')
  ),
  CONSTRAINT ward_indent_inventory_movement_links_quantity_check
    CHECK (quantity > 0),
  CONSTRAINT ward_indent_inventory_movement_links_version_check
    CHECK (ward_indent_state_version > 0),
  CONSTRAINT ward_indent_inventory_movement_links_command_check
    CHECK (BTRIM(command_key) <> ''),
  CONSTRAINT fk_ward_indent_inventory_movement_links_tenant
    FOREIGN KEY (tenant_id)
    REFERENCES tenants (id)
    ON DELETE NO ACTION,
  CONSTRAINT fk_ward_indent_inventory_movement_links_allocation
    FOREIGN KEY (tenant_id, allocation_id)
    REFERENCES ward_indent_inventory_allocations (tenant_id, id)
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_ward_indent_inventory_movement_links_movement
    FOREIGN KEY (tenant_id, stock_movement_id)
    REFERENCES pharmacy_stock_movements (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_ward_indent_inventory_movement_links_register
    FOREIGN KEY (tenant_id, controlled_register_id)
    REFERENCES pharmacy_schedule_register (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_ward_indent_inventory_movement_links_actor
    FOREIGN KEY (tenant_id, linked_by)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT ux_ward_indent_inventory_movement_links_tenant_id
    UNIQUE (tenant_id, id),
  CONSTRAINT ux_ward_indent_inventory_movement_links_movement
    UNIQUE (tenant_id, stock_movement_id),
  CONSTRAINT ux_ward_indent_inventory_movement_links_command
    UNIQUE (tenant_id, command_key)
);

CREATE INDEX idx_ward_indent_inventory_movement_links_allocation
  ON ward_indent_inventory_movement_links
    (tenant_id, allocation_id, created_at, id);
CREATE INDEX idx_wi_movement_links_actor_fk_med03
  ON ward_indent_inventory_movement_links (tenant_id, linked_by);
CREATE INDEX idx_wi_movement_links_register_fk_med03
  ON ward_indent_inventory_movement_links (tenant_id, controlled_register_id)
  WHERE controlled_register_id IS NOT NULL;

CREATE OR REPLACE FUNCTION ward_indent_apply_inventory_movement_link()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
DECLARE
  allocation ward_indent_inventory_allocations%ROWTYPE;
  movement pharmacy_stock_movements%ROWTYPE;
  next_issued NUMERIC(14, 4);
  next_returned NUMERIC(14, 4);
BEGIN
  SELECT * INTO allocation
    FROM ward_indent_inventory_allocations
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.allocation_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ward-indent inventory allocation not found'
      USING ERRCODE = '23503';
  END IF;

  SELECT * INTO movement
    FROM pharmacy_stock_movements
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.stock_movement_id
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ward-indent stock movement not found'
      USING ERRCODE = '23503';
  END IF;
  IF movement.inventory_item_id <> allocation.inventory_item_id
     OR movement.inventory_batch_id IS DISTINCT FROM allocation.inventory_batch_id
     OR ABS(movement.quantity_delta) <> NEW.quantity THEN
    RAISE EXCEPTION 'ward-indent movement lineage does not match its allocation'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.movement_purpose = 'issue' AND movement.quantity_delta >= 0 THEN
    RAISE EXCEPTION 'ward-indent issue movement must decrease exact-batch stock'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.movement_purpose = 'return' AND movement.quantity_delta <= 0 THEN
    RAISE EXCEPTION 'ward-indent return movement must increase exact-batch stock'
      USING ERRCODE = '23514';
  END IF;

  IF movement.quantity_delta < 0 THEN
    next_issued := allocation.issued_quantity + NEW.quantity;
    IF next_issued > allocation.reserved_quantity THEN
      RAISE EXCEPTION 'ward-indent issue exceeds its exact reservation'
        USING ERRCODE = '23514';
    END IF;
    UPDATE ward_indent_inventory_allocations
       SET issued_quantity = next_issued,
           status = CASE
             WHEN next_issued = reserved_quantity THEN 'issued'
             ELSE 'partially_issued'
           END,
           updated_at = NOW()
     WHERE tenant_id = NEW.tenant_id
       AND id = NEW.allocation_id;
  ELSE
    next_returned := allocation.returned_quantity + NEW.quantity;
    IF next_returned + allocation.consumed_quantity > allocation.received_quantity THEN
      RAISE EXCEPTION 'ward-indent return exceeds received unconsumed custody'
        USING ERRCODE = '23514';
    END IF;
    UPDATE ward_indent_inventory_allocations
       SET returned_quantity = next_returned,
           status = CASE
             WHEN next_returned + consumed_quantity = received_quantity
               THEN 'reconciled'
             ELSE status
           END,
           updated_at = NOW()
     WHERE tenant_id = NEW.tenant_id
       AND id = NEW.allocation_id;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER ward_indent_inventory_movement_link_projection
  BEFORE INSERT ON ward_indent_inventory_movement_links
  FOR EACH ROW EXECUTE FUNCTION ward_indent_apply_inventory_movement_link();

CREATE TRIGGER ward_indent_inventory_movement_links_append_only
  BEFORE UPDATE OR DELETE ON ward_indent_inventory_movement_links
  FOR EACH ROW EXECUTE FUNCTION audit_append_only_guard();

-- ---------------------------------------------------------------------------
-- Ward custody consumption by MAR
-- ---------------------------------------------------------------------------

CREATE TABLE mar_supply_consumptions (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  medication_administration_id INTEGER NOT NULL,
  clinical_order_id INTEGER NOT NULL,
  ward_indent_item_id INTEGER NOT NULL,
  inventory_allocation_id BIGINT,
  inventory_batch_id INTEGER,
  quantity NUMERIC(14, 4) NOT NULL,
  evidence_status VARCHAR(30) NOT NULL DEFAULT 'matched',
  administration_mode VARCHAR(50) NOT NULL,
  command_key VARCHAR(200) NOT NULL,
  recorded_by UUID NOT NULL,
  override_reason TEXT,
  override_recorded_at TIMESTAMPTZ,
  reconciliation_task_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT mar_supply_consumptions_quantity_check CHECK (quantity > 0),
  CONSTRAINT mar_supply_consumptions_evidence_status_check CHECK (
    evidence_status IN ('matched', 'unmatched_override')
  ),
  CONSTRAINT mar_supply_consumptions_mode_check
    CHECK (BTRIM(administration_mode) <> ''),
  CONSTRAINT mar_supply_consumptions_command_check
    CHECK (BTRIM(command_key) <> ''),
  CONSTRAINT mar_supply_consumptions_evidence_check CHECK (
    (
      evidence_status = 'matched'
      AND inventory_allocation_id IS NOT NULL
      AND inventory_batch_id IS NOT NULL
      AND override_reason IS NULL
      AND override_recorded_at IS NULL
      AND reconciliation_task_id IS NULL
    )
    OR
    (
      evidence_status = 'unmatched_override'
      AND inventory_allocation_id IS NULL
      AND inventory_batch_id IS NULL
      AND override_reason IS NOT NULL
      AND BTRIM(override_reason) <> ''
      AND override_recorded_at IS NOT NULL
      AND reconciliation_task_id IS NOT NULL
    )
  ),
  CONSTRAINT fk_mar_supply_consumptions_tenant
    FOREIGN KEY (tenant_id)
    REFERENCES tenants (id)
    ON DELETE NO ACTION,
  CONSTRAINT fk_mar_supply_consumptions_administration_order
    FOREIGN KEY (tenant_id, medication_administration_id, clinical_order_id)
    REFERENCES medication_administrations (tenant_id, id, clinical_order_id)
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_mar_supply_consumptions_clinical_order
    FOREIGN KEY (tenant_id, clinical_order_id)
    REFERENCES clinical_orders (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_mar_supply_consumptions_ward_item
    FOREIGN KEY (tenant_id, ward_indent_item_id)
    REFERENCES ward_indent_items (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_mar_supply_consumptions_allocation_lineage
    FOREIGN KEY (
      tenant_id,
      inventory_allocation_id,
      ward_indent_item_id,
      inventory_batch_id
    )
    REFERENCES ward_indent_inventory_allocations (
      tenant_id,
      id,
      ward_indent_item_id,
      inventory_batch_id
    )
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_mar_supply_consumptions_actor
    FOREIGN KEY (tenant_id, recorded_by)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_mar_supply_consumptions_reconciliation_task
    FOREIGN KEY (tenant_id, reconciliation_task_id)
    REFERENCES tasks (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT ux_mar_supply_consumptions_tenant_id
    UNIQUE (tenant_id, id),
  CONSTRAINT ux_mar_supply_consumptions_command
    UNIQUE (tenant_id, command_key),
  CONSTRAINT ux_mar_supply_consumptions_admin_allocation
    UNIQUE (tenant_id, medication_administration_id, inventory_allocation_id)
);

CREATE INDEX idx_mar_supply_consumptions_administration
  ON mar_supply_consumptions
    (tenant_id, medication_administration_id, clinical_order_id, id);
CREATE INDEX idx_mar_supply_consumptions_clinical_order
  ON mar_supply_consumptions
    (tenant_id, clinical_order_id, created_at);
CREATE INDEX idx_mar_supply_consumptions_open_reconciliation
  ON mar_supply_consumptions
    (tenant_id, reconciliation_task_id, created_at)
  WHERE evidence_status = 'unmatched_override';
CREATE INDEX idx_mar_supply_allocation_lineage_fk_med03
  ON mar_supply_consumptions
    (tenant_id, inventory_allocation_id, ward_indent_item_id, inventory_batch_id)
  WHERE inventory_allocation_id IS NOT NULL;
CREATE INDEX idx_mar_supply_ward_item_fk_med03
  ON mar_supply_consumptions (tenant_id, ward_indent_item_id);
CREATE INDEX idx_mar_supply_actor_fk_med03
  ON mar_supply_consumptions (tenant_id, recorded_by);

CREATE OR REPLACE FUNCTION mar_supply_apply_custody_consumption()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
DECLARE
  allocation ward_indent_inventory_allocations%ROWTYPE;
  item_order_id INTEGER;
BEGIN
  SELECT clinical_order_id
    INTO item_order_id
    FROM ward_indent_items
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.ward_indent_item_id
   FOR KEY SHARE;
  IF NOT FOUND OR item_order_id IS DISTINCT FROM NEW.clinical_order_id THEN
    RAISE EXCEPTION 'MAR supply must match the ward-indent clinical order'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.evidence_status = 'unmatched_override' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO allocation
    FROM ward_indent_inventory_allocations
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.inventory_allocation_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MAR supply allocation not found'
      USING ERRCODE = '23503';
  END IF;
  IF allocation.status = 'released'
     OR allocation.consumed_quantity + allocation.returned_quantity + NEW.quantity
          > allocation.received_quantity THEN
    RAISE EXCEPTION 'MAR supply exceeds received unconsumed ward custody'
      USING ERRCODE = '23514';
  END IF;

  UPDATE ward_indent_inventory_allocations
     SET consumed_quantity = consumed_quantity + NEW.quantity,
         status = CASE
           WHEN consumed_quantity + returned_quantity + NEW.quantity = received_quantity
             THEN 'reconciled'
           ELSE status
         END,
         updated_at = NOW()
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.inventory_allocation_id;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER mar_supply_consumption_projection
  BEFORE INSERT ON mar_supply_consumptions
  FOR EACH ROW EXECUTE FUNCTION mar_supply_apply_custody_consumption();

CREATE TRIGGER mar_supply_consumptions_append_only
  BEFORE UPDATE OR DELETE ON mar_supply_consumptions
  FOR EACH ROW EXECUTE FUNCTION audit_append_only_guard();

CREATE TABLE mar_administration_command_receipts (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  medication_administration_id INTEGER NOT NULL,
  actor_uid UUID NOT NULL,
  command_scope VARCHAR(50) NOT NULL,
  command_key VARCHAR(200) NOT NULL,
  request_body_sha256 CHAR(64) NOT NULL,
  administration_mode VARCHAR(50) NOT NULL,
  response_data JSONB NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT mar_administration_command_receipts_identity_check CHECK (
    command_key = BTRIM(command_key)
    AND command_key ~ '^[A-Za-z0-9_:.\-]+$'
    AND request_body_sha256 ~ '^[0-9a-f]{64}$'
    AND (
      (command_scope = 'mar_administer' AND administration_mode = 'online_no_scan')
      OR
      (command_scope = 'mar_administer_scan' AND administration_mode = 'online_barcode_scan')
    )
  ),
  CONSTRAINT mar_administration_command_receipts_response_check CHECK (
    jsonb_typeof(response_data) = 'object'
    AND response_data->>'id' ~ '^[1-9][0-9]*$'
    AND (response_data->>'id')::INTEGER = medication_administration_id
    AND LOWER(response_data->>'status') = 'administered'
  ),
  CONSTRAINT fk_mar_administration_command_receipts_tenant
    FOREIGN KEY (tenant_id)
    REFERENCES tenants (id)
    ON DELETE NO ACTION,
  CONSTRAINT fk_mar_administration_command_receipts_administration
    FOREIGN KEY (tenant_id, medication_administration_id)
    REFERENCES medication_administrations (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_mar_administration_command_receipts_actor
    FOREIGN KEY (tenant_id, actor_uid)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT ux_mar_administration_command_receipts_identity
    UNIQUE (tenant_id, actor_uid, command_scope, command_key),
  CONSTRAINT ux_mar_administration_command_receipts_target
    UNIQUE (tenant_id, medication_administration_id),
  CONSTRAINT ux_mar_administration_command_receipts_tenant_id
    UNIQUE (tenant_id, id)
);

CREATE INDEX idx_mar_administration_command_receipts_completed
  ON mar_administration_command_receipts
    (tenant_id, completed_at DESC, id DESC);

CREATE OR REPLACE FUNCTION mar_administration_command_receipt_validate()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
DECLARE
  administration RECORD;
BEGIN
  SELECT status, administered_by, scanned_patient_uid, scanned_barcode,
         patient_scanned_at, medication_scanned_at
    INTO administration
    FROM medication_administrations
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.medication_administration_id
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MAR administration command target not found'
      USING ERRCODE = '23503';
  END IF;
  IF LOWER(administration.status) <> 'administered'
     OR administration.administered_by IS DISTINCT FROM NEW.actor_uid THEN
    RAISE EXCEPTION 'MAR administration command receipt must match the committed actor and state'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.command_scope = 'mar_administer_scan'
     AND (
       administration.scanned_patient_uid IS NULL
       OR NULLIF(BTRIM(administration.scanned_barcode), '') IS NULL
       OR administration.patient_scanned_at IS NULL
       OR administration.medication_scanned_at IS NULL
     ) THEN
    RAISE EXCEPTION 'Scanned MAR command receipt requires committed two-scan evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER mar_administration_command_receipt_validation
  BEFORE INSERT ON mar_administration_command_receipts
  FOR EACH ROW EXECUTE FUNCTION mar_administration_command_receipt_validate();

CREATE TRIGGER mar_administration_command_receipts_append_only
  BEFORE UPDATE OR DELETE ON mar_administration_command_receipts
  FOR EACH ROW EXECUTE FUNCTION audit_append_only_guard();

CREATE TABLE mar_transition_command_receipts (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  medication_administration_id INTEGER NOT NULL,
  actor_uid UUID NOT NULL,
  command_scope VARCHAR(50) NOT NULL,
  transition_action VARCHAR(20) NOT NULL,
  command_key VARCHAR(200) NOT NULL,
  request_body_sha256 CHAR(64) NOT NULL,
  response_data JSONB NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT mar_transition_command_receipts_identity_check CHECK (
    command_key = BTRIM(command_key)
    AND command_key ~ '^[A-Za-z0-9_:.\-]+$'
    AND request_body_sha256 ~ '^[0-9a-f]{64}$'
    AND (
      (command_scope = 'mar_miss' AND transition_action = 'missed')
      OR
      (command_scope = 'mar_hold' AND transition_action = 'held')
    )
  ),
  CONSTRAINT mar_transition_command_receipts_response_check CHECK (
    jsonb_typeof(response_data) = 'object'
    AND response_data->>'id' ~ '^[1-9][0-9]*$'
    AND (response_data->>'id')::INTEGER = medication_administration_id
    AND LOWER(response_data->>'status') = transition_action
  ),
  CONSTRAINT fk_mar_transition_command_receipts_tenant
    FOREIGN KEY (tenant_id)
    REFERENCES tenants (id)
    ON DELETE NO ACTION,
  CONSTRAINT fk_mar_transition_command_receipts_administration
    FOREIGN KEY (tenant_id, medication_administration_id)
    REFERENCES medication_administrations (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_mar_transition_command_receipts_actor
    FOREIGN KEY (tenant_id, actor_uid)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT ux_mar_transition_command_receipts_identity
    UNIQUE (tenant_id, actor_uid, command_scope, command_key),
  CONSTRAINT ux_mar_transition_command_receipts_target_action
    UNIQUE (tenant_id, medication_administration_id, transition_action),
  CONSTRAINT ux_mar_transition_command_receipts_tenant_id
    UNIQUE (tenant_id, id)
);

CREATE INDEX idx_mar_transition_command_receipts_completed
  ON mar_transition_command_receipts
    (tenant_id, completed_at DESC, id DESC);

CREATE OR REPLACE FUNCTION mar_transition_command_receipt_validate()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
DECLARE
  administration RECORD;
BEGIN
  SELECT status, held_by, held_at, missed_by, missed_at
    INTO administration
    FROM medication_administrations
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.medication_administration_id
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MAR transition command target not found'
      USING ERRCODE = '23503';
  END IF;
  IF LOWER(administration.status) <> NEW.transition_action THEN
    RAISE EXCEPTION 'MAR transition receipt must match the committed state'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.transition_action = 'held'
     AND (
       administration.held_by IS DISTINCT FROM NEW.actor_uid
       OR administration.held_at IS NULL
     ) THEN
    RAISE EXCEPTION 'MAR hold receipt must match the committed actor and time'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.transition_action = 'missed'
     AND (
       administration.missed_by IS DISTINCT FROM NEW.actor_uid
       OR administration.missed_at IS NULL
     ) THEN
    RAISE EXCEPTION 'MAR miss receipt must match the committed actor and time'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER mar_transition_command_receipt_validation
  BEFORE INSERT ON mar_transition_command_receipts
  FOR EACH ROW EXECUTE FUNCTION mar_transition_command_receipt_validate();

CREATE TRIGGER mar_transition_command_receipts_append_only
  BEFORE UPDATE OR DELETE ON mar_transition_command_receipts
  FOR EACH ROW EXECUTE FUNCTION audit_append_only_guard();

CREATE TABLE mar_supply_reconciliation_links (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  unmatched_consumption_id BIGINT NOT NULL,
  clinical_order_id INTEGER NOT NULL,
  ward_indent_item_id INTEGER NOT NULL,
  inventory_allocation_id BIGINT NOT NULL,
  inventory_batch_id INTEGER NOT NULL,
  quantity NUMERIC(14, 4) NOT NULL,
  command_key VARCHAR(200) NOT NULL,
  reconciled_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT mar_supply_reconciliation_links_quantity_check CHECK (quantity > 0),
  CONSTRAINT mar_supply_reconciliation_links_command_check
    CHECK (BTRIM(command_key) <> ''),
  CONSTRAINT fk_mar_supply_reconciliation_links_tenant
    FOREIGN KEY (tenant_id)
    REFERENCES tenants (id)
    ON DELETE NO ACTION,
  CONSTRAINT fk_mar_supply_reconciliation_links_consumption
    FOREIGN KEY (tenant_id, unmatched_consumption_id)
    REFERENCES mar_supply_consumptions (tenant_id, id)
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_mar_supply_reconciliation_links_clinical_order
    FOREIGN KEY (tenant_id, clinical_order_id)
    REFERENCES clinical_orders (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_mar_supply_reconciliation_links_ward_item
    FOREIGN KEY (tenant_id, ward_indent_item_id)
    REFERENCES ward_indent_items (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_mar_supply_reconciliation_links_allocation_lineage
    FOREIGN KEY (
      tenant_id,
      inventory_allocation_id,
      ward_indent_item_id,
      inventory_batch_id
    )
    REFERENCES ward_indent_inventory_allocations (
      tenant_id,
      id,
      ward_indent_item_id,
      inventory_batch_id
    )
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_mar_supply_reconciliation_links_actor
    FOREIGN KEY (tenant_id, reconciled_by)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT ux_mar_supply_reconciliation_links_tenant_id
    UNIQUE (tenant_id, id),
  CONSTRAINT ux_mar_supply_reconciliation_links_command
    UNIQUE (tenant_id, command_key)
);

CREATE INDEX idx_mar_supply_reconciliation_links_consumption
  ON mar_supply_reconciliation_links
    (tenant_id, unmatched_consumption_id, created_at, id);
CREATE INDEX idx_mar_supply_reconciliation_links_allocation_fk_med03
  ON mar_supply_reconciliation_links
    (tenant_id, inventory_allocation_id, ward_indent_item_id, inventory_batch_id);
CREATE INDEX idx_mar_supply_reconciliation_links_clinical_order_fk_med03
  ON mar_supply_reconciliation_links (tenant_id, clinical_order_id);
CREATE INDEX idx_mar_supply_reconciliation_links_ward_item_fk_med03
  ON mar_supply_reconciliation_links (tenant_id, ward_indent_item_id);
CREATE INDEX idx_mar_supply_reconciliation_links_actor_fk_med03
  ON mar_supply_reconciliation_links (tenant_id, reconciled_by);

CREATE OR REPLACE FUNCTION mar_supply_apply_reconciliation_link()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
DECLARE
  unmatched mar_supply_consumptions%ROWTYPE;
  allocation ward_indent_inventory_allocations%ROWTYPE;
  already_reconciled NUMERIC(14, 4);
BEGIN
  SELECT * INTO unmatched
    FROM mar_supply_consumptions
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.unmatched_consumption_id
   FOR UPDATE;
  IF NOT FOUND OR unmatched.evidence_status <> 'unmatched_override' THEN
    RAISE EXCEPTION 'MAR reconciliation requires an unmatched override consumption'
      USING ERRCODE = '23514';
  END IF;
  IF unmatched.clinical_order_id IS DISTINCT FROM NEW.clinical_order_id
     OR unmatched.ward_indent_item_id IS DISTINCT FROM NEW.ward_indent_item_id THEN
    RAISE EXCEPTION 'MAR reconciliation must preserve the original order and ward item'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO allocation
    FROM ward_indent_inventory_allocations
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.inventory_allocation_id
   FOR UPDATE;
  IF NOT FOUND OR allocation.status = 'released' THEN
    RAISE EXCEPTION 'MAR reconciliation allocation is unavailable'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(link.quantity), 0)::numeric
    INTO already_reconciled
    FROM mar_supply_reconciliation_links link
   WHERE link.tenant_id = NEW.tenant_id
     AND link.unmatched_consumption_id = NEW.unmatched_consumption_id;
  IF already_reconciled + NEW.quantity > unmatched.quantity THEN
    RAISE EXCEPTION 'MAR reconciliation exceeds the unmatched administration quantity'
      USING ERRCODE = '23514';
  END IF;
  IF allocation.consumed_quantity + allocation.returned_quantity + NEW.quantity
       > allocation.received_quantity THEN
    RAISE EXCEPTION 'MAR reconciliation exceeds received unconsumed ward custody'
      USING ERRCODE = '23514';
  END IF;

  UPDATE ward_indent_inventory_allocations
     SET consumed_quantity = consumed_quantity + NEW.quantity,
         status = CASE
           WHEN consumed_quantity + returned_quantity + NEW.quantity = received_quantity
             THEN 'reconciled'
           ELSE status
         END,
         updated_at = NOW()
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.inventory_allocation_id;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER mar_supply_reconciliation_link_projection
  BEFORE INSERT ON mar_supply_reconciliation_links
  FOR EACH ROW EXECUTE FUNCTION mar_supply_apply_reconciliation_link();

CREATE TRIGGER mar_supply_reconciliation_links_append_only
  BEFORE UPDATE OR DELETE ON mar_supply_reconciliation_links
  FOR EACH ROW EXECUTE FUNCTION audit_append_only_guard();

-- ---------------------------------------------------------------------------
-- Append-only medication financial evidence and governed credit obligations
-- ---------------------------------------------------------------------------

ALTER TABLE billing_invoices
  ADD COLUMN credit_note_amount NUMERIC(12, 2) NOT NULL DEFAULT 0;

ALTER TABLE billing_invoices
  ADD CONSTRAINT billing_invoices_credit_note_amount_check CHECK (
    credit_note_amount >= 0
    AND credit_note_amount <= total_amount + 0.005
  );

CREATE UNIQUE INDEX ux_billing_invoice_items_ward_indent_item_med03
  ON billing_invoice_items (tenant_id, source_ref_type, source_ref_id)
  WHERE source_ref_type = 'ward_indent_item'
    AND source_ref_id IS NOT NULL
    AND source_ref_active;

CREATE TABLE ward_indent_financial_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  ward_indent_id INTEGER NOT NULL,
  ward_indent_item_id INTEGER NOT NULL,
  clinical_order_id INTEGER,
  ward_indent_event_id BIGINT NOT NULL,
  ward_indent_state_version INTEGER NOT NULL,
  event_kind VARCHAR(30) NOT NULL,
  quantity NUMERIC(14, 4) NOT NULL,
  unit_price_minor BIGINT NOT NULL,
  amount_minor BIGINT NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'INR',
  pricing_snapshot JSONB NOT NULL,
  original_event_id BIGINT,
  invoice_id INTEGER,
  invoice_item_id INTEGER,
  event_key VARCHAR(200) NOT NULL,
  actor_uid UUID NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ward_indent_financial_events_kind_check CHECK (
    event_kind IN ('charge', 'credit', 'charge_reversal', 'credit_reversal')
  ),
  CONSTRAINT ward_indent_financial_events_quantity_check CHECK (quantity > 0),
  CONSTRAINT ward_indent_financial_events_price_check CHECK (unit_price_minor >= 0),
  CONSTRAINT ward_indent_financial_events_amount_check CHECK (
    amount_minor = CASE
      WHEN event_kind IN ('charge', 'credit_reversal')
        THEN ROUND(quantity * unit_price_minor)::BIGINT
      ELSE -ROUND(quantity * unit_price_minor)::BIGINT
    END
  ),
  CONSTRAINT ward_indent_financial_events_currency_check CHECK (
    currency ~ '^[A-Z]{3}$'
  ),
  CONSTRAINT ward_indent_financial_events_version_check
    CHECK (ward_indent_state_version > 0),
  CONSTRAINT ward_indent_financial_events_key_check CHECK (BTRIM(event_key) <> ''),
  CONSTRAINT ward_indent_financial_events_original_check CHECK (
    (event_kind = 'charge' AND original_event_id IS NULL)
    OR (event_kind <> 'charge' AND original_event_id IS NOT NULL)
  ),
  CONSTRAINT ward_indent_financial_events_invoice_projection_check CHECK (
    (invoice_id IS NULL AND invoice_item_id IS NULL)
    OR (invoice_id IS NOT NULL AND invoice_item_id IS NOT NULL)
  ),
  CONSTRAINT fk_ward_indent_financial_events_tenant
    FOREIGN KEY (tenant_id)
    REFERENCES tenants (id)
    ON DELETE NO ACTION,
  CONSTRAINT fk_ward_indent_financial_events_indent_item
    FOREIGN KEY (tenant_id, ward_indent_item_id, ward_indent_id)
    REFERENCES ward_indent_items (tenant_id, id, ward_indent_id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_ward_indent_financial_events_clinical_order
    FOREIGN KEY (tenant_id, clinical_order_id)
    REFERENCES clinical_orders (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_ward_indent_financial_events_ward_event
    FOREIGN KEY (
      tenant_id,
      ward_indent_event_id,
      ward_indent_id,
      ward_indent_state_version
    )
    REFERENCES ward_indent_events (tenant_id, id, ward_indent_id, state_version)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_ward_indent_financial_events_original
    FOREIGN KEY (tenant_id, original_event_id)
    REFERENCES ward_indent_financial_events (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_ward_indent_financial_events_invoice
    FOREIGN KEY (tenant_id, invoice_id)
    REFERENCES billing_invoices (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_ward_indent_financial_events_invoice_item
    FOREIGN KEY (tenant_id, invoice_item_id)
    REFERENCES billing_invoice_items (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_ward_indent_financial_events_actor
    FOREIGN KEY (tenant_id, actor_uid)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT ux_ward_indent_financial_events_tenant_id
    UNIQUE (tenant_id, id),
  CONSTRAINT ux_ward_indent_financial_events_event_key
    UNIQUE (tenant_id, event_key)
);

CREATE INDEX idx_ward_indent_financial_events_indent
  ON ward_indent_financial_events
    (tenant_id, ward_indent_id, ward_indent_item_id, occurred_at, id);
CREATE INDEX idx_ward_indent_financial_events_invoice
  ON ward_indent_financial_events
    (tenant_id, invoice_id, occurred_at, id)
  WHERE invoice_id IS NOT NULL;
CREATE INDEX idx_wi_financial_original_fk_med03
  ON ward_indent_financial_events
    (tenant_id, original_event_id)
  WHERE original_event_id IS NOT NULL;
CREATE INDEX idx_wi_financial_clinical_order_fk_med03
  ON ward_indent_financial_events
    (tenant_id, clinical_order_id)
  WHERE clinical_order_id IS NOT NULL;
CREATE INDEX idx_wi_financial_invoice_item_fk_med03
  ON ward_indent_financial_events
    (tenant_id, invoice_item_id)
  WHERE invoice_item_id IS NOT NULL;
CREATE INDEX idx_wi_financial_ward_event_fk_med03
  ON ward_indent_financial_events
    (tenant_id, ward_indent_event_id, ward_indent_id, ward_indent_state_version);
CREATE INDEX idx_wi_financial_actor_fk_med03
  ON ward_indent_financial_events (tenant_id, actor_uid);

CREATE OR REPLACE FUNCTION ward_indent_validate_financial_event_lineage()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
DECLARE
  original ward_indent_financial_events%ROWTYPE;
  root_charge ward_indent_financial_events%ROWTYPE;
  root_charge_id BIGINT;
  effective_reduction NUMERIC(14, 4);
  prior_reversal_quantity NUMERIC(14, 4);
  ward_item_order_id INTEGER;
  indent_patient_uid UUID;
  projected_invoice_patient_uid UUID;
  projected_line_invoice_id INTEGER;
  projected_line_source_type VARCHAR(80);
  projected_line_source_id BIGINT;
  projected_line_active BOOLEAN;
BEGIN
  SELECT item.clinical_order_id, indent.patient_uid
    INTO ward_item_order_id, indent_patient_uid
    FROM ward_indent_items item
    JOIN ward_indents indent
      ON indent.tenant_id = item.tenant_id
     AND indent.id = item.ward_indent_id
   WHERE item.tenant_id = NEW.tenant_id
     AND item.id = NEW.ward_indent_item_id
     AND indent.id = NEW.ward_indent_id
   FOR KEY SHARE OF item, indent;
  IF NOT FOUND OR ward_item_order_id IS DISTINCT FROM NEW.clinical_order_id THEN
    RAISE EXCEPTION 'ward-indent financial event does not match its clinical-order item'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.invoice_id IS NOT NULL THEN
    SELECT invoice.patient_uid,
           line.invoice_id,
           line.source_ref_type,
           line.source_ref_id,
           line.source_ref_active
      INTO projected_invoice_patient_uid,
           projected_line_invoice_id,
           projected_line_source_type,
           projected_line_source_id,
           projected_line_active
      FROM billing_invoices invoice
      JOIN billing_invoice_items line
        ON line.tenant_id = invoice.tenant_id
       AND line.id = NEW.invoice_item_id
     WHERE invoice.tenant_id = NEW.tenant_id
       AND invoice.id = NEW.invoice_id
     FOR KEY SHARE OF invoice, line;
    IF NOT FOUND
       OR projected_invoice_patient_uid IS DISTINCT FROM indent_patient_uid
       OR projected_line_invoice_id IS DISTINCT FROM NEW.invoice_id
       OR projected_line_source_type IS DISTINCT FROM 'ward_indent_item'
       OR projected_line_source_id IS DISTINCT FROM NEW.ward_indent_item_id::BIGINT
       OR projected_line_active IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'ward-indent financial event invoice projection has mismatched lineage'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.original_event_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO original
    FROM ward_indent_financial_events
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.original_event_id;
  IF NOT FOUND
     OR original.ward_indent_id <> NEW.ward_indent_id
     OR original.ward_indent_item_id <> NEW.ward_indent_item_id
     OR original.clinical_order_id IS DISTINCT FROM NEW.clinical_order_id
     OR original.invoice_id IS DISTINCT FROM NEW.invoice_id
     OR original.invoice_item_id IS DISTINCT FROM NEW.invoice_item_id
     OR original.currency <> NEW.currency
     OR original.unit_price_minor <> NEW.unit_price_minor THEN
    RAISE EXCEPTION 'ward-indent financial event lineage does not match its original charge'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.event_kind = 'credit' AND original.event_kind <> 'charge' THEN
    RAISE EXCEPTION 'ward-indent credit must reference an original charge'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.event_kind = 'charge_reversal' AND original.event_kind <> 'charge' THEN
    RAISE EXCEPTION 'ward-indent charge reversal must reference a charge'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.event_kind = 'credit_reversal' AND original.event_kind <> 'credit' THEN
    RAISE EXCEPTION 'ward-indent credit reversal must reference a credit'
      USING ERRCODE = '23514';
  END IF;

  root_charge_id := CASE
    WHEN original.event_kind = 'charge' THEN original.id
    WHEN original.event_kind = 'credit' THEN original.original_event_id
    ELSE NULL
  END;
  SELECT * INTO root_charge
    FROM ward_indent_financial_events
   WHERE tenant_id = NEW.tenant_id
     AND id = root_charge_id
     AND event_kind = 'charge'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ward-indent financial event has no root charge'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.quantity > original.quantity THEN
    RAISE EXCEPTION 'ward-indent financial event exceeds original quantity'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.event_kind = 'credit_reversal' THEN
    SELECT COALESCE(SUM(event.quantity), 0)
      INTO prior_reversal_quantity
      FROM ward_indent_financial_events event
     WHERE event.tenant_id = NEW.tenant_id
       AND event.event_kind = 'credit_reversal'
       AND event.original_event_id = original.id;
    IF prior_reversal_quantity + NEW.quantity > original.quantity THEN
      RAISE EXCEPTION 'ward-indent credit reversals cumulatively exceed the credit'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT
      COALESCE((
        SELECT SUM(event.quantity)
          FROM ward_indent_financial_events event
         WHERE event.tenant_id = NEW.tenant_id
           AND event.original_event_id = root_charge.id
           AND event.event_kind IN ('credit', 'charge_reversal')
      ), 0)
      - COALESCE((
        SELECT SUM(reversal.quantity)
          FROM ward_indent_financial_events reversal
          JOIN ward_indent_financial_events credit
            ON credit.tenant_id = reversal.tenant_id
           AND credit.id = reversal.original_event_id
           AND credit.event_kind = 'credit'
         WHERE reversal.tenant_id = NEW.tenant_id
           AND reversal.event_kind = 'credit_reversal'
           AND credit.original_event_id = root_charge.id
      ), 0)
      INTO effective_reduction;
    IF effective_reduction + NEW.quantity > root_charge.quantity THEN
      RAISE EXCEPTION 'ward-indent credits and reversals cumulatively exceed the root charge'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER ward_indent_financial_event_lineage
  BEFORE INSERT ON ward_indent_financial_events
  FOR EACH ROW EXECUTE FUNCTION ward_indent_validate_financial_event_lineage();

CREATE TRIGGER ward_indent_financial_events_append_only
  BEFORE UPDATE OR DELETE ON ward_indent_financial_events
  FOR EACH ROW EXECUTE FUNCTION audit_append_only_guard();

CREATE TABLE billing_credit_notes (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  credit_note_number VARCHAR(80) NOT NULL,
  invoice_id INTEGER NOT NULL,
  patient_uid UUID NOT NULL,
  source_financial_event_id BIGINT NOT NULL,
  amount_minor BIGINT NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'INR',
  reason TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  task_id INTEGER,
  raised_by UUID NOT NULL,
  raised_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_by UUID,
  approved_at TIMESTAMPTZ,
  rejected_by UUID,
  rejected_at TIMESTAMPTZ,
  rejection_reason TEXT,
  applied_by UUID,
  applied_at TIMESTAMPTZ,
  application_key VARCHAR(200),
  receivable_credit_minor BIGINT NOT NULL DEFAULT 0,
  refund_obligation_minor BIGINT NOT NULL DEFAULT 0,
  refund_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT billing_credit_notes_amount_check CHECK (amount_minor > 0),
  CONSTRAINT billing_credit_notes_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT billing_credit_notes_reason_check CHECK (BTRIM(reason) <> ''),
  CONSTRAINT billing_credit_notes_status_check CHECK (
    status IN ('pending', 'approved', 'rejected', 'applied')
  ),
  CONSTRAINT billing_credit_notes_projection_check CHECK (
    receivable_credit_minor >= 0
    AND refund_obligation_minor >= 0
    AND receivable_credit_minor + refund_obligation_minor <= amount_minor
  ),
  CONSTRAINT billing_credit_notes_refund_projection_check CHECK (
    (refund_obligation_minor = 0 AND refund_id IS NULL)
    OR
    (status = 'applied' AND refund_obligation_minor > 0 AND refund_id IS NOT NULL)
  ),
  CONSTRAINT billing_credit_notes_lifecycle_check CHECK (
    (
      status = 'pending'
      AND approved_by IS NULL AND approved_at IS NULL
      AND rejected_by IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL
      AND applied_by IS NULL AND applied_at IS NULL AND application_key IS NULL
    )
    OR
    (
      status = 'approved'
      AND approved_by IS NOT NULL AND approved_at IS NOT NULL
      AND rejected_by IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL
      AND applied_by IS NULL AND applied_at IS NULL AND application_key IS NULL
    )
    OR
    (
      status = 'rejected'
      AND approved_by IS NULL AND approved_at IS NULL
      AND rejected_by IS NOT NULL AND rejected_at IS NOT NULL
      AND rejection_reason IS NOT NULL AND BTRIM(rejection_reason) <> ''
      AND applied_by IS NULL AND applied_at IS NULL AND application_key IS NULL
    )
    OR
    (
      status = 'applied'
      AND approved_by IS NOT NULL AND approved_at IS NOT NULL
      AND rejected_by IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL
      AND applied_by IS NOT NULL AND applied_at IS NOT NULL
      AND application_key IS NOT NULL AND BTRIM(application_key) <> ''
      AND receivable_credit_minor + refund_obligation_minor = amount_minor
    )
  ),
  CONSTRAINT fk_billing_credit_notes_tenant
    FOREIGN KEY (tenant_id)
    REFERENCES tenants (id)
    ON DELETE NO ACTION,
  CONSTRAINT fk_billing_credit_notes_invoice
    FOREIGN KEY (tenant_id, invoice_id)
    REFERENCES billing_invoices (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_billing_credit_notes_patient
    FOREIGN KEY (tenant_id, patient_uid)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_billing_credit_notes_financial_event
    FOREIGN KEY (tenant_id, source_financial_event_id)
    REFERENCES ward_indent_financial_events (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_billing_credit_notes_task
    FOREIGN KEY (tenant_id, task_id)
    REFERENCES tasks (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_billing_credit_notes_raised_by
    FOREIGN KEY (tenant_id, raised_by)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_billing_credit_notes_approved_by
    FOREIGN KEY (tenant_id, approved_by)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_billing_credit_notes_rejected_by
    FOREIGN KEY (tenant_id, rejected_by)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_billing_credit_notes_applied_by
    FOREIGN KEY (tenant_id, applied_by)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_billing_credit_notes_refund
    FOREIGN KEY (tenant_id, refund_id)
    REFERENCES billing_refunds (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT ux_billing_credit_notes_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT ux_billing_credit_notes_number UNIQUE (tenant_id, credit_note_number),
  CONSTRAINT ux_billing_credit_notes_source_event
    UNIQUE (tenant_id, source_financial_event_id),
  CONSTRAINT ux_billing_credit_notes_application_key
    UNIQUE (tenant_id, application_key)
);

CREATE INDEX idx_billing_credit_notes_worklist
  ON billing_credit_notes (tenant_id, status, raised_at, id);
CREATE INDEX idx_billing_credit_notes_invoice
  ON billing_credit_notes (tenant_id, invoice_id, raised_at, id);
CREATE INDEX idx_billing_credit_notes_patient_fk_med03
  ON billing_credit_notes (tenant_id, patient_uid);
CREATE INDEX idx_billing_credit_notes_task_fk_med03
  ON billing_credit_notes (tenant_id, task_id)
  WHERE task_id IS NOT NULL;
CREATE INDEX idx_billing_credit_notes_refund_fk_med03
  ON billing_credit_notes (tenant_id, refund_id)
  WHERE refund_id IS NOT NULL;
CREATE INDEX idx_billing_credit_notes_raised_by_fk_med03
  ON billing_credit_notes (tenant_id, raised_by);
CREATE INDEX idx_billing_credit_notes_approved_by_fk_med03
  ON billing_credit_notes (tenant_id, approved_by)
  WHERE approved_by IS NOT NULL;
CREATE INDEX idx_billing_credit_notes_rejected_by_fk_med03
  ON billing_credit_notes (tenant_id, rejected_by)
  WHERE rejected_by IS NOT NULL;
CREATE INDEX idx_billing_credit_notes_applied_by_fk_med03
  ON billing_credit_notes (tenant_id, applied_by)
  WHERE applied_by IS NOT NULL;

CREATE TABLE billing_credit_note_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  credit_note_id BIGINT NOT NULL,
  event_type VARCHAR(30) NOT NULL,
  actor_uid UUID NOT NULL,
  command_key VARCHAR(200) NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT billing_credit_note_events_type_check CHECK (
    event_type IN ('raised', 'approved', 'rejected', 'applied')
  ),
  CONSTRAINT billing_credit_note_events_command_check CHECK (BTRIM(command_key) <> ''),
  CONSTRAINT fk_billing_credit_note_events_tenant
    FOREIGN KEY (tenant_id)
    REFERENCES tenants (id)
    ON DELETE NO ACTION,
  CONSTRAINT fk_billing_credit_note_events_note
    FOREIGN KEY (tenant_id, credit_note_id)
    REFERENCES billing_credit_notes (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_billing_credit_note_events_actor
    FOREIGN KEY (tenant_id, actor_uid)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT ux_billing_credit_note_events_command UNIQUE (tenant_id, command_key),
  CONSTRAINT ux_billing_credit_note_events_state
    UNIQUE (tenant_id, credit_note_id, event_type)
);

CREATE INDEX idx_billing_credit_note_events_note
  ON billing_credit_note_events (tenant_id, credit_note_id, occurred_at, id);
CREATE INDEX idx_billing_credit_note_events_actor_fk_med03
  ON billing_credit_note_events (tenant_id, actor_uid);

CREATE TRIGGER billing_credit_note_events_append_only
  BEFORE UPDATE OR DELETE ON billing_credit_note_events
  FOR EACH ROW EXECUTE FUNCTION audit_append_only_guard();

CREATE OR REPLACE FUNCTION billing_credit_note_require_context()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
DECLARE
  invoice_patient UUID;
  invoice_status VARCHAR(30);
  source_event ward_indent_financial_events%ROWTYPE;
  refund_row billing_refunds%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.credit_note_number IS DISTINCT FROM OLD.credit_note_number
    OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
    OR NEW.patient_uid IS DISTINCT FROM OLD.patient_uid
    OR NEW.source_financial_event_id IS DISTINCT FROM OLD.source_financial_event_id
    OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.reason IS DISTINCT FROM OLD.reason
    OR NEW.raised_by IS DISTINCT FROM OLD.raised_by
    OR NEW.raised_at IS DISTINCT FROM OLD.raised_at
  ) THEN
    RAISE EXCEPTION 'billing credit-note source identity is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected'))
    OR (OLD.status = 'approved' AND NEW.status = 'applied')
  ) THEN
    RAISE EXCEPTION 'billing credit-note state transition is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    (OLD.task_id IS NOT NULL AND NEW.task_id IS DISTINCT FROM OLD.task_id)
    OR (
      OLD.approved_by IS NOT NULL
      AND (
        NEW.approved_by IS DISTINCT FROM OLD.approved_by
        OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
      )
    )
    OR (
      OLD.rejected_by IS NOT NULL
      AND (
        NEW.rejected_by IS DISTINCT FROM OLD.rejected_by
        OR NEW.rejected_at IS DISTINCT FROM OLD.rejected_at
        OR NEW.rejection_reason IS DISTINCT FROM OLD.rejection_reason
      )
    )
    OR (
      OLD.applied_by IS NOT NULL
      AND (
        NEW.applied_by IS DISTINCT FROM OLD.applied_by
        OR NEW.applied_at IS DISTINCT FROM OLD.applied_at
        OR NEW.application_key IS DISTINCT FROM OLD.application_key
        OR NEW.receivable_credit_minor IS DISTINCT FROM OLD.receivable_credit_minor
        OR NEW.refund_obligation_minor IS DISTINCT FROM OLD.refund_obligation_minor
        OR NEW.refund_id IS DISTINCT FROM OLD.refund_id
      )
    )
  ) THEN
    RAISE EXCEPTION 'billing credit-note recorded authority is immutable'
      USING ERRCODE = '23514';
  END IF;

  SELECT patient_uid, status INTO invoice_patient, invoice_status
    FROM billing_invoices
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.invoice_id
   FOR KEY SHARE;
  IF NOT FOUND OR invoice_patient IS DISTINCT FROM NEW.patient_uid THEN
    RAISE EXCEPTION 'billing credit note must match its invoice patient'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.status = 'applied' AND invoice_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'only a draft invoice credit may be inserted already applied'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO source_event
    FROM ward_indent_financial_events
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.source_financial_event_id
   FOR KEY SHARE;
  IF NOT FOUND
     OR source_event.event_kind <> 'credit'
     OR source_event.invoice_id IS DISTINCT FROM NEW.invoice_id
     OR ABS(source_event.amount_minor) <> NEW.amount_minor
     OR source_event.currency <> NEW.currency THEN
    RAISE EXCEPTION 'billing credit note must match its source credit event'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.refund_id IS NOT NULL THEN
    SELECT * INTO refund_row
      FROM billing_refunds
     WHERE tenant_id = NEW.tenant_id
       AND id = NEW.refund_id
     FOR KEY SHARE;
    IF NOT FOUND
       OR refund_row.invoice_id IS DISTINCT FROM NEW.invoice_id
       OR refund_row.patient_uid IS DISTINCT FROM NEW.patient_uid
       OR ROUND(refund_row.amount * 100)::BIGINT IS DISTINCT FROM NEW.refund_obligation_minor THEN
      RAISE EXCEPTION 'billing credit-note refund does not match its patient obligation'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER billing_credit_note_context
  BEFORE INSERT OR UPDATE ON billing_credit_notes
  FOR EACH ROW EXECUTE FUNCTION billing_credit_note_require_context();

CREATE OR REPLACE FUNCTION billing_credit_note_require_lifecycle_event()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
DECLARE
  required_event VARCHAR(30);
  required_actor UUID;
BEGIN
  required_event := 'raised';
  required_actor := NEW.raised_by;
  IF NOT EXISTS (
    SELECT 1
      FROM billing_credit_note_events event
     WHERE event.tenant_id = NEW.tenant_id
       AND event.credit_note_id = NEW.id
       AND event.event_type = required_event
       AND event.actor_uid = required_actor
  ) THEN
    RAISE EXCEPTION 'billing credit-note state has no matching raised event'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status IN ('approved', 'applied') AND NOT EXISTS (
    SELECT 1
      FROM billing_credit_note_events event
     WHERE event.tenant_id = NEW.tenant_id
       AND event.credit_note_id = NEW.id
       AND event.event_type = 'approved'
       AND event.actor_uid = NEW.approved_by
  ) THEN
    RAISE EXCEPTION 'billing credit-note state has no matching approval event'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'rejected' AND NOT EXISTS (
    SELECT 1
      FROM billing_credit_note_events event
     WHERE event.tenant_id = NEW.tenant_id
       AND event.credit_note_id = NEW.id
       AND event.event_type = 'rejected'
       AND event.actor_uid = NEW.rejected_by
  ) THEN
    RAISE EXCEPTION 'billing credit-note state has no matching rejection event'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'applied' AND NOT EXISTS (
    SELECT 1
      FROM billing_credit_note_events event
     WHERE event.tenant_id = NEW.tenant_id
       AND event.credit_note_id = NEW.id
       AND event.event_type = 'applied'
       AND event.actor_uid = NEW.applied_by
  ) THEN
    RAISE EXCEPTION 'billing credit-note state has no matching application event'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$fn$;

CREATE CONSTRAINT TRIGGER billing_credit_note_lifecycle_event
  AFTER INSERT OR UPDATE OF status ON billing_credit_notes
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION billing_credit_note_require_lifecycle_event();

-- ---------------------------------------------------------------------------
-- Tenant isolation and append-only safety
-- ---------------------------------------------------------------------------

ALTER TABLE ward_indent_inventory_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ward_indent_inventory_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ward_indent_inventory_allocations
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
CREATE POLICY explicit_tenant_context ON ward_indent_inventory_allocations
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

ALTER TABLE ward_indent_inventory_movement_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE ward_indent_inventory_movement_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ward_indent_inventory_movement_links
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
CREATE POLICY explicit_tenant_context ON ward_indent_inventory_movement_links
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

ALTER TABLE mar_supply_consumptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mar_supply_consumptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mar_supply_consumptions
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
CREATE POLICY explicit_tenant_context ON mar_supply_consumptions
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

ALTER TABLE mar_administration_command_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE mar_administration_command_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mar_administration_command_receipts
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
CREATE POLICY explicit_tenant_context ON mar_administration_command_receipts
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

ALTER TABLE mar_transition_command_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE mar_transition_command_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mar_transition_command_receipts
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
CREATE POLICY explicit_tenant_context ON mar_transition_command_receipts
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

ALTER TABLE mar_supply_reconciliation_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE mar_supply_reconciliation_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mar_supply_reconciliation_links
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
CREATE POLICY explicit_tenant_context ON mar_supply_reconciliation_links
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

ALTER TABLE ward_indent_financial_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ward_indent_financial_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ward_indent_financial_events
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
CREATE POLICY explicit_tenant_context ON ward_indent_financial_events
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

ALTER TABLE billing_credit_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_credit_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON billing_credit_notes
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
CREATE POLICY explicit_tenant_context ON billing_credit_notes
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

ALTER TABLE billing_credit_note_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_credit_note_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON billing_credit_note_events
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
CREATE POLICY explicit_tenant_context ON billing_credit_note_events
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

-- Ward-medication tasks are typed, domain-evidence obligations. Migration 580's
-- rolling compatibility trigger intentionally rejects unknown SLA contracts,
-- so MED-03 adds a narrow contract handler instead of weakening that guard.
CREATE OR REPLACE FUNCTION ward_medication_tasks_sync_workflow_sla_compat()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  sla_record workflow_sla_instances%ROWTYPE;
  metadata_value JSONB := COALESCE(NEW.metadata, '{}'::jsonb);
BEGIN
  IF jsonb_typeof(metadata_value) IS DISTINCT FROM 'object'
     OR metadata_value->>'task_contract' IS DISTINCT FROM 'ward_medication_obligation_v1'
  THEN
    RAISE EXCEPTION
      'ward medication task metadata contract is invalid'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.workflow_sla_instance_id IS NULL
     OR NEW.sla_completion_semantics IS DISTINCT FROM 'domain_evidence'
     OR NULLIF(BTRIM(NEW.related_resource_type), '') IS NULL
     OR NULLIF(BTRIM(NEW.related_resource_id), '') IS NULL
  THEN
    RAISE EXCEPTION
      'ward medication task requires a typed domain-evidence SLA source'
      USING ERRCODE = 'check_violation';
  END IF;

  IF metadata_value ? 'requested_sla_key'
     OR metadata_value ? 'sla_policy_status'
  THEN
    RAISE EXCEPTION
      'ward medication task cannot use a degraded SLA policy marker'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT sla.*
    INTO sla_record
    FROM workflow_sla_instances sla
   WHERE sla.tenant_id = NEW.tenant_id
     AND sla.id = NEW.workflow_sla_instance_id
   FOR KEY SHARE;

  IF NOT FOUND
     OR sla_record.rule_code NOT IN (
       'ward_indent_pharmacy_response',
       'ward_indent_substitution_authorization',
       'ward_indent_controlled_handoff',
       'ward_indent_pharmacy_issue',
       'ward_indent_ward_receipt',
       'ward_indent_reconciliation',
       'ward_indent_mar_supply_reconciliation',
       'ward_indent_credit_note_review',
       'ward_indent_notification_coverage'
     )
     OR sla_record.source_table IS DISTINCT FROM NEW.related_resource_type
     OR sla_record.source_id IS DISTINCT FROM NEW.related_resource_id
     OR sla_record.due_at IS NULL
  THEN
    RAISE EXCEPTION
      'ward medication task and linked SLA do not describe the same obligation'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.encounter_id IS NOT NULL
     OR NULLIF(
          LOWER(BTRIM(metadata_value->>'canonical_encounter_id')),
          ''
        ) IS DISTINCT FROM sla_record.encounter_id::text
  THEN
    RAISE EXCEPTION
      'ward medication task canonical encounter must equal its linked SLA encounter'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status IN ('open', 'in_progress', 'blocked', 'overdue')
     AND (
       sla_record.completed_at IS NOT NULL
       OR sla_record.status NOT IN ('active', 'breached', 'escalated')
     )
  THEN
    RAISE EXCEPTION
      'actionable ward medication task requires an incomplete SLA clock'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.workflow_sla_instance_id IS NOT NULL
     AND NEW.workflow_sla_instance_id IS DISTINCT FROM OLD.workflow_sla_instance_id
  THEN
    RAISE EXCEPTION
      'ward medication task SLA links are immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.status IS DISTINCT FROM 'cancelled'
     AND NEW.status = 'cancelled'
     AND sla_record.completed_at IS NULL
  THEN
    RAISE EXCEPTION
      'ward medication task cannot be cancelled while its SLA is incomplete'
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.due_at := sla_record.due_at;
  NEW.metadata := metadata_value
    || jsonb_build_object(
         'sla_instance_id', sla_record.id::text,
         'sla_key', sla_record.rule_code
       );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tasks_workflow_sla_compat_insert ON tasks;
CREATE TRIGGER trg_tasks_workflow_sla_compat_insert
  BEFORE INSERT ON tasks
  FOR EACH ROW
  WHEN (COALESCE(NEW.metadata->>'task_contract', '') <> 'ward_medication_obligation_v1')
  EXECUTE FUNCTION tasks_sync_workflow_sla_compat();

DROP TRIGGER IF EXISTS trg_tasks_workflow_sla_compat_update ON tasks;
CREATE TRIGGER trg_tasks_workflow_sla_compat_update
  BEFORE UPDATE OF
    tenant_id,
    status,
    workflow_step_id,
    related_resource_type,
    related_resource_id,
    workflow_sla_instance_id,
    sla_completion_semantics,
    due_at,
    metadata
  ON tasks
  FOR EACH ROW
  WHEN (COALESCE(NEW.metadata->>'task_contract', '') <> 'ward_medication_obligation_v1')
  EXECUTE FUNCTION tasks_sync_workflow_sla_compat();

CREATE TRIGGER trg_tasks_workflow_sla_compat_med03_insert
  BEFORE INSERT ON tasks
  FOR EACH ROW
  WHEN (NEW.metadata->>'task_contract' = 'ward_medication_obligation_v1')
  EXECUTE FUNCTION ward_medication_tasks_sync_workflow_sla_compat();

CREATE TRIGGER trg_tasks_workflow_sla_compat_med03_update
  BEFORE UPDATE OF
    tenant_id,
    status,
    workflow_step_id,
    encounter_id,
    related_resource_type,
    related_resource_id,
    workflow_sla_instance_id,
    sla_completion_semantics,
    due_at,
    metadata
  ON tasks
  FOR EACH ROW
  WHEN (NEW.metadata->>'task_contract' = 'ward_medication_obligation_v1')
  EXECUTE FUNCTION ward_medication_tasks_sync_workflow_sla_compat();

CREATE OR REPLACE FUNCTION care_pathway_assert_task_sla_source_binding(
  target_tenant_id UUID,
  target_task_id INTEGER
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  task_record tasks%ROWTYPE;
  sla_record workflow_sla_instances%ROWTYPE;
  valid_binding BOOLEAN := FALSE;
BEGIN
  SELECT task.*
    INTO task_record
    FROM tasks AS task
   WHERE task.tenant_id = target_tenant_id
     AND task.id = target_task_id;

  IF NOT FOUND OR task_record.workflow_sla_instance_id IS NULL THEN
    RETURN;
  END IF;

  SELECT sla.*
    INTO sla_record
    FROM workflow_sla_instances AS sla
   WHERE sla.tenant_id = task_record.tenant_id
     AND sla.id = task_record.workflow_sla_instance_id;

  IF FOUND AND (
    task_record.metadata->>'sla_instance_id'
      IS DISTINCT FROM task_record.workflow_sla_instance_id::text
    OR NULLIF(BTRIM(task_record.metadata->>'sla_key'), '')
      IS DISTINCT FROM sla_record.rule_code
  ) THEN
    RAISE EXCEPTION
      'typed task SLA legacy aliases must equal the linked instance and rule'
      USING ERRCODE = 'check_violation';
  END IF;

  IF FOUND AND task_record.due_at IS NULL THEN
    RAISE EXCEPTION
      'linked task deadline must be present'
      USING ERRCODE = 'check_violation';
  END IF;

  IF FOUND
     AND task_record.status IN ('open', 'in_progress', 'blocked', 'overdue')
     AND (
       sla_record.due_at IS NULL
       OR task_record.due_at IS DISTINCT FROM sla_record.due_at
     )
  THEN
    RAISE EXCEPTION
      'task and linked SLA deadlines must both be present and exactly equal'
      USING ERRCODE = 'check_violation';
  END IF;

  IF FOUND
     AND task_record.sla_completion_semantics = 'acknowledgement'
     AND task_record.status = 'in_progress'
     AND sla_record.completed_at IS NULL
  THEN
    RAISE EXCEPTION
      'acknowledged task must have a completed linked SLA clock'
      USING ERRCODE = 'check_violation';
  END IF;

  IF FOUND
     AND task_record.sla_completion_semantics = 'acknowledgement'
     AND task_record.status IN ('open', 'blocked', 'overdue')
     AND (
       sla_record.completed_at IS NOT NULL
       OR sla_record.status NOT IN ('active', 'breached', 'escalated')
     )
  THEN
    RAISE EXCEPTION
      'actionable acknowledgement task must have an incomplete linked SLA clock'
      USING ERRCODE = 'check_violation';
  END IF;

  IF FOUND AND task_record.workflow_step_id IS NOT NULL THEN
    valid_binding := task_record.sla_completion_semantics
        IN ('acknowledgement', 'domain_evidence')
      AND sla_record.source_table IS NOT DISTINCT FROM 'workflow_steps'
      AND sla_record.source_id IS NOT DISTINCT FROM task_record.workflow_step_id::text;
  ELSIF FOUND
        AND sla_record.rule_code IN ('critical_result_ack', 'cold_chain_excursion_ack')
  THEN
    valid_binding := task_record.sla_completion_semantics = 'acknowledgement'
      AND NULLIF(BTRIM(task_record.related_resource_type), '') IS NOT NULL
      AND NULLIF(BTRIM(task_record.related_resource_id), '') IS NOT NULL
      AND sla_record.source_table IS NOT DISTINCT FROM task_record.related_resource_type
      AND sla_record.source_id IS NOT DISTINCT FROM task_record.related_resource_id;
  ELSIF FOUND AND sla_record.rule_code = 'mortuary_unclaimed_body' THEN
    valid_binding := task_record.sla_completion_semantics = 'domain_evidence'
      AND task_record.related_resource_type IS NOT DISTINCT FROM 'death_record'
      AND NULLIF(BTRIM(task_record.related_resource_id), '') IS NOT NULL
      AND sla_record.source_table IS NOT DISTINCT FROM 'death_records'
      AND sla_record.source_id IS NOT DISTINCT FROM task_record.related_resource_id
      AND EXISTS (
        SELECT 1
          FROM death_records AS death_record
         WHERE death_record.tenant_id = task_record.tenant_id
           AND death_record.id::text = task_record.related_resource_id
      );
  ELSIF FOUND
        AND sla_record.rule_code IN (
          'ward_indent_pharmacy_response',
          'ward_indent_substitution_authorization',
          'ward_indent_controlled_handoff',
          'ward_indent_pharmacy_issue',
          'ward_indent_ward_receipt',
          'ward_indent_reconciliation',
          'ward_indent_mar_supply_reconciliation',
          'ward_indent_credit_note_review',
          'ward_indent_notification_coverage'
        )
  THEN
    valid_binding := task_record.sla_completion_semantics = 'domain_evidence'
      AND task_record.metadata->>'task_contract'
        IS NOT DISTINCT FROM 'ward_medication_obligation_v1'
      AND NULLIF(BTRIM(task_record.related_resource_type), '') IS NOT NULL
      AND NULLIF(BTRIM(task_record.related_resource_id), '') IS NOT NULL
      AND sla_record.source_table IS NOT DISTINCT FROM task_record.related_resource_type
      AND sla_record.source_id IS NOT DISTINCT FROM task_record.related_resource_id;
  END IF;

  IF NOT valid_binding THEN
    RAISE EXCEPTION
      'task and linked SLA source do not describe the same obligation'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

ALTER FUNCTION care_pathway_assert_task_sla_completion_receipt(UUID, INTEGER)
  RENAME TO care_pathway_assert_task_sla_completion_receipt_pre_med03;

CREATE OR REPLACE FUNCTION care_pathway_assert_task_sla_completion_receipt(
  target_tenant_id UUID,
  target_task_id INTEGER
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  task_record tasks%ROWTYPE;
  sla_record workflow_sla_instances%ROWTYPE;
  evidence JSONB;
  completed_by_text TEXT;
  evidence_timestamp TIMESTAMPTZ;
BEGIN
  SELECT task.*
    INTO task_record
    FROM tasks task
   WHERE task.tenant_id = target_tenant_id
     AND task.id = target_task_id;

  IF NOT FOUND
     OR task_record.metadata->>'task_contract'
       IS DISTINCT FROM 'ward_medication_obligation_v1'
  THEN
    PERFORM care_pathway_assert_task_sla_completion_receipt_pre_med03(
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

  IF NOT FOUND
     OR task_record.sla_completion_semantics IS DISTINCT FROM 'domain_evidence'
     OR task_record.due_at IS DISTINCT FROM sla_record.due_at
  THEN
    RAISE EXCEPTION
      'ward medication task has no exact typed SLA receipt contract'
      USING ERRCODE = 'check_violation';
  END IF;

  IF task_record.status IN ('open', 'in_progress', 'blocked', 'overdue') THEN
    IF sla_record.completed_at IS NOT NULL
       OR sla_record.status NOT IN ('active', 'breached', 'escalated')
       OR COALESCE(sla_record.metadata, '{}'::jsonb) ?| ARRAY[
            'completed_via',
            'completed_by_task',
            'completed_by',
            'completion_evidence'
          ]
    THEN
      RAISE EXCEPTION
        'actionable ward medication task must have a clean incomplete SLA clock'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN;
  END IF;

  evidence := sla_record.metadata->'completion_evidence';
  completed_by_text := NULLIF(BTRIM(sla_record.metadata->>'completed_by'), '');
  IF task_record.status IS DISTINCT FROM 'completed'
     OR sla_record.completed_at IS NULL
     OR sla_record.status NOT IN ('completed', 'breached', 'escalated')
     OR sla_record.metadata->>'completed_via' IS DISTINCT FROM 'domain_evidence'
     OR sla_record.metadata->>'completed_by_task' IS DISTINCT FROM task_record.id::text
     OR jsonb_typeof(evidence) IS DISTINCT FROM 'object'
     OR completed_by_text IS NULL
     OR completed_by_text !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR NOT pg_input_is_valid(completed_by_text, 'uuid')
     OR NOT EXISTS (
       SELECT 1
         FROM users actor
        WHERE actor.tenant_id = task_record.tenant_id
          AND actor.uid::text = LOWER(completed_by_text)
     )
     OR evidence->>'resource_id' !~ '^[1-9][0-9]*$'
     OR NOT pg_input_is_valid(evidence->>'resource_id', 'bigint')
     OR evidence->>'occurred_at' !~
          '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
     OR NOT pg_input_is_valid(evidence->>'occurred_at', 'timestamp with time zone')
     OR evidence->>'recorded_at' !~
          '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
     OR NOT pg_input_is_valid(evidence->>'recorded_at', 'timestamp with time zone')
  THEN
    RAISE EXCEPTION
      'terminal ward medication task requires an authenticated domain receipt'
      USING ERRCODE = 'check_violation';
  END IF;

  evidence_timestamp := (evidence->>'recorded_at')::timestamptz;
  IF date_trunc('milliseconds', sla_record.completed_at)
       IS DISTINCT FROM date_trunc('milliseconds', evidence_timestamp)
  THEN
    RAISE EXCEPTION
      'ward medication SLA completion time must equal its recorded evidence time'
      USING ERRCODE = 'check_violation';
  END IF;

  IF evidence->>'kind' = 'ward_indent_transition' THEN
    IF evidence->>'resource_type' IS DISTINCT FROM 'ward_indent_event'
       OR task_record.metadata->>'ward_indent_id' !~ '^[1-9][0-9]*$'
       OR task_record.metadata->>'state_version' !~ '^[1-9][0-9]*$'
       OR NULLIF(BTRIM(task_record.metadata->>'current_state'), '') IS NULL
       OR NOT EXISTS (
         SELECT 1
           FROM ward_indent_events event
          WHERE event.tenant_id = task_record.tenant_id
            AND event.id = (evidence->>'resource_id')::bigint
            AND event.ward_indent_id::text = task_record.metadata->>'ward_indent_id'
            AND event.state_version > (task_record.metadata->>'state_version')::integer
            AND event.from_status = task_record.metadata->>'current_state'
            AND event.action = evidence->>'action'
            AND event.to_status = evidence->>'to_status'
            AND event.actor_uid::text = LOWER(completed_by_text)
            AND date_trunc('milliseconds', event.occurred_at) =
                  date_trunc('milliseconds', (evidence->>'occurred_at')::timestamptz)
            AND date_trunc('milliseconds', event.occurred_at) =
                  date_trunc('milliseconds', evidence_timestamp)
       )
    THEN
      RAISE EXCEPTION
        'ward indent task receipt does not match its transition event'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN;
  END IF;

  IF evidence->>'kind' = 'billing_credit_note_decision' THEN
    IF evidence->>'resource_type' IS DISTINCT FROM 'billing_credit_note_event'
       OR task_record.metadata->>'obligation_kind' IS DISTINCT FROM 'credit_note_review'
       OR task_record.metadata->>'credit_note_id' !~ '^[1-9][0-9]*$'
       OR evidence->>'decision' NOT IN ('approved', 'rejected')
       OR NOT EXISTS (
         SELECT 1
           FROM billing_credit_note_events event
          WHERE event.tenant_id = task_record.tenant_id
            AND event.id = (evidence->>'resource_id')::bigint
            AND event.credit_note_id::text = task_record.metadata->>'credit_note_id'
            AND event.event_type = evidence->>'decision'
            AND event.actor_uid::text = LOWER(completed_by_text)
            AND date_trunc('milliseconds', event.occurred_at) =
                  date_trunc('milliseconds', evidence_timestamp)
       )
    THEN
      RAISE EXCEPTION
        'credit-note task receipt does not match its decision event'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN;
  END IF;

  IF evidence->>'kind' = 'mar_supply_reconciled' THEN
    IF evidence->>'resource_type' IS DISTINCT FROM 'mar_supply_reconciliation_link'
       OR task_record.metadata->>'obligation_kind'
            IS DISTINCT FROM 'mar_supply_reconciliation'
       OR task_record.metadata->>'medication_administration_id' !~ '^[1-9][0-9]*$'
       OR NOT EXISTS (
         SELECT 1
           FROM mar_supply_reconciliation_links link
           JOIN mar_supply_consumptions consumption
             ON consumption.tenant_id = link.tenant_id
            AND consumption.id = link.unmatched_consumption_id
          WHERE link.tenant_id = task_record.tenant_id
            AND link.id = (evidence->>'resource_id')::bigint
            AND link.reconciled_by::text = LOWER(completed_by_text)
            AND consumption.evidence_status = 'unmatched_override'
            AND consumption.reconciliation_task_id = task_record.id
            AND consumption.medication_administration_id::text =
                  task_record.metadata->>'medication_administration_id'
            AND (
              SELECT COALESCE(SUM(all_links.quantity), 0)
                FROM mar_supply_reconciliation_links all_links
               WHERE all_links.tenant_id = consumption.tenant_id
                 AND all_links.unmatched_consumption_id = consumption.id
            ) = consumption.quantity
            AND date_trunc('milliseconds', link.created_at) =
                  date_trunc('milliseconds', evidence_timestamp)
       )
    THEN
      RAISE EXCEPTION
        'MAR supply task receipt does not match complete reconciliation evidence'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN;
  END IF;

  IF evidence->>'kind' = 'notification_coverage_restored' THEN
    IF evidence->>'resource_type' IS DISTINCT FROM 'notification_outbox'
       OR task_record.metadata->>'obligation_kind'
            IS DISTINCT FROM 'notification_coverage'
       OR NOT EXISTS (
         SELECT 1
           FROM notification_outbox outbox
          WHERE outbox.tenant_id = task_record.tenant_id
            AND outbox.id = (evidence->>'resource_id')::bigint
            AND outbox.recipient_id IS NOT NULL
            AND outbox.payload->>'coverage_task_id' = task_record.id::text
            AND date_trunc('milliseconds', outbox.created_at) =
                  date_trunc('milliseconds', evidence_timestamp)
       )
    THEN
      RAISE EXCEPTION
        'notification coverage task receipt does not match its durable intent'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN;
  END IF;

  RAISE EXCEPTION
    'ward medication task source is not a registered completion contract'
    USING ERRCODE = 'check_violation';
END;
$$;

-- ---------------------------------------------------------------------------
-- Runtime role privileges
-- ---------------------------------------------------------------------------

DO $med03_runtime_privileges$
DECLARE
  runtime_role TEXT;
  relation_name TEXT;
  sequence_name TEXT;
  trigger_function_name TEXT;
  mutable_relations CONSTANT TEXT[] := ARRAY[
    'ward_indent_inventory_allocations',
    'billing_credit_notes'
  ];
  append_only_relations CONSTANT TEXT[] := ARRAY[
    'ward_indent_inventory_movement_links',
    'mar_supply_consumptions',
    'mar_administration_command_receipts',
    'mar_transition_command_receipts',
    'mar_supply_reconciliation_links',
    'ward_indent_financial_events',
    'billing_credit_note_events'
  ];
  trigger_functions CONSTANT TEXT[] := ARRAY[
    'medication_administration_require_order_context',
    'ward_indent_apply_inventory_movement_link',
    'mar_supply_apply_custody_consumption',
    'mar_administration_command_receipt_validate',
    'mar_transition_command_receipt_validate',
    'mar_supply_apply_reconciliation_link',
    'ward_indent_validate_financial_event_lineage',
    'billing_credit_note_require_context',
    'billing_credit_note_require_lifecycle_event',
    'ward_medication_tasks_sync_workflow_sla_compat'
  ];
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['vhhealth_app', 'vhhealth_runtime']::TEXT[]
  LOOP
    IF pg_catalog.to_regrole(runtime_role) IS NULL THEN
      CONTINUE;
    END IF;

    FOREACH relation_name IN ARRAY mutable_relations
    LOOP
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I',
        relation_name,
        runtime_role
      );
      EXECUTE pg_catalog.format(
        'GRANT SELECT, INSERT, UPDATE ON TABLE public.%I TO %I',
        relation_name,
        runtime_role
      );
    END LOOP;

    FOREACH relation_name IN ARRAY append_only_relations
    LOOP
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I',
        relation_name,
        runtime_role
      );
      EXECUTE pg_catalog.format(
        'GRANT SELECT, INSERT ON TABLE public.%I TO %I',
        relation_name,
        runtime_role
      );
    END LOOP;

    FOREACH relation_name IN ARRAY (mutable_relations || append_only_relations)
    LOOP
      sequence_name := relation_name || '_id_seq';
      IF pg_catalog.to_regclass(pg_catalog.format('public.%I', sequence_name)) IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON SEQUENCE public.%I FROM %I',
          sequence_name,
          runtime_role
        );
        EXECUTE pg_catalog.format(
          'GRANT USAGE, SELECT ON SEQUENCE public.%I TO %I',
          sequence_name,
          runtime_role
        );
      END IF;
    END LOOP;

    FOREACH trigger_function_name IN ARRAY trigger_functions
    LOOP
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.%I() FROM %I',
        trigger_function_name,
        runtime_role
      );
    END LOOP;
  END LOOP;

  FOREACH trigger_function_name IN ARRAY trigger_functions
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.%I() FROM PUBLIC',
      trigger_function_name
    );
  END LOOP;
END
$med03_runtime_privileges$;

-- ---------------------------------------------------------------------------
-- SLA defaults for newly owned medication-closure work
-- ---------------------------------------------------------------------------

INSERT INTO workflow_sla_rules
  (tenant_id, rule_code, title, trigger_event_type, target_minutes, severity,
   owner_role_codes, escalation_role_codes, metadata)
VALUES
  (NULL, 'ward_indent_mar_supply_reconciliation',
   'MAR supply evidence reconciliation', 'mar.supply_override', 30, 'critical',
   ARRAY['NURSING_INCHARGE', 'IP_INCHARGE', 'PHARMACY_INCHARGE']::TEXT[],
   ARRAY['MEDICAL_SUPERINTENDENT', 'ADMIN']::TEXT[],
   '{"med_03":true,"surface":"mar_supply"}'::jsonb),
  (NULL, 'ward_indent_credit_note_review',
   'Ward medication credit-note review', 'ward_indent.credit_created', 1440, 'high',
   ARRAY['BILLING_INCHARGE', 'FINANCE_INCHARGE']::TEXT[],
   ARRAY['FINANCE_INCHARGE', 'ADMIN', 'SUPER_ADMIN']::TEXT[],
   '{"med_03":true,"surface":"billing_credit_note"}'::jsonb),
  (NULL, 'ward_indent_notification_coverage',
   'Ward medication notification recipient coverage',
   'ward_indent.notification_coverage_gap', 15, 'critical',
   ARRAY['ADMIN', 'SUPER_ADMIN']::TEXT[],
   ARRAY['SUPER_ADMIN', 'MEDICAL_SUPERINTENDENT']::TEXT[],
   '{"med_03":true,"surface":"notification_coverage"}'::jsonb)
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
  enabled = TRUE,
  updated_at = NOW();

COMMIT;
