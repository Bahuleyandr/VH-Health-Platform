-- Migration 741: MED-01 ward-indent authoritative state machine.
--
-- Migration 740 is independently owned by the open SAFE-01 lab-threshold
-- governance PR. This file has no dependency on it and deliberately takes the
-- next free number so the two branches cannot collide.
--
-- The legacy ward-indent row carried only requested/approved/issued/received
-- and one issued quantity. That was not enough to prove reservation,
-- short-supply/substitution decisions, controlled-drug handoff, partial ward
-- receipt, return reconciliation, ownership, or closure. This migration keeps
-- every legacy row, backfills its effective quantities, and adds an append-only
-- command ledger plus canonical workflow-SLA defaults. It does not enable the
-- parked PHARMACY_WARD_INDENT_PUSH_ENABLED dispatch surface.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS ux_billing_invoice_items_ward_indent
  ON billing_invoice_items (tenant_id, source_ref_type, source_ref_id)
  WHERE source_ref_type = 'ward_indent'
    AND source_ref_id IS NOT NULL
    AND source_ref_active;

ALTER TABLE ward_indents
  ALTER COLUMN status TYPE VARCHAR(40),
  ADD COLUMN IF NOT EXISTS state_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS owner_role_codes TEXT[] NOT NULL
    DEFAULT ARRAY['PHARMACY_STAFF', 'PHARMACY_INCHARGE', 'PHARMACIST']::TEXT[],
  ADD COLUMN IF NOT EXISTS active_sla_source_id VARCHAR(120),
  ADD COLUMN IF NOT EXISTS last_transition_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS short_supply_reason TEXT,
  ADD COLUMN IF NOT EXISTS return_requested_by UUID,
  ADD COLUMN IF NOT EXISTS return_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reconciliation_reason TEXT,
  ADD COLUMN IF NOT EXISTS reconciled_by UUID,
  ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by UUID,
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancellation_reason TEXT,
  ADD COLUMN IF NOT EXISTS closed_by UUID,
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closure_outcome VARCHAR(40),
  ADD COLUMN IF NOT EXISTS closure_reason TEXT;

-- The inline migration-174 CHECK is absent on databases bootstrapped from the
-- current baseline, but can still exist on older upgraded databases. Drop only
-- checks whose expression actually constrains ward_indents.status.
DO $do$
DECLARE
  constraint_row RECORD;
BEGIN
  FOR constraint_row IN
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class rel ON rel.oid = c.conrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
     WHERE nsp.nspname = 'public'
       AND rel.relname = 'ward_indents'
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) ~* '\mstatus\M'
  LOOP
    EXECUTE format('ALTER TABLE public.ward_indents DROP CONSTRAINT %I', constraint_row.conname);
  END LOOP;
END
$do$;

UPDATE ward_indents
   SET active_sla_source_id = CASE
         WHEN status IN ('rejected', 'cancelled', 'closed') THEN NULL
         ELSE CONCAT('ward-indent:', id, ':v', state_version)
       END,
       owner_role_codes = CASE
         WHEN status IN ('rejected', 'cancelled', 'closed') THEN ARRAY[]::TEXT[]
         WHEN status IN ('issued', 'partially_received') THEN
           ARRAY['NURSING_STAFF', 'NURSING_INCHARGE', 'IP_STAFF_NURSE', 'IP_INCHARGE',
                 'ICU_NURSE', 'ICU_INCHARGE', 'ICU_STAFF', 'ER_STAFF']::TEXT[]
         WHEN status IN ('received', 'return_pending', 'reconciliation_required', 'reconciled') THEN
           ARRAY['PHARMACY_INCHARGE', 'NURSING_INCHARGE', 'IP_INCHARGE', 'ICU_INCHARGE']::TEXT[]
         ELSE ARRAY['PHARMACY_STAFF', 'PHARMACY_INCHARGE', 'PHARMACIST']::TEXT[]
       END,
       last_transition_at = CASE status
         WHEN 'received' THEN COALESCE(received_at, issued_at, approved_at, requested_at, created_at)
         WHEN 'issued' THEN COALESCE(issued_at, approved_at, requested_at, created_at)
         WHEN 'approved' THEN COALESCE(approved_at, requested_at, created_at)
         WHEN 'rejected' THEN COALESCE(approved_at, requested_at, created_at)
         ELSE COALESCE(requested_at, created_at)
       END;

UPDATE ward_indents indent
   SET patient_uid = admission.patient_uid,
       encounter_id = COALESCE(indent.encounter_id, admission.encounter_id),
       updated_at = NOW()
  FROM admissions admission
 WHERE indent.admission_id = admission.id
   AND indent.tenant_id = admission.tenant_id
   AND indent.patient_uid IS NULL;

DO $do$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM ward_indents indent
      JOIN admissions admission
        ON admission.tenant_id = indent.tenant_id
       AND admission.id = indent.admission_id
     WHERE indent.patient_uid IS DISTINCT FROM admission.patient_uid
        OR (
          admission.encounter_id IS NOT NULL
          AND indent.encounter_id IS DISTINCT FROM admission.encounter_id
        )
  ) THEN
    RAISE EXCEPTION 'ward indent admission patient or encounter context is inconsistent';
  END IF;
END
$do$;

CREATE OR REPLACE FUNCTION ward_indent_require_admission_context()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
DECLARE
  admission_patient_uid UUID;
  admission_encounter_id UUID;
BEGIN
  IF NEW.admission_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT admission.patient_uid, admission.encounter_id
    INTO admission_patient_uid, admission_encounter_id
    FROM admissions admission
   WHERE admission.tenant_id = NEW.tenant_id
     AND admission.id = NEW.admission_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ward indent admission is missing from the same tenant'
      USING ERRCODE = '23503';
  END IF;
  IF NEW.patient_uid IS DISTINCT FROM admission_patient_uid THEN
    RAISE EXCEPTION 'ward indent patient must match the linked admission patient'
      USING ERRCODE = '23514';
  END IF;
  IF admission_encounter_id IS NOT NULL
     AND NEW.encounter_id IS DISTINCT FROM admission_encounter_id THEN
    RAISE EXCEPTION 'ward indent encounter must match the linked admission encounter'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS ward_indent_admission_context ON ward_indents;
CREATE TRIGGER ward_indent_admission_context
  BEFORE INSERT OR UPDATE OF tenant_id, admission_id, patient_uid, encounter_id
  ON ward_indents
  FOR EACH ROW EXECUTE FUNCTION ward_indent_require_admission_context();

ALTER TABLE ward_indents
  ADD CONSTRAINT ward_indents_status_v2_check CHECK (status IN (
    'requested',
    'reserved',
    'short_supply',
    'substitution_pending',
    'controlled_handoff_required',
    'approved',
    'issued',
    'partially_received',
    'received',
    'return_pending',
    'reconciliation_required',
    'reconciled',
    'rejected',
    'cancelled',
    'closed'
  )),
  ADD CONSTRAINT ward_indents_state_version_positive_check
    CHECK (state_version > 0),
  ADD CONSTRAINT ward_indents_active_sla_source_nonblank_check
    CHECK (active_sla_source_id IS NULL OR BTRIM(active_sla_source_id) <> ''),
  ADD CONSTRAINT ward_indents_active_sla_state_check CHECK (
    (status IN ('rejected', 'cancelled', 'closed') AND active_sla_source_id IS NULL)
    OR
    (status NOT IN ('rejected', 'cancelled', 'closed') AND active_sla_source_id IS NOT NULL)
  ),
  ADD CONSTRAINT ward_indents_closure_outcome_check CHECK (
    closure_outcome IS NULL OR closure_outcome IN (
      'fulfilled', 'returned_reconciled', 'variance_reconciled',
      'reconciliation_completed'
    )
  );

-- Preserve compatibility with legacy bulk loaders and test fixtures that
-- insert a state directly instead of calling the service. The trigger projects
-- the state-owned role set and a durable source identity before CHECK
-- constraints run. It does not manufacture transition events or SLA rows;
-- application writes still go through the authoritative service for those
-- effects.
CREATE OR REPLACE FUNCTION ward_indent_project_state_defaults()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.owner_role_codes := CASE
      WHEN NEW.status IN ('rejected', 'cancelled', 'closed') THEN ARRAY[]::TEXT[]
      WHEN NEW.status = 'substitution_pending' THEN
        ARRAY['DOCTOR', 'DUTY_DOCTOR', 'CONSULTANT', 'JUNIOR_DOCTOR', 'RESIDENT']::TEXT[]
      WHEN NEW.status IN ('issued', 'partially_received') THEN
        ARRAY['NURSING_STAFF', 'NURSING_INCHARGE', 'IP_STAFF_NURSE', 'IP_INCHARGE',
              'ICU_NURSE', 'ICU_INCHARGE', 'ICU_STAFF', 'ER_STAFF']::TEXT[]
      WHEN NEW.status IN ('received', 'return_pending', 'reconciliation_required', 'reconciled') THEN
        ARRAY['PHARMACY_INCHARGE', 'NURSING_INCHARGE', 'IP_INCHARGE', 'ICU_INCHARGE']::TEXT[]
      ELSE ARRAY['PHARMACY_STAFF', 'PHARMACY_INCHARGE', 'PHARMACIST']::TEXT[]
    END;
  END IF;

  IF NEW.status IN ('rejected', 'cancelled', 'closed') THEN
    NEW.active_sla_source_id := NULL;
  ELSIF NEW.active_sla_source_id IS NULL THEN
    NEW.active_sla_source_id := CONCAT('ward-indent:', NEW.id, ':v', NEW.state_version);
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS ward_indent_project_state_defaults ON ward_indents;
CREATE TRIGGER ward_indent_project_state_defaults
  BEFORE INSERT OR UPDATE OF status, state_version, active_sla_source_id
  ON ward_indents
  FOR EACH ROW EXECUTE FUNCTION ward_indent_project_state_defaults();

ALTER TABLE ward_indent_items
  ADD COLUMN IF NOT EXISTS original_pharmacy_catalog_id INTEGER,
  ADD COLUMN IF NOT EXISTS original_item_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS quantity_reserved NUMERIC(10, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quantity_approved NUMERIC(10, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quantity_received NUMERIC(10, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quantity_variance_resolved NUMERIC(10, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quantity_return_requested NUMERIC(10, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quantity_returned NUMERIC(10, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reconciliation_disposition VARCHAR(40),
  ADD COLUMN IF NOT EXISTS reconciliation_note TEXT,
  ADD COLUMN IF NOT EXISTS fulfilment_status VARCHAR(40) NOT NULL DEFAULT 'requested',
  ADD COLUMN IF NOT EXISTS proposed_pharmacy_catalog_id INTEGER,
  ADD COLUMN IF NOT EXISTS proposed_item_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS proposed_quantity NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS clinical_order_id INTEGER,
  ADD COLUMN IF NOT EXISTS substitution_status VARCHAR(20),
  ADD COLUMN IF NOT EXISTS substitution_reason TEXT,
  ADD COLUMN IF NOT EXISTS substitution_proposed_by UUID,
  ADD COLUMN IF NOT EXISTS substitution_proposed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS substitution_decided_by UUID,
  ADD COLUMN IF NOT EXISTS substitution_decided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS controlled_reference_id VARCHAR(120),
  ADD COLUMN IF NOT EXISTS controlled_movement_id INTEGER,
  ADD COLUMN IF NOT EXISTS controlled_register_id INTEGER,
  ADD COLUMN IF NOT EXISTS controlled_return_movement_id INTEGER,
  ADD COLUMN IF NOT EXISTS controlled_return_register_id INTEGER;

UPDATE ward_indent_items item
   SET original_pharmacy_catalog_id = COALESCE(item.original_pharmacy_catalog_id, item.pharmacy_catalog_id),
       original_item_name = COALESCE(item.original_item_name, item.item_name),
       quantity_reserved = CASE
         WHEN indent.status IN ('approved', 'issued', 'received')
           THEN COALESCE(item.quantity_issued, item.quantity_requested)
         ELSE COALESCE(item.quantity_reserved, 0)
       END,
       quantity_approved = CASE
         WHEN indent.status IN ('approved', 'issued', 'received')
           THEN COALESCE(item.quantity_issued, item.quantity_requested)
         ELSE COALESCE(item.quantity_approved, 0)
       END,
       quantity_received = CASE
         WHEN indent.status = 'received'
           THEN COALESCE(item.quantity_issued, item.quantity_requested)
         ELSE COALESCE(item.quantity_received, 0)
       END,
       fulfilment_status = CASE indent.status
         WHEN 'approved' THEN 'approved'
         WHEN 'issued' THEN 'issued'
         WHEN 'received' THEN 'received'
         WHEN 'rejected' THEN 'rejected'
         ELSE 'requested'
       END,
       updated_at = NOW()
  FROM ward_indents indent
 WHERE indent.id = item.ward_indent_id;

UPDATE ward_indent_items item
   SET clinical_order_id = clinical_order.id
  FROM clinical_orders clinical_order
  JOIN ward_indents indent
    ON indent.tenant_id = clinical_order.tenant_id
 WHERE item.clinical_order_id IS NULL
   AND item.tenant_id = clinical_order.tenant_id
   AND item.tenant_id = indent.tenant_id
   AND item.ward_indent_id = indent.id
   AND clinical_order.patient_uid = indent.patient_uid
   AND (
     clinical_order.encounter_id IS NULL
     OR clinical_order.encounter_id = indent.encounter_id
   )
   AND clinical_order.id::text = SUBSTRING(item.notes FROM 'clinical_order_id:([0-9]+)');

ALTER TABLE ward_indent_items
  ADD CONSTRAINT ward_indent_items_fulfilment_status_check CHECK (fulfilment_status IN (
    'requested', 'reserved', 'short_supply', 'substitution_pending',
    'controlled_handoff_required', 'controlled_handoff_recorded', 'approved',
    'issued', 'partially_received', 'received', 'return_pending',
    'reconciliation_required', 'reconciled', 'rejected', 'cancelled', 'closed'
  )),
  ADD CONSTRAINT ward_indent_items_substitution_status_check CHECK (
    substitution_status IS NULL OR substitution_status IN ('pending', 'approved', 'rejected')
  ),
  ADD CONSTRAINT ward_indent_items_quantities_nonnegative_check CHECK (
    quantity_requested > 0
    AND quantity_reserved >= 0
    AND quantity_approved >= 0
    AND COALESCE(quantity_issued, 0) >= 0
    AND quantity_received >= 0
    AND quantity_variance_resolved >= 0
    AND quantity_return_requested >= 0
    AND quantity_returned >= 0
  ),
  ADD CONSTRAINT ward_indent_items_quantity_chain_check CHECK (
    quantity_reserved <= quantity_requested
    AND quantity_approved <= quantity_reserved
    AND COALESCE(quantity_issued, 0) <= quantity_approved
    AND quantity_received <= COALESCE(quantity_issued, 0)
    AND quantity_received + quantity_variance_resolved <= COALESCE(quantity_issued, 0)
    AND quantity_return_requested <= quantity_received
    AND quantity_returned <= quantity_return_requested
  ),
  ADD CONSTRAINT ward_indent_items_proposed_quantity_check CHECK (
    proposed_quantity IS NULL OR (proposed_quantity > 0 AND proposed_quantity <= quantity_requested)
  ),
  ADD CONSTRAINT ward_indent_items_reconciliation_disposition_check CHECK (
    reconciliation_disposition IS NULL OR reconciliation_disposition IN (
      'transit_shortage', 'ward_count_variance', 'damaged_in_transit',
      'documented_exception'
    )
  ),
  ADD CONSTRAINT ward_indent_items_variance_evidence_check CHECK (
    quantity_variance_resolved = 0 OR (
      reconciliation_disposition IS NOT NULL
      AND reconciliation_note IS NOT NULL
      AND BTRIM(reconciliation_note) <> ''
    )
  ),
  ADD CONSTRAINT ward_indent_items_controlled_issue_evidence_check CHECK (
    (controlled_movement_id IS NULL) = (controlled_register_id IS NULL)
    AND (
      controlled_reference_id IS NULL
      OR COALESCE(quantity_issued, 0) = 0
      OR (controlled_movement_id IS NOT NULL AND controlled_register_id IS NOT NULL)
    )
  ),
  ADD CONSTRAINT ward_indent_items_controlled_return_evidence_check CHECK (
    (controlled_return_movement_id IS NULL) = (controlled_return_register_id IS NULL)
    AND (
      controlled_reference_id IS NULL
      OR quantity_returned = 0
      OR (
        controlled_return_movement_id IS NOT NULL
        AND controlled_return_register_id IS NOT NULL
      )
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS ux_ward_indents_tenant_id
  ON ward_indents (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_admissions_tenant_id_for_ward_indents
  ON admissions (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_clinical_orders_tenant_id_for_ward_indents
  ON clinical_orders (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_schedule_register_tenant_id
  ON pharmacy_schedule_register (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ward_indent_items_clinical_order
  ON ward_indent_items (tenant_id, clinical_order_id)
  WHERE clinical_order_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_ward_indent_items_controlled_movement
  ON ward_indent_items (tenant_id, controlled_movement_id)
  WHERE controlled_movement_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_ward_indent_items_controlled_register
  ON ward_indent_items (tenant_id, controlled_register_id)
  WHERE controlled_register_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_ward_indent_items_controlled_return_movement
  ON ward_indent_items (tenant_id, controlled_return_movement_id)
  WHERE controlled_return_movement_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_ward_indent_items_controlled_return_register
  ON ward_indent_items (tenant_id, controlled_return_register_id)
  WHERE controlled_return_register_id IS NOT NULL;

ALTER TABLE ward_indents
  ADD CONSTRAINT fk_ward_indents_tenant
    FOREIGN KEY (tenant_id)
    REFERENCES tenants (id)
    ON DELETE NO ACTION,
  ADD CONSTRAINT fk_ward_indents_ward_tenant
    FOREIGN KEY (tenant_id, ward_id)
    REFERENCES wards (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  ADD CONSTRAINT fk_ward_indents_admission_tenant
    FOREIGN KEY (tenant_id, admission_id)
    REFERENCES admissions (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  ADD CONSTRAINT fk_ward_indents_patient_tenant
    FOREIGN KEY (tenant_id, patient_uid)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  ADD CONSTRAINT ward_indents_owner_state_check CHECK (
    (status IN ('rejected', 'cancelled', 'closed') AND CARDINALITY(owner_role_codes) = 0)
    OR
    (status NOT IN ('rejected', 'cancelled', 'closed') AND CARDINALITY(owner_role_codes) > 0)
  ),
  ADD CONSTRAINT ward_indents_cancel_evidence_check CHECK (
    (
      status = 'cancelled'
      AND cancelled_by IS NOT NULL
      AND cancelled_at IS NOT NULL
      AND cancellation_reason IS NOT NULL
      AND BTRIM(cancellation_reason) <> ''
    )
    OR
    (
      status <> 'cancelled'
      AND cancelled_by IS NULL
      AND cancelled_at IS NULL
      AND cancellation_reason IS NULL
    )
  ),
  ADD CONSTRAINT ward_indents_close_evidence_check CHECK (
    (
      status = 'closed'
      AND closed_by IS NOT NULL
      AND closed_at IS NOT NULL
      AND closure_outcome IS NOT NULL
      AND closure_reason IS NOT NULL
      AND BTRIM(closure_reason) <> ''
    )
    OR
    (
      status <> 'closed'
      AND closed_by IS NULL
      AND closed_at IS NULL
      AND closure_outcome IS NULL
      AND closure_reason IS NULL
    )
  );

ALTER TABLE ward_indent_items
  ADD CONSTRAINT fk_ward_indent_items_indent_tenant
    FOREIGN KEY (tenant_id, ward_indent_id)
    REFERENCES ward_indents (tenant_id, id)
    ON DELETE CASCADE
    DEFERRABLE INITIALLY IMMEDIATE,
  ADD CONSTRAINT fk_ward_indent_items_clinical_order_tenant
    FOREIGN KEY (tenant_id, clinical_order_id)
    REFERENCES clinical_orders (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  ADD CONSTRAINT fk_ward_indent_items_catalog_tenant
    FOREIGN KEY (tenant_id, pharmacy_catalog_id)
    REFERENCES pharmacy_catalog (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  ADD CONSTRAINT fk_ward_indent_items_original_catalog_tenant
    FOREIGN KEY (tenant_id, original_pharmacy_catalog_id)
    REFERENCES pharmacy_catalog (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  ADD CONSTRAINT fk_ward_indent_items_proposed_catalog_tenant
    FOREIGN KEY (tenant_id, proposed_pharmacy_catalog_id)
    REFERENCES pharmacy_catalog (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  ADD CONSTRAINT fk_ward_indent_items_controlled_movement_tenant
    FOREIGN KEY (tenant_id, controlled_movement_id)
    REFERENCES pharmacy_stock_movements (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  ADD CONSTRAINT fk_ward_indent_items_controlled_register_tenant
    FOREIGN KEY (tenant_id, controlled_register_id)
    REFERENCES pharmacy_schedule_register (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  ADD CONSTRAINT fk_ward_indent_items_controlled_return_movement_tenant
    FOREIGN KEY (tenant_id, controlled_return_movement_id)
    REFERENCES pharmacy_stock_movements (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  ADD CONSTRAINT fk_ward_indent_items_controlled_return_register_tenant
    FOREIGN KEY (tenant_id, controlled_return_register_id)
    REFERENCES pharmacy_schedule_register (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE;

CREATE OR REPLACE FUNCTION ward_indent_item_require_clinical_order_context()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
DECLARE
  order_patient_uid UUID;
  order_encounter_id UUID;
  indent_patient_uid UUID;
  indent_encounter_id UUID;
BEGIN
  IF NEW.clinical_order_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT clinical_order.patient_uid,
         clinical_order.encounter_id,
         indent.patient_uid,
         indent.encounter_id
    INTO order_patient_uid,
         order_encounter_id,
         indent_patient_uid,
         indent_encounter_id
    FROM clinical_orders clinical_order
    JOIN ward_indents indent
      ON indent.tenant_id = NEW.tenant_id
     AND indent.id = NEW.ward_indent_id
   WHERE clinical_order.tenant_id = NEW.tenant_id
     AND clinical_order.id = NEW.clinical_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ward indent clinical order or parent is missing from the same tenant'
      USING ERRCODE = '23503';
  END IF;
  IF indent_patient_uid IS NULL
     OR order_patient_uid IS DISTINCT FROM indent_patient_uid THEN
    RAISE EXCEPTION 'ward indent clinical order must match the indent patient'
      USING ERRCODE = '23514';
  END IF;
  IF order_encounter_id IS NOT NULL
     AND order_encounter_id IS DISTINCT FROM indent_encounter_id THEN
    RAISE EXCEPTION 'ward indent clinical order must match the indent encounter'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS ward_indent_item_clinical_order_context ON ward_indent_items;
CREATE TRIGGER ward_indent_item_clinical_order_context
  BEFORE INSERT OR UPDATE OF tenant_id, ward_indent_id, clinical_order_id
  ON ward_indent_items
  FOR EACH ROW EXECUTE FUNCTION ward_indent_item_require_clinical_order_context();

CREATE TABLE ward_indent_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  ward_indent_id INTEGER NOT NULL,
  state_version INTEGER NOT NULL,
  action VARCHAR(60) NOT NULL,
  from_status VARCHAR(40),
  to_status VARCHAR(40) NOT NULL,
  actor_uid UUID NOT NULL,
  owner_role_codes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  reason TEXT,
  command_key VARCHAR(200),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ward_indent_events_state_version_positive_check CHECK (state_version > 0),
  CONSTRAINT ward_indent_events_action_nonblank_check CHECK (BTRIM(action) <> ''),
  CONSTRAINT ward_indent_events_status_check CHECK (
    to_status IN (
      'requested', 'reserved', 'short_supply', 'substitution_pending',
      'controlled_handoff_required', 'approved', 'issued',
      'partially_received', 'received', 'return_pending',
      'reconciliation_required', 'reconciled', 'rejected', 'cancelled', 'closed'
    )
    AND (
      from_status IS NULL OR from_status IN (
        'requested', 'reserved', 'short_supply', 'substitution_pending',
        'controlled_handoff_required', 'approved', 'issued',
        'partially_received', 'received', 'return_pending',
        'reconciliation_required', 'reconciled', 'rejected', 'cancelled', 'closed'
      )
    )
  ),
  CONSTRAINT ward_indent_events_command_key_nonblank_check CHECK (
    command_key IS NULL OR BTRIM(command_key) <> ''
  ),
  CONSTRAINT fk_ward_indent_events_indent_tenant
    FOREIGN KEY (tenant_id, ward_indent_id)
    REFERENCES ward_indents (tenant_id, id)
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_ward_indent_events_tenant
    FOREIGN KEY (tenant_id)
    REFERENCES tenants (id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT ux_ward_indent_events_version
    UNIQUE (tenant_id, ward_indent_id, state_version)
);

CREATE UNIQUE INDEX ux_ward_indent_events_command_key
  ON ward_indent_events (tenant_id, command_key)
  WHERE command_key IS NOT NULL;
CREATE INDEX idx_ward_indent_events_indent_time
  ON ward_indent_events (tenant_id, ward_indent_id, occurred_at DESC);

INSERT INTO ward_indent_events
  (tenant_id, ward_indent_id, state_version, action, from_status, to_status,
   actor_uid, owner_role_codes, reason, details, occurred_at)
SELECT indent.tenant_id,
       indent.id,
       indent.state_version,
       'legacy_state_adopted',
       NULL,
       indent.status,
       COALESCE(
         indent.received_by,
         indent.issued_by,
         indent.approved_by,
         indent.requested_by
       ),
       indent.owner_role_codes,
       'Adopted into the MED-01 authoritative state machine',
       jsonb_build_object('med_01', TRUE, 'legacy_backfill', TRUE),
       indent.last_transition_at
  FROM ward_indents indent;

ALTER TABLE ward_indent_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ward_indent_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ward_indent_events
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

CREATE POLICY ward_indents_explicit_tenant_context ON ward_indents
  AS RESTRICTIVE
  USING (
    current_setting('app.current_tenant_id', true) IS NOT NULL
    AND current_setting('app.current_tenant_id', true) <> ''
    AND (
      current_setting('app.current_tenant_id', true) = 'bypass'
      OR tenant_id = app_current_tenant_id_uuid()
    )
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NOT NULL
    AND current_setting('app.current_tenant_id', true) <> ''
    AND (
      current_setting('app.current_tenant_id', true) = 'bypass'
      OR tenant_id = app_current_tenant_id_uuid()
    )
  );

CREATE POLICY ward_indent_items_explicit_tenant_context ON ward_indent_items
  AS RESTRICTIVE
  USING (
    current_setting('app.current_tenant_id', true) IS NOT NULL
    AND current_setting('app.current_tenant_id', true) <> ''
    AND (
      current_setting('app.current_tenant_id', true) = 'bypass'
      OR tenant_id = app_current_tenant_id_uuid()
    )
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NOT NULL
    AND current_setting('app.current_tenant_id', true) <> ''
    AND (
      current_setting('app.current_tenant_id', true) = 'bypass'
      OR tenant_id = app_current_tenant_id_uuid()
    )
  );

CREATE POLICY ward_indent_events_explicit_tenant_context ON ward_indent_events
  AS RESTRICTIVE
  USING (
    current_setting('app.current_tenant_id', true) IS NOT NULL
    AND current_setting('app.current_tenant_id', true) <> ''
    AND (
      current_setting('app.current_tenant_id', true) = 'bypass'
      OR tenant_id = app_current_tenant_id_uuid()
    )
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NOT NULL
    AND current_setting('app.current_tenant_id', true) <> ''
    AND (
      current_setting('app.current_tenant_id', true) = 'bypass'
      OR tenant_id = app_current_tenant_id_uuid()
    )
  );

DROP TRIGGER IF EXISTS ward_indent_events_append_only ON ward_indent_events;
CREATE TRIGGER ward_indent_events_append_only
  BEFORE UPDATE OR DELETE ON ward_indent_events
  FOR EACH ROW EXECUTE FUNCTION audit_append_only_guard();

CREATE OR REPLACE FUNCTION ward_indent_require_next_state_version()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (
    NEW.status IS DISTINCT FROM OLD.status
    OR NEW.state_version IS DISTINCT FROM OLD.state_version
  ) AND NEW.state_version <> OLD.state_version + 1 THEN
    RAISE EXCEPTION 'ward indent state transitions must increment state_version exactly once'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS ward_indent_next_state_version ON ward_indents;
CREATE TRIGGER ward_indent_next_state_version
  BEFORE UPDATE OF status, state_version ON ward_indents
  FOR EACH ROW EXECUTE FUNCTION ward_indent_require_next_state_version();

CREATE OR REPLACE FUNCTION ward_indent_require_transition_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.state_version IS NOT DISTINCT FROM OLD.state_version THEN
    RETURN NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM ward_indent_events event
     WHERE event.tenant_id = NEW.tenant_id
       AND event.ward_indent_id = NEW.id
       AND event.state_version = NEW.state_version
       AND event.to_status = NEW.status
       AND event.owner_role_codes = NEW.owner_role_codes
  ) THEN
    RAISE EXCEPTION 'ward indent state version % has no matching transition evidence', NEW.state_version
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS ward_indent_transition_evidence ON ward_indents;
CREATE CONSTRAINT TRIGGER ward_indent_transition_evidence
  AFTER INSERT OR UPDATE ON ward_indents
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ward_indent_require_transition_evidence();

DROP INDEX IF EXISTS idx_ward_indents_pending;
CREATE INDEX idx_ward_indents_pending
  ON ward_indents (tenant_id, status, requested_at)
  WHERE status IN (
    'requested', 'reserved', 'short_supply', 'substitution_pending',
    'controlled_handoff_required', 'approved', 'issued',
    'partially_received', 'received', 'return_pending',
    'reconciliation_required', 'reconciled'
  );

INSERT INTO workflow_sla_rules
  (tenant_id, rule_code, title, trigger_event_type, target_minutes, severity,
   owner_role_codes, escalation_role_codes, metadata)
VALUES
  (NULL, 'ward_indent_pharmacy_response', 'Ward indent pharmacy response',
   'ward_indent.requested', 30, 'high',
   ARRAY['PHARMACY_STAFF', 'PHARMACY_INCHARGE', 'PHARMACIST']::TEXT[],
   ARRAY['PHARMACY_INCHARGE', 'MEDICAL_SUPERINTENDENT']::TEXT[],
   '{"med_01":true,"states":["requested","reserved","short_supply"]}'::jsonb),
  (NULL, 'ward_indent_substitution_authorization', 'Ward indent substitution authorization',
   'ward_indent.substitution_proposed', 30, 'high',
   ARRAY['DOCTOR', 'DUTY_DOCTOR', 'CONSULTANT', 'JUNIOR_DOCTOR', 'RESIDENT']::TEXT[],
   ARRAY['MEDICAL_SUPERINTENDENT', 'PHARMACY_INCHARGE']::TEXT[],
   '{"med_01":true,"states":["substitution_pending"]}'::jsonb),
  (NULL, 'ward_indent_controlled_handoff', 'Ward indent controlled-drug handoff',
   'ward_indent.controlled_handoff_required', 30, 'critical',
   ARRAY['PHARMACY_STAFF', 'PHARMACY_INCHARGE', 'PHARMACIST']::TEXT[],
   ARRAY['PHARMACY_INCHARGE', 'MEDICAL_SUPERINTENDENT']::TEXT[],
   '{"med_01":true,"states":["controlled_handoff_required"]}'::jsonb),
  (NULL, 'ward_indent_pharmacy_issue', 'Ward indent issue to ward',
   'ward_indent.approved', 30, 'high',
   ARRAY['PHARMACY_STAFF', 'PHARMACY_INCHARGE', 'PHARMACIST']::TEXT[],
   ARRAY['PHARMACY_INCHARGE', 'MEDICAL_SUPERINTENDENT']::TEXT[],
   '{"med_01":true,"states":["approved"]}'::jsonb),
  (NULL, 'ward_indent_ward_receipt', 'Ward indent receipt acknowledgement',
   'ward_indent.issued', 60, 'high',
   ARRAY['NURSING_STAFF', 'NURSING_INCHARGE', 'IP_STAFF_NURSE', 'IP_INCHARGE',
         'ICU_NURSE', 'ICU_INCHARGE', 'ICU_STAFF', 'ER_STAFF']::TEXT[],
   ARRAY['NURSING_INCHARGE', 'IP_INCHARGE', 'PHARMACY_INCHARGE']::TEXT[],
   '{"med_01":true,"states":["issued","partially_received"]}'::jsonb),
  (NULL, 'ward_indent_reconciliation', 'Ward indent reconciliation and closure',
   'ward_indent.reconciliation_required', 60, 'high',
   ARRAY['PHARMACY_INCHARGE', 'NURSING_INCHARGE', 'IP_INCHARGE', 'ICU_INCHARGE']::TEXT[],
   ARRAY['MEDICAL_SUPERINTENDENT', 'ADMIN']::TEXT[],
   '{"med_01":true,"states":["received","return_pending","reconciliation_required","reconciled"]}'::jsonb)
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

INSERT INTO workflow_sla_instances
  (tenant_id, rule_id, rule_code, patient_uid, encounter_id, source_table,
   source_id, status, priority, started_at, due_at, breached_at,
   assigned_role_codes, metadata)
SELECT indent.tenant_id,
       rule.id,
       rule.rule_code,
       indent.patient_uid,
       indent.encounter_id,
       'ward_indents',
       indent.active_sla_source_id,
       CASE
         WHEN indent.last_transition_at + (rule.target_minutes * INTERVAL '1 minute') < NOW()
           THEN 'breached'
         ELSE 'active'
       END,
       CASE WHEN rule.severity = 'critical' THEN 'critical' ELSE 'high' END,
       indent.last_transition_at,
       indent.last_transition_at + (rule.target_minutes * INTERVAL '1 minute'),
       CASE
         WHEN indent.last_transition_at + (rule.target_minutes * INTERVAL '1 minute') < NOW()
           THEN NOW()
         ELSE NULL
       END,
       rule.owner_role_codes,
       jsonb_build_object(
         'med_01', TRUE,
         'legacy_backfill', TRUE,
         'ward_indent_id', indent.id,
         'indent_number', indent.indent_number,
         'state', indent.status,
         'state_version', indent.state_version
       )
  FROM ward_indents indent
  JOIN workflow_sla_rules rule
    ON rule.tenant_id IS NULL
   AND rule.rule_code = CASE
     WHEN indent.status IN ('requested', 'reserved', 'short_supply')
       THEN 'ward_indent_pharmacy_response'
     WHEN indent.status = 'substitution_pending'
       THEN 'ward_indent_substitution_authorization'
     WHEN indent.status = 'controlled_handoff_required'
       THEN 'ward_indent_controlled_handoff'
     WHEN indent.status = 'approved'
       THEN 'ward_indent_pharmacy_issue'
     WHEN indent.status IN ('issued', 'partially_received')
       THEN 'ward_indent_ward_receipt'
     WHEN indent.status IN ('received', 'return_pending', 'reconciliation_required', 'reconciled')
       THEN 'ward_indent_reconciliation'
     ELSE NULL
   END
 WHERE indent.active_sla_source_id IS NOT NULL
ON CONFLICT (tenant_id, rule_code, source_table, source_id)
  WHERE source_table IS NOT NULL AND source_id IS NOT NULL
DO NOTHING;

COMMIT;
