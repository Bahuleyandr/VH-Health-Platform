-- Migration 753: tenant/facility-bound pharmacy order inventory authority.
--
-- Legacy orders may not have a facility. They are backfilled only when the
-- tenant has one explicit active default; every unresolved active workflow is
-- left visible but cannot progress until an operator assigns its facility.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '180s';
SELECT set_config('app.current_tenant_id', 'bypass', TRUE);

ALTER TABLE pharmacy_orders
  ADD COLUMN IF NOT EXISTS facility_id INTEGER,
  ADD COLUMN IF NOT EXISTS authority_origin VARCHAR(32),
  ADD COLUMN IF NOT EXISTS inventory_authority_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS clinically_verified_order_version INTEGER,
  ADD COLUMN IF NOT EXISTS clinical_verification_items_sha256 CHAR(64),
  ADD COLUMN IF NOT EXISTS clinical_verification_catalog_sha256 CHAR(64),
  ADD COLUMN IF NOT EXISTS clinical_verification_active_therapy_sha256 CHAR(64),
  ADD COLUMN IF NOT EXISTS clinical_verification_safety_version BIGINT,
  ADD COLUMN IF NOT EXISTS clinical_verification_kb_version BIGINT,
  ADD COLUMN IF NOT EXISTS clinical_verification_ruleset_version INTEGER,
  ADD COLUMN IF NOT EXISTS funding_admission_id INTEGER,
  ADD COLUMN IF NOT EXISTS funding_admission_order_version INTEGER,
  ADD COLUMN IF NOT EXISTS funding_admission_items_sha256 CHAR(64),
  ADD COLUMN IF NOT EXISTS delivery_assignee_uid UUID,
  ADD COLUMN IF NOT EXISTS delivery_handoff_token_sha256 CHAR(64),
  ADD COLUMN IF NOT EXISTS delivery_handoff_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivery_handoff_consumed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivery_handoff_completed_by UUID,
  ADD COLUMN IF NOT EXISTS delivery_handoff_generation INTEGER,
  ADD COLUMN IF NOT EXISTS delivery_handoff_notice_outbox_ids INTEGER[],
  ADD COLUMN IF NOT EXISTS delivery_custody_status VARCHAR(24),
  ADD COLUMN IF NOT EXISTS delivery_custody_contract_version INTEGER,
  ADD COLUMN IF NOT EXISTS legacy_verification_grandfathered BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE pharmacy_orders
  ADD CONSTRAINT fk_pharmacy_orders_delivery_assignee_753
    FOREIGN KEY (tenant_id, delivery_assignee_uid)
    REFERENCES users(tenant_id, uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT fk_pharmacy_orders_delivery_completed_by_753
    FOREIGN KEY (tenant_id, delivery_handoff_completed_by)
    REFERENCES users(tenant_id, uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT chk_pharmacy_orders_delivery_handoff_hash_753
    CHECK (
      delivery_handoff_token_sha256 IS NULL
      OR delivery_handoff_token_sha256 ~ '^[0-9a-f]{64}$'
    ) NOT VALID,
  ADD CONSTRAINT chk_pharmacy_orders_delivery_custody_status_753
    CHECK (
      delivery_custody_status IS NULL
      OR delivery_custody_status IN (
        'in_transit', 'delivered', 'return_pending', 'returned', 'quarantined'
      )
    ) NOT VALID,
  ADD CONSTRAINT chk_pharmacy_orders_delivery_handoff_lifecycle_753
    CHECK (
      delivery_custody_contract_version IS NULL
      OR (
        delivery_custody_contract_version=1
        AND
        delivery_assignee_uid IS NOT NULL
        AND delivery_handoff_token_sha256 IS NOT NULL
        AND delivery_handoff_expires_at IS NOT NULL
        AND delivery_handoff_generation IS NOT NULL
        AND delivery_handoff_generation>0
        AND COALESCE(cardinality(delivery_handoff_notice_outbox_ids), 0)>0
        AND (
          (status='DISPATCHED'
            AND delivery_custody_status IN ('in_transit','return_pending')
            AND delivery_handoff_consumed_at IS NULL
            AND delivery_handoff_completed_by IS NULL)
          OR
          (status='DELIVERED'
            AND delivery_custody_status='delivered'
            AND delivery_handoff_consumed_at IS NOT NULL
            AND delivery_handoff_completed_by IS NOT NULL)
          OR
          (status='UNAVAILABLE'
            AND delivery_custody_status IN ('returned','quarantined')
            AND delivery_handoff_consumed_at IS NULL
            AND delivery_handoff_completed_by IS NULL)
        )
      )
    ) NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_orders_delivery_handoff_token_753
  ON pharmacy_orders (tenant_id, delivery_handoff_token_sha256)
  WHERE delivery_handoff_token_sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pharmacy_orders_delivery_assignee_custody_753
  ON pharmacy_orders (tenant_id, delivery_assignee_uid, delivery_custody_status, id)
  WHERE delivery_assignee_uid IS NOT NULL;

CREATE OR REPLACE FUNCTION guard_pharmacy_order_delivery_custody_753()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- The custody contract is demanded only where custody actually exists.
  -- DISPATCHED and DELIVERED are custody-bearing by definition: a courier is
  -- holding, or has handed over, a sealed package. UNAVAILABLE is not — it is
  -- reachable from PENDING, CONFIRMED, PREPARING, READY, ON_HOLD, REJECTED and
  -- PARTIALLY_DISPENSED (see the transition table below), where no package was
  -- ever issued and no custody was ever taken. Demanding a contract version
  -- there would force the caller to stamp `delivery_custody_contract_version=1`
  -- on an order that never had a courier, asserting custody that never
  -- happened; it would also make the pre-dispatch unavailable path unreachable
  -- for every delivery order. So the requirement is keyed on the PRE-IMAGE:
  -- UNAVAILABLE needs a contract only when the row was already custody-bearing.
  -- Legacy rows dispatched before this migration have OLD.status='DISPATCHED'
  -- with a NULL contract version, so they stay blocked here and must be
  -- resolved through the ORDER_DELIVERY_CUSTODY_UNRESOLVED worklist rather than
  -- closed as unavailable. The custody shape required of an UNAVAILABLE order
  -- that DOES carry a contract is enforced separately by
  -- chk_pharmacy_orders_delivery_handoff_lifecycle_753.
  IF NEW.delivery_type='delivery'
     AND (
       NEW.status IN ('DISPATCHED','DELIVERED')
       OR (
         NEW.status='UNAVAILABLE'
         AND (
           OLD.status IN ('DISPATCHED','DELIVERED')
           OR OLD.delivery_custody_contract_version IS NOT NULL
           OR OLD.delivery_custody_status IS NOT NULL
         )
       )
     )
     AND NEW.delivery_custody_contract_version IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'delivery custody contract is required before dispatch or delivery'
      USING ERRCODE='23514', CONSTRAINT='chk_pharmacy_order_delivery_custody_contract_753';
  END IF;
  IF OLD.delivery_custody_contract_version=1
     AND NEW.delivery_custody_contract_version IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'delivery custody contract cannot be removed after package issue'
      USING ERRCODE='23514', CONSTRAINT='chk_pharmacy_order_delivery_custody_contract_753';
  END IF;
  IF OLD.delivery_assignee_uid IS NOT NULL AND (
    (NEW.delivery_assignee_uid IS DISTINCT FROM OLD.delivery_assignee_uid
      OR NEW.delivery_handoff_token_sha256 IS DISTINCT FROM OLD.delivery_handoff_token_sha256
       OR NEW.delivery_handoff_expires_at IS DISTINCT FROM OLD.delivery_handoff_expires_at
       OR NEW.delivery_handoff_generation IS DISTINCT FROM OLD.delivery_handoff_generation
       OR NEW.delivery_handoff_notice_outbox_ids IS DISTINCT FROM OLD.delivery_handoff_notice_outbox_ids)
      AND NOT (
        current_setting('app.pharmacy_delivery_handoff_reissue', TRUE)='on'
        AND OLD.status='DISPATCHED' AND OLD.delivery_custody_status='in_transit'
        AND OLD.delivery_handoff_consumed_at IS NULL
        AND NEW.status='DISPATCHED' AND NEW.delivery_custody_status='in_transit'
        AND NEW.delivery_handoff_consumed_at IS NULL
        AND NEW.delivery_handoff_completed_by IS NULL
        AND NEW.delivery_handoff_generation=OLD.delivery_handoff_generation+1
      )
  ) THEN
    RAISE EXCEPTION 'delivery assignee and handoff authority are immutable after dispatch'
      USING ERRCODE='23514', CONSTRAINT='chk_pharmacy_order_delivery_custody_immutable_753';
  END IF;
  IF OLD.delivery_handoff_consumed_at IS NOT NULL AND (
    NEW.delivery_handoff_consumed_at IS DISTINCT FROM OLD.delivery_handoff_consumed_at
    OR NEW.delivery_handoff_completed_by IS DISTINCT FROM OLD.delivery_handoff_completed_by
  ) THEN
    RAISE EXCEPTION 'consumed delivery handoff evidence is immutable'
      USING ERRCODE='23514', CONSTRAINT='chk_pharmacy_order_delivery_handoff_consumed_753';
  END IF;
  IF OLD.delivery_custody_status IS NOT NULL
     AND NEW.delivery_custody_status IS DISTINCT FROM OLD.delivery_custody_status
     AND NOT (
       (OLD.delivery_custody_status='in_transit'
         AND NEW.delivery_custody_status IN ('delivered','return_pending'))
       OR (OLD.delivery_custody_status='return_pending'
         AND NEW.delivery_custody_status IN ('returned','quarantined'))
     ) THEN
    RAISE EXCEPTION 'invalid delivery custody transition'
      USING ERRCODE='23514', CONSTRAINT='chk_pharmacy_order_delivery_custody_transition_753';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_pharmacy_order_delivery_custody_753
BEFORE UPDATE OF delivery_assignee_uid, delivery_handoff_token_sha256,
  delivery_handoff_expires_at, delivery_handoff_consumed_at,
  delivery_handoff_completed_by, delivery_handoff_generation,
  delivery_handoff_notice_outbox_ids, delivery_custody_status,
  delivery_custody_contract_version, status, delivery_type
ON pharmacy_orders
FOR EACH ROW EXECUTE FUNCTION guard_pharmacy_order_delivery_custody_753();

-- Authority origin is stamped only where the evidence proves it: a linked
-- e_prescriptions row, or a patient-uploaded prescription photo key. An order
-- with neither has no provable origin, so this migration invents none: the
-- column stays NULL and the row is worklisted below as
-- ORDER_AUTHORITY_ORIGIN_UNRESOLVED, carrying the candidate value
-- ('legacy_unresolved') in its authority_snapshot for an operator to apply.
-- authority_origin is therefore deliberately NOT set NOT NULL. A NULL origin
-- fails closed downstream: pharmacistVerificationService's origin/linkage
-- gates fall through to `true` (invalid) for any origin that is neither
-- 'e_prescription' nor 'patient_manual'.
UPDATE pharmacy_orders po
   SET authority_origin=CASE
     WHEN EXISTS (
       SELECT 1 FROM e_prescriptions ep
        WHERE ep.tenant_id=po.tenant_id AND ep.pharmacy_order_id=po.id
     ) THEN 'e_prescription'
     ELSE 'patient_manual'
   END
 WHERE po.authority_origin IS NULL
   AND (
     po.prescription_photo_key IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM e_prescriptions ep
        WHERE ep.tenant_id=po.tenant_id AND ep.pharmacy_order_id=po.id
     )
   );

UPDATE pharmacy_orders
   SET status = UPPER(REPLACE(REPLACE(BTRIM(status), '-', '_'), ' ', '_'))
 WHERE status IS NOT NULL
   AND status IS DISTINCT FROM UPPER(REPLACE(REPLACE(BTRIM(status), '-', '_'), ' ', '_'))
   AND UPPER(REPLACE(REPLACE(BTRIM(status), '-', '_'), ' ', '_')) = ANY(ARRAY[
     'PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'DISPATCHED',
     'PARTIALLY_DISPENSED', 'DELIVERED', 'DISPENSED', 'UNAVAILABLE',
     'CANCELLED', 'ON_HOLD', 'REJECTED'
   ]::TEXT[]);

UPDATE pharmacy_orders
   SET legacy_verification_grandfathered = TRUE
 WHERE status IN ('CANCELLED', 'DELIVERED', 'DISPENSED', 'UNAVAILABLE')
   AND clinical_verification_status IN ('verified', 'override')
   AND (
     clinically_verified_order_version IS NULL
     OR clinical_verification_items_sha256 IS NULL
     OR clinical_verification_catalog_sha256 IS NULL
     OR (patient_id IS NOT NULL AND clinical_verification_active_therapy_sha256 IS NULL)
     OR clinical_verification_kb_version IS NULL
     OR clinical_verification_ruleset_version IS NULL
   );

-- Facility custody for a legacy order is NOT inferred from the tenant's
-- default facility. "The tenant happens to have exactly one active default"
-- is not evidence that this order was fulfilled from it, and stamping it would
-- pin dispense custody to a facility nobody proved. Unresolved active orders
-- keep facility_id NULL, are worklisted below as ORDER_FACILITY_UNRESOLVED
-- with the candidate default(s) in their authority_snapshot, and are held by
-- chk_pharmacy_orders_facility_progression_753 until an operator assigns one.

-- Extend migration 649's database state-machine backstop with a non-terminal
-- partial-dispense state. Repeated partial writes keep the same status and are
-- therefore handled by the unchanged-status early return.
CREATE OR REPLACE FUNCTION public.validate_pharmacy_order_status_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  canonical CONSTANT text[] := ARRAY[
    'PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'DISPATCHED',
    'PARTIALLY_DISPENSED', 'DELIVERED', 'DISPENSED', 'UNAVAILABLE',
    'CANCELLED', 'ON_HOLD', 'REJECTED'
  ];
  allowed text[];
  old_semantic text;
BEGIN
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
    old_semantic := UPPER(REPLACE(REPLACE(BTRIM(OLD.status), '-', '_'), ' ', '_'));
    IF OLD.status IS NULL OR NOT (old_semantic = ANY (canonical)) THEN
      IF NEW.status IN ('ON_HOLD', 'CANCELLED')
         AND current_setting('app.pharmacy_authority_recovery_id', TRUE) ~ '^[0-9]+$'
         AND EXISTS (
           SELECT 1
             FROM pharmacy_inventory_authority_recovery_worklist recovery
            WHERE recovery.id=current_setting(
                    'app.pharmacy_authority_recovery_id', TRUE
                  )::bigint
              AND recovery.tenant_id=NEW.tenant_id
              AND recovery.entity_type='pharmacy_order'
              AND recovery.entity_id=NEW.id
              AND recovery.reason_code='ORDER_STATUS_NONCANONICAL'
              AND recovery.status='OPEN'
         ) THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_pharmacy_order_status_legacy_recovery_required',
        MESSAGE = FORMAT(
          'Pharmacy order status %L requires governed recovery before transition',
          OLD.status
        );
    END IF;
    IF NEW.status = old_semantic AND OLD.status IS DISTINCT FROM old_semantic THEN
      RETURN NEW;
    END IF;
    allowed := CASE old_semantic
      WHEN 'PENDING' THEN ARRAY['CONFIRMED', 'READY', 'ON_HOLD', 'PARTIALLY_DISPENSED', 'DISPENSED', 'UNAVAILABLE', 'CANCELLED']
      WHEN 'CONFIRMED' THEN ARRAY['ON_HOLD', 'PREPARING', 'READY', 'DISPATCHED', 'PARTIALLY_DISPENSED', 'DISPENSED', 'UNAVAILABLE', 'CANCELLED']
      WHEN 'PARTIALLY_DISPENSED' THEN ARRAY['DISPENSED', 'UNAVAILABLE', 'CANCELLED']
      WHEN 'PREPARING' THEN ARRAY['READY', 'DISPATCHED', 'UNAVAILABLE', 'CANCELLED']
      WHEN 'READY' THEN ARRAY['DISPATCHED', 'UNAVAILABLE', 'CANCELLED']
      WHEN 'DISPATCHED' THEN ARRAY['DELIVERED', 'UNAVAILABLE', 'CANCELLED']
      WHEN 'ON_HOLD' THEN ARRAY['CONFIRMED', 'UNAVAILABLE', 'CANCELLED']
      WHEN 'REJECTED' THEN ARRAY['UNAVAILABLE', 'CANCELLED']
      ELSE ARRAY[]::text[]
    END;
    IF NOT (NEW.status = ANY (allowed)) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_pharmacy_order_status_transition',
        MESSAGE = FORMAT('Pharmacy order transition %s -> %s is not allowed', OLD.status, NEW.status);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_orders_tenant_id_753
  ON pharmacy_orders (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_orders_tenant_id_patient_id_753
  ON pharmacy_orders (tenant_id, id, patient_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_orders_facility_scope_753
  ON pharmacy_orders (tenant_id, id, facility_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_inventory_items_facility_scope_753
  ON pharmacy_inventory_items (tenant_id, facility_id, id);

ALTER TABLE pharmacy_inventory_items
  DROP CONSTRAINT IF EXISTS pharmacy_inventory_items_tenant_id_sku_code_key;
DROP INDEX IF EXISTS pharmacy_inventory_items_tenant_id_sku_code_key;
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_inventory_items_facility_sku_753
  ON pharmacy_inventory_items (tenant_id, facility_id, sku_code)
  WHERE facility_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_inventory_items_legacy_sku_753
  ON pharmacy_inventory_items (tenant_id, sku_code)
  WHERE facility_id IS NULL;

-- Stock custody is NOT inferred from the tenant's default facility, and
-- batches do not inherit an inferred item facility. Unresolved rows keep
-- facility_id NULL so the governed paths below become live for them:
--   * active items with a NULL facility fall into the 'FACILITY_UNRESOLVED'
--     branch of the inventory-item worklist seed (with the candidate default
--     facilities carried in authority_snapshot) and are then paused by the
--     inventory_authority_recovery_required quarantine;
--   * in_stock/reserved batches with a NULL facility are seeded as
--     BATCH_ITEM_AUTHORITY_MISMATCH and quarantined, which is what satisfies
--     chk_pharmacy_batches_usable_authority_753.
-- Removing the item backfill also removes an abort risk: two NULL-facility
-- items sharing a sku_code within a tenant would both have been stamped with
-- the same default facility and collided on
-- ux_pharmacy_inventory_items_facility_sku_753.

CREATE TABLE IF NOT EXISTS pharmacy_inventory_authority_recovery_worklist (
  id                 BIGSERIAL PRIMARY KEY,
  tenant_id          UUID NOT NULL,
  entity_type        VARCHAR(32) NOT NULL,
  entity_id          BIGINT NOT NULL,
  inventory_item_id  INTEGER,
  facility_id        INTEGER,
  catalog_id         INTEGER,
  reason_code        VARCHAR(80) NOT NULL,
  authority_snapshot JSONB NOT NULL,
  status             VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  resolved_by        UUID,
  resolved_at        TIMESTAMPTZ,
  resolution_note    VARCHAR(500),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_pharmacy_inventory_authority_recovery_tenant_753
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pharmacy_inventory_authority_recovery_resolver_753
    FOREIGN KEY (tenant_id, resolved_by) REFERENCES users(tenant_id, uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- THE single authoritative entity_type allow-list. Multiple CHECKs on one
  -- column AND together, so a second definition elsewhere in this migration
  -- would silently intersect with this one and lock out entity types this
  -- migration itself seeds. Do not add a DROP/ADD of a differently-named
  -- entity_type CHECK later in this file — extend this list instead. The list
  -- is the union of every entity_type seeded here (migration backfills) and
  -- written at runtime (pharmacyOrderController CATALOG_DEACTIVATED,
  -- pharmacyFacilityAuthorityService STAFF_FACILITY_GRANT_REQUIRED).
  CONSTRAINT chk_pharmacy_inventory_authority_recovery_entity_753
    CHECK (entity_type IN (
      'inventory_item', 'inventory_batch', 'purchase_order',
      'purchase_order_item', 'goods_receipt', 'goods_receipt_item',
      'pharmacy_order', 'e_prescription', 'staff_facility_grant',
      'ward_indent', 'supplier', 'counter_sale',
      'cath_consumable_catalog', 'cath_consumable_usage', 'cath_lab_case'
    )),
  CONSTRAINT chk_pharmacy_inventory_authority_recovery_status_753
    CHECK (status IN ('OPEN', 'RESOLVED')),
  CONSTRAINT chk_pharmacy_inventory_authority_recovery_resolution_753
    CHECK (
      (status='OPEN' AND resolved_by IS NULL AND resolved_at IS NULL AND resolution_note IS NULL)
      OR
      (status='RESOLVED' AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL
        AND length(btrim(resolution_note)) BETWEEN 3 AND 500)
    ),
  CONSTRAINT ux_pharmacy_inventory_authority_recovery_753
    UNIQUE (tenant_id, entity_type, entity_id, reason_code),
  CONSTRAINT ux_pharmacy_inventory_authority_recovery_tenant_id_753
    UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS pharmacy_inventory_authority_recovery_events (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL,
  recovery_id      BIGINT NOT NULL,
  event_type       VARCHAR(24) NOT NULL,
  reason_code      VARCHAR(80) NOT NULL,
  actor_uid        UUID,
  request_id       VARCHAR(200),
  command_key_sha256 CHAR(64),
  request_sha256   CHAR(64),
  request_payload  JSONB,
  resolution_payload JSONB,
  target_identity  JSONB,
  target_before    JSONB,
  target_after     JSONB,
  contract_version INTEGER,
  before_authority JSONB,
  after_authority  JSONB NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_pharmacy_authority_recovery_event_tenant_753
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pharmacy_authority_recovery_event_recovery_753
    FOREIGN KEY (tenant_id, recovery_id)
    REFERENCES pharmacy_inventory_authority_recovery_worklist(tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pharmacy_authority_recovery_event_actor_753
    FOREIGN KEY (tenant_id, actor_uid) REFERENCES users(tenant_id, uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_pharmacy_authority_recovery_event_type_753
    CHECK (event_type IN ('CREATED', 'REFRESHED', 'REOPENED', 'RESOLVED')),
  CONSTRAINT chk_pharmacy_authority_recovery_event_receipt_753
    CHECK (
      event_type NOT IN ('REOPENED', 'RESOLVED')
      OR (
        actor_uid IS NOT NULL
        AND command_key_sha256 ~ '^[0-9a-f]{64}$'
        AND request_sha256 ~ '^[0-9a-f]{64}$'
        AND request_payload IS NOT NULL
        AND resolution_payload IS NOT NULL
        AND target_identity IS NOT NULL
        AND target_before IS NOT NULL
        AND target_after IS NOT NULL
        AND contract_version=1
      )
    ),
  CONSTRAINT ux_pharmacy_authority_recovery_event_tenant_id_753
    UNIQUE (tenant_id, id),
  CONSTRAINT ux_pharmacy_authority_recovery_event_command_753
    UNIQUE (tenant_id, command_key_sha256)
);
CREATE INDEX IF NOT EXISTS idx_pharmacy_authority_recovery_event_stream_753
  ON pharmacy_inventory_authority_recovery_events (tenant_id, recovery_id, created_at, id);

CREATE OR REPLACE FUNCTION append_pharmacy_authority_recovery_event_753()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  event_kind TEXT;
  event_actor UUID;
  event_request TEXT;
  command_hash TEXT;
  request_hash TEXT;
BEGIN
  event_kind := CASE
    WHEN TG_OP='INSERT' THEN 'CREATED'
    WHEN OLD.status='RESOLVED' AND NEW.status='OPEN' THEN 'REOPENED'
    WHEN OLD.status='OPEN' AND NEW.status='RESOLVED' THEN 'RESOLVED'
    ELSE 'REFRESHED'
  END;
  event_actor := CASE WHEN event_kind IN ('REOPENED', 'RESOLVED') THEN COALESCE(
    NEW.resolved_by,
    NULLIF(current_setting('app.pharmacy_recovery_actor_uid', TRUE), '')::uuid
  ) ELSE NULL END;
  event_request := CASE WHEN event_kind IN ('REOPENED', 'RESOLVED') THEN
    NULLIF(current_setting('app.pharmacy_recovery_request_id', TRUE), '')
  ELSE NULL END;
  command_hash := CASE WHEN event_kind IN ('REOPENED', 'RESOLVED') THEN NULLIF(
    current_setting('app.pharmacy_recovery_command_key_sha256', TRUE), ''
  ) ELSE NULL END;
  request_hash := CASE WHEN event_kind IN ('REOPENED', 'RESOLVED') THEN
    NULLIF(current_setting('app.pharmacy_recovery_request_sha256', TRUE), '')
  ELSE NULL END;
  INSERT INTO pharmacy_inventory_authority_recovery_events (
    tenant_id, recovery_id, event_type, reason_code, actor_uid, request_id,
    command_key_sha256, request_sha256, request_payload, resolution_payload,
    target_identity, target_before, target_after, contract_version,
    before_authority, after_authority
  ) VALUES (
    NEW.tenant_id, NEW.id, event_kind, NEW.reason_code, event_actor, event_request,
    command_hash, request_hash,
    CASE WHEN command_hash IS NULL THEN NULL ELSE
      NULLIF(current_setting('app.pharmacy_recovery_request_payload', TRUE), '')::jsonb END,
    CASE WHEN command_hash IS NULL THEN NULL ELSE
      NULLIF(current_setting('app.pharmacy_recovery_resolution_payload', TRUE), '')::jsonb END,
    CASE WHEN command_hash IS NULL THEN NULL ELSE
      NULLIF(current_setting('app.pharmacy_recovery_target_identity', TRUE), '')::jsonb END,
    CASE WHEN command_hash IS NULL THEN NULL ELSE
      NULLIF(current_setting('app.pharmacy_recovery_target_before', TRUE), '')::jsonb END,
    CASE
      WHEN event_kind='REOPENED' THEN to_jsonb(NEW)
      WHEN command_hash IS NULL THEN NULL
      ELSE NULLIF(current_setting('app.pharmacy_recovery_target_after', TRUE), '')::jsonb
    END,
    CASE WHEN command_hash IS NULL THEN NULL ELSE 1 END,
    CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE NULL END,
    to_jsonb(NEW)
  );
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_pharmacy_authority_recovery_event_753
  ON pharmacy_inventory_authority_recovery_worklist;
CREATE TRIGGER trg_pharmacy_authority_recovery_event_753
AFTER INSERT OR UPDATE ON pharmacy_inventory_authority_recovery_worklist
FOR EACH ROW EXECUTE FUNCTION append_pharmacy_authority_recovery_event_753();

CREATE OR REPLACE FUNCTION reject_pharmacy_authority_recovery_event_mutation_753()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pharmacy authority recovery events are append-only'
    USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER trg_pharmacy_authority_recovery_events_append_only_753
BEFORE UPDATE OR DELETE ON pharmacy_inventory_authority_recovery_events
FOR EACH ROW EXECUTE FUNCTION reject_pharmacy_authority_recovery_event_mutation_753();

ALTER TABLE pharmacy_inventory_authority_recovery_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_inventory_authority_recovery_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pharmacy_inventory_authority_recovery_events
  USING (
    current_setting('app.current_tenant_id', TRUE) = 'bypass'
    OR tenant_id = public.app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', TRUE) = 'bypass'
    OR tenant_id = public.app_current_tenant_id_uuid()
  );

INSERT INTO pharmacy_inventory_authority_recovery_worklist (
  tenant_id, entity_type, entity_id, facility_id, reason_code, authority_snapshot
)
SELECT orders.tenant_id, 'pharmacy_order', orders.id, orders.facility_id,
       'ORDER_DELIVERY_CUSTODY_UNRESOLVED',
       jsonb_build_object(
         'status', orders.status,
         'delivery_type', orders.delivery_type,
         'delivery_person', orders.delivery_person,
         'delivery_person_phone', orders.delivery_person_phone,
         'dispatched_at', orders.dispatched_at,
         'delivered_at', orders.delivered_at,
         'legacy_contract_version', orders.delivery_custody_contract_version
       )
  FROM pharmacy_orders orders
 WHERE orders.delivery_type='delivery'
   AND orders.status IN ('DISPATCHED','DELIVERED')
   AND orders.delivery_custody_contract_version IS NULL
ON CONFLICT (tenant_id, entity_type, entity_id, reason_code) DO NOTHING;

CREATE TABLE IF NOT EXISTS pharmacy_staff_facility_grants (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         UUID NOT NULL,
  facility_id       INTEGER NOT NULL,
  staff_uid         UUID NOT NULL,
  status            VARCHAR(20) NOT NULL DEFAULT 'active',
  grant_source      VARCHAR(40) NOT NULL,
  grant_reason      VARCHAR(500) NOT NULL,
  granted_by        UUID NOT NULL,
  granted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_by        UUID,
  revoked_at        TIMESTAMPTZ,
  revocation_reason VARCHAR(500),
  authority_version INTEGER NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_pharmacy_staff_facility_grant_tenant_753
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pharmacy_staff_facility_grant_facility_753
    FOREIGN KEY (tenant_id, facility_id) REFERENCES facilities(tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pharmacy_staff_facility_grant_staff_753
    FOREIGN KEY (tenant_id, staff_uid) REFERENCES users(tenant_id, uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pharmacy_staff_facility_grant_granter_753
    FOREIGN KEY (tenant_id, granted_by) REFERENCES users(tenant_id, uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pharmacy_staff_facility_grant_revoker_753
    FOREIGN KEY (tenant_id, revoked_by) REFERENCES users(tenant_id, uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_pharmacy_staff_facility_grant_status_753
    CHECK (status IN ('active', 'revoked')),
  CONSTRAINT chk_pharmacy_staff_facility_grant_reason_753
    CHECK (length(btrim(grant_reason)) BETWEEN 10 AND 500),
  CONSTRAINT chk_pharmacy_staff_facility_grant_lifecycle_753
    CHECK (
      (status='active' AND revoked_by IS NULL AND revoked_at IS NULL AND revocation_reason IS NULL)
      OR
      (status='revoked' AND revoked_by IS NOT NULL AND revoked_at IS NOT NULL
        AND length(btrim(revocation_reason)) BETWEEN 10 AND 500)
    ),
  CONSTRAINT ux_pharmacy_staff_facility_grant_tenant_id_753
    UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_staff_facility_grant_active_753
  ON pharmacy_staff_facility_grants (tenant_id, staff_uid, facility_id)
  WHERE status='active';
CREATE INDEX IF NOT EXISTS idx_pharmacy_staff_facility_grant_facility_753
  ON pharmacy_staff_facility_grants (tenant_id, facility_id, status, staff_uid);

CREATE TABLE IF NOT EXISTS pharmacy_staff_facility_grant_events (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         UUID NOT NULL,
  grant_id          BIGINT NOT NULL,
  event_type        VARCHAR(20) NOT NULL,
  actor_uid         UUID,
  reason            VARCHAR(500) NOT NULL,
  authority_version INTEGER NOT NULL,
  evidence          JSONB NOT NULL DEFAULT '{}'::jsonb,
  command_key_sha256 CHAR(64) NOT NULL,
  request_sha256     CHAR(64) NOT NULL,
  request_payload    JSONB NOT NULL,
  contract_version   INTEGER NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_pharmacy_staff_facility_grant_event_grant_753
    FOREIGN KEY (tenant_id, grant_id)
    REFERENCES pharmacy_staff_facility_grants(tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pharmacy_staff_facility_grant_event_actor_753
    FOREIGN KEY (tenant_id, actor_uid) REFERENCES users(tenant_id, uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_pharmacy_staff_facility_grant_event_type_753
    CHECK (event_type IN ('GRANTED', 'REVOKED')),
  CONSTRAINT chk_pharmacy_staff_facility_grant_event_hashes_753
    CHECK (
      command_key_sha256 ~ '^[0-9a-f]{64}$'
      AND request_sha256 ~ '^[0-9a-f]{64}$'
      AND contract_version=1
    ),
  CONSTRAINT ux_pharmacy_staff_facility_grant_event_tenant_id_753
    UNIQUE (tenant_id, id),
  CONSTRAINT ux_pharmacy_staff_facility_grant_event_command_753
    UNIQUE (tenant_id, command_key_sha256)
);
CREATE INDEX IF NOT EXISTS idx_pharmacy_staff_facility_grant_event_stream_753
  ON pharmacy_staff_facility_grant_events (tenant_id, grant_id, authority_version, id);

CREATE OR REPLACE FUNCTION reject_pharmacy_staff_facility_grant_event_mutation_753()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pharmacy staff facility grant events are append-only'
    USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER trg_pharmacy_staff_facility_grant_events_append_only_753
BEFORE UPDATE OR DELETE ON pharmacy_staff_facility_grant_events
FOR EACH ROW EXECUTE FUNCTION reject_pharmacy_staff_facility_grant_event_mutation_753();

ALTER TABLE pharmacy_staff_facility_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_staff_facility_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pharmacy_staff_facility_grants
  USING (
    current_setting('app.current_tenant_id', TRUE) = 'bypass'
    OR tenant_id = public.app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', TRUE) = 'bypass'
    OR tenant_id = public.app_current_tenant_id_uuid()
  );
ALTER TABLE pharmacy_staff_facility_grant_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_staff_facility_grant_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pharmacy_staff_facility_grant_events
  USING (
    current_setting('app.current_tenant_id', TRUE) = 'bypass'
    OR tenant_id = public.app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', TRUE) = 'bypass'
    OR tenant_id = public.app_current_tenant_id_uuid()
  );

INSERT INTO pharmacy_inventory_authority_recovery_worklist (
  tenant_id, entity_type, entity_id, reason_code, authority_snapshot
)
SELECT actor.tenant_id, 'staff_facility_grant', staff.id,
       'STAFF_FACILITY_GRANT_REQUIRED',
       jsonb_build_object(
         'staff_uid', actor.uid,
         'role', actor.role,
         'active_facilities', COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
             'facility_id', facility.id,
             'facility_code', facility.facility_code,
             'is_default', facility.is_default
           ) ORDER BY facility.id)
             FROM facilities facility
            WHERE facility.tenant_id=actor.tenant_id
              AND facility.status='active'
         ), '[]'::jsonb)
       )
  FROM users actor
  JOIN staff
    ON staff.tenant_id=actor.tenant_id AND staff.user_id=actor.uid
   AND staff.is_active=TRUE AND staff.archived=FALSE
 WHERE actor.is_active=TRUE AND actor.status='active'
   AND actor.is_deleted=FALSE AND actor.merged_into_uid IS NULL
   AND actor.role IN (
     'PHARMACY_STAFF', 'PHARMACIST', 'PHARMACY_INCHARGE',
     'STORES_PURCHASE_INCHARGE', 'DELIVERY_STAFF', 'ADMIN', 'SUPER_ADMIN'
   )
   AND NOT EXISTS (
     SELECT 1
       FROM pharmacy_staff_facility_grants grant_row
      WHERE grant_row.tenant_id=actor.tenant_id
        AND grant_row.staff_uid=actor.uid
        AND grant_row.status='active'
        AND grant_row.revoked_at IS NULL
   )
ON CONFLICT (tenant_id, entity_type, entity_id, reason_code) DO NOTHING;

CREATE TABLE IF NOT EXISTS pharmacy_ward_allocation_authority_recovery (
  id                    BIGSERIAL PRIMARY KEY,
  tenant_id             UUID NOT NULL,
  allocation_id         BIGINT NOT NULL,
  ward_indent_id        INTEGER NOT NULL,
  ward_indent_item_id   INTEGER NOT NULL,
  inventory_item_id     INTEGER NOT NULL,
  inventory_batch_id    INTEGER NOT NULL,
  facility_id           INTEGER,
  catalog_id            INTEGER,
  reason_code           VARCHAR(80) NOT NULL,
  authority_snapshot    JSONB NOT NULL,
  status                VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  resolved_by           UUID,
  resolved_at           TIMESTAMPTZ,
  resolution_note       VARCHAR(500),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_ward_alloc_recovery_tenant_753
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ward_alloc_recovery_allocation_753
    FOREIGN KEY (
      tenant_id, allocation_id, ward_indent_id, ward_indent_item_id, inventory_batch_id
    ) REFERENCES ward_indent_inventory_allocations(
      tenant_id, id, ward_indent_id, ward_indent_item_id, inventory_batch_id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ward_alloc_recovery_resolver_753
    FOREIGN KEY (tenant_id, resolved_by) REFERENCES users(tenant_id, uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_ward_alloc_recovery_status_753
    CHECK (status IN ('OPEN', 'RESOLVED')),
  CONSTRAINT chk_ward_alloc_recovery_resolution_753
    CHECK (
      (status='OPEN' AND resolved_by IS NULL AND resolved_at IS NULL
        AND resolution_note IS NULL)
      OR
      (status='RESOLVED' AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL
        AND length(btrim(resolution_note)) BETWEEN 3 AND 500)
    ),
  CONSTRAINT ux_ward_alloc_recovery_identity_753
    UNIQUE (tenant_id, allocation_id, reason_code),
  CONSTRAINT ux_ward_alloc_recovery_tenant_id_753
    UNIQUE (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_ward_alloc_recovery_worklist_753
  ON pharmacy_ward_allocation_authority_recovery (
    tenant_id, facility_id, status, created_at, id
  );

CREATE TABLE IF NOT EXISTS pharmacy_ward_allocation_authority_recovery_events (
  id                 BIGSERIAL PRIMARY KEY,
  tenant_id          UUID NOT NULL,
  recovery_id        BIGINT NOT NULL,
  event_type         VARCHAR(24) NOT NULL,
  actor_uid          UUID,
  request_id         VARCHAR(200),
  command_key_sha256 CHAR(64),
  request_sha256     CHAR(64),
  request_payload    JSONB,
  resolution_payload JSONB,
  target_identity    JSONB,
  target_before      JSONB,
  target_after       JSONB,
  contract_version   INTEGER,
  before_authority   JSONB,
  after_authority    JSONB NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_ward_alloc_recovery_event_parent_753
    FOREIGN KEY (tenant_id, recovery_id)
    REFERENCES pharmacy_ward_allocation_authority_recovery(tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ward_alloc_recovery_event_actor_753
    FOREIGN KEY (tenant_id, actor_uid) REFERENCES users(tenant_id, uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_ward_alloc_recovery_event_type_753
    CHECK (event_type IN ('CREATED', 'REFRESHED', 'REOPENED', 'RESOLVED')),
  CONSTRAINT chk_ward_alloc_recovery_event_receipt_753
    CHECK (
      event_type NOT IN ('REOPENED', 'RESOLVED')
      OR (
        actor_uid IS NOT NULL
        AND command_key_sha256 ~ '^[0-9a-f]{64}$'
        AND request_sha256 ~ '^[0-9a-f]{64}$'
        AND request_payload IS NOT NULL
        AND resolution_payload IS NOT NULL
        AND target_identity IS NOT NULL
        AND target_before IS NOT NULL
        AND target_after IS NOT NULL
        AND contract_version=1
      )
    ),
  CONSTRAINT ux_ward_alloc_recovery_event_tenant_id_753
    UNIQUE (tenant_id, id),
  CONSTRAINT ux_ward_alloc_recovery_event_command_753
    UNIQUE (tenant_id, command_key_sha256)
);
CREATE INDEX IF NOT EXISTS idx_ward_alloc_recovery_event_stream_753
  ON pharmacy_ward_allocation_authority_recovery_events (
    tenant_id, recovery_id, created_at, id
  );

CREATE OR REPLACE FUNCTION append_ward_alloc_recovery_event_753()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  event_kind TEXT;
  event_actor UUID;
  command_hash TEXT;
  request_hash TEXT;
BEGIN
  event_kind := CASE
    WHEN TG_OP='INSERT' THEN 'CREATED'
    WHEN OLD.status='RESOLVED' AND NEW.status='OPEN' THEN 'REOPENED'
    WHEN OLD.status='OPEN' AND NEW.status='RESOLVED' THEN 'RESOLVED'
    ELSE 'REFRESHED'
  END;
  event_actor := CASE WHEN event_kind IN ('REOPENED', 'RESOLVED') THEN COALESCE(
    NEW.resolved_by,
    NULLIF(current_setting('app.pharmacy_recovery_actor_uid', TRUE), '')::uuid
  ) ELSE NULL END;
  command_hash := CASE WHEN event_kind IN ('REOPENED', 'RESOLVED') THEN NULLIF(
    current_setting('app.pharmacy_recovery_command_key_sha256', TRUE), ''
  ) ELSE NULL END;
  request_hash := CASE WHEN event_kind IN ('REOPENED', 'RESOLVED') THEN
    NULLIF(current_setting('app.pharmacy_recovery_request_sha256', TRUE), '')
  ELSE NULL END;
  INSERT INTO pharmacy_ward_allocation_authority_recovery_events (
    tenant_id, recovery_id, event_type, actor_uid, request_id,
    command_key_sha256, request_sha256, request_payload, resolution_payload,
    target_identity, target_before, target_after, contract_version,
    before_authority, after_authority
  ) VALUES (
    NEW.tenant_id, NEW.id, event_kind, event_actor,
    CASE WHEN event_kind IN ('REOPENED', 'RESOLVED') THEN
      NULLIF(current_setting('app.pharmacy_recovery_request_id', TRUE), '')
    ELSE NULL END,
    command_hash, request_hash,
    CASE WHEN command_hash IS NULL THEN NULL ELSE
      NULLIF(current_setting('app.pharmacy_recovery_request_payload', TRUE), '')::jsonb END,
    CASE WHEN command_hash IS NULL THEN NULL ELSE
      NULLIF(current_setting('app.pharmacy_recovery_resolution_payload', TRUE), '')::jsonb END,
    CASE WHEN command_hash IS NULL THEN NULL ELSE
      NULLIF(current_setting('app.pharmacy_recovery_target_identity', TRUE), '')::jsonb END,
    CASE WHEN command_hash IS NULL THEN NULL ELSE
      NULLIF(current_setting('app.pharmacy_recovery_target_before', TRUE), '')::jsonb END,
    CASE
      WHEN event_kind='REOPENED' THEN to_jsonb(NEW)
      WHEN command_hash IS NULL THEN NULL
      ELSE NULLIF(current_setting('app.pharmacy_recovery_target_after', TRUE), '')::jsonb
    END,
    CASE WHEN command_hash IS NULL THEN NULL ELSE 1 END,
    CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE NULL END,
    to_jsonb(NEW)
  );
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_ward_alloc_recovery_event_753
AFTER INSERT OR UPDATE ON pharmacy_ward_allocation_authority_recovery
FOR EACH ROW EXECUTE FUNCTION append_ward_alloc_recovery_event_753();

CREATE TRIGGER trg_ward_alloc_recovery_events_append_only_753
BEFORE UPDATE OR DELETE ON pharmacy_ward_allocation_authority_recovery_events
FOR EACH ROW EXECUTE FUNCTION reject_pharmacy_authority_recovery_event_mutation_753();

ALTER TABLE pharmacy_ward_allocation_authority_recovery ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_ward_allocation_authority_recovery FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pharmacy_ward_allocation_authority_recovery
  USING (
    current_setting('app.current_tenant_id', TRUE) = 'bypass'
    OR tenant_id = public.app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', TRUE) = 'bypass'
    OR tenant_id = public.app_current_tenant_id_uuid()
  );
ALTER TABLE pharmacy_ward_allocation_authority_recovery_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_ward_allocation_authority_recovery_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pharmacy_ward_allocation_authority_recovery_events
  USING (
    current_setting('app.current_tenant_id', TRUE) = 'bypass'
    OR tenant_id = public.app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', TRUE) = 'bypass'
    OR tenant_id = public.app_current_tenant_id_uuid()
  );

ALTER TABLE ward_indent_inventory_allocations
  ADD COLUMN IF NOT EXISTS authority_released_quantity NUMERIC(14, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS authority_released_by UUID,
  ADD COLUMN IF NOT EXISTS authority_released_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS authority_release_reason VARCHAR(500),
  ADD CONSTRAINT fk_ward_allocation_authority_releaser_753
    FOREIGN KEY (tenant_id, authority_released_by) REFERENCES users(tenant_id, uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT chk_ward_allocation_authority_release_quantity_753
    CHECK (
      authority_released_quantity >= 0
      AND authority_released_quantity <= reserved_quantity - issued_quantity
    ),
  ADD CONSTRAINT chk_ward_allocation_authority_release_lifecycle_753
    CHECK (
      (authority_released_quantity=0 AND authority_released_by IS NULL
        AND authority_released_at IS NULL AND authority_release_reason IS NULL)
      OR
      (authority_released_quantity>0 AND authority_released_by IS NOT NULL
        AND authority_released_at IS NOT NULL
        AND length(btrim(authority_release_reason)) BETWEEN 10 AND 500)
    );

ALTER TABLE ward_indents
  ADD COLUMN IF NOT EXISTS facility_id INTEGER,
  ADD COLUMN IF NOT EXISTS facility_authority_version INTEGER NOT NULL DEFAULT 1;

UPDATE ward_indents indent
   SET facility_id=ward.facility_id,
       facility_authority_version=1,
       updated_at=NOW()
  FROM wards ward
 WHERE ward.tenant_id=indent.tenant_id
   AND ward.id=indent.ward_id
   AND ward.facility_id IS NOT NULL
   AND indent.facility_id IS NULL;

ALTER TABLE ward_indents
  ADD CONSTRAINT fk_ward_indents_pinned_facility_753
    FOREIGN KEY (tenant_id, facility_id)
    REFERENCES facilities(tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT chk_ward_indents_facility_authority_version_753
    CHECK (facility_authority_version > 0) NOT VALID,
  ADD CONSTRAINT chk_ward_indents_pharmacy_facility_753
    CHECK (
      indent_type <> 'pharmacy'
      OR status IN ('rejected', 'cancelled', 'closed')
      OR facility_id IS NOT NULL
    ) NOT VALID;

INSERT INTO pharmacy_inventory_authority_recovery_worklist (
  tenant_id, entity_type, entity_id, facility_id, reason_code, authority_snapshot
)
SELECT indent.tenant_id, 'ward_indent', indent.id, indent.facility_id,
       'WARD_INDENT_FACILITY_UNRESOLVED',
       jsonb_build_object(
         'indent_number', indent.indent_number,
         'status', indent.status,
         'ward_id', indent.ward_id,
         'ward_facility_id', ward.facility_id,
         'pinned_facility_id', indent.facility_id,
         'allocation_count', (
           SELECT COUNT(*)
             FROM ward_indent_inventory_allocations allocation
            WHERE allocation.tenant_id=indent.tenant_id
              AND allocation.ward_indent_id=indent.id
         ),
         'issued_quantity', (
           SELECT COALESCE(SUM(allocation.issued_quantity), 0)
             FROM ward_indent_inventory_allocations allocation
            WHERE allocation.tenant_id=indent.tenant_id
              AND allocation.ward_indent_id=indent.id
         )
       )
  FROM ward_indents indent
  LEFT JOIN wards ward
    ON ward.tenant_id=indent.tenant_id AND ward.id=indent.ward_id
  LEFT JOIN facilities facility
    ON facility.tenant_id=indent.tenant_id
   AND facility.id=indent.facility_id
   AND facility.status='active'
 WHERE indent.indent_type='pharmacy'
   AND indent.status NOT IN ('rejected', 'cancelled', 'closed')
   AND facility.id IS NULL
ON CONFLICT (tenant_id, entity_type, entity_id, reason_code) DO NOTHING;

CREATE OR REPLACE FUNCTION guard_ward_indent_facility_authority_753()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.facility_id IS DISTINCT FROM OLD.facility_id
     OR NEW.facility_authority_version IS DISTINCT FROM OLD.facility_authority_version THEN
    IF OLD.facility_id IS NULL
       AND NEW.facility_id IS NOT NULL
       AND NEW.facility_authority_version=OLD.facility_authority_version+1
       AND EXISTS (
         SELECT 1
           FROM pharmacy_inventory_authority_recovery_worklist recovery
          WHERE recovery.tenant_id=OLD.tenant_id
            AND recovery.id=NULLIF(
              current_setting('app.pharmacy_ward_indent_facility_recovery_id', TRUE), ''
            )::bigint
            AND recovery.entity_type='ward_indent'
            AND recovery.entity_id=OLD.id
            AND recovery.reason_code='WARD_INDENT_FACILITY_UNRESOLVED'
            AND recovery.status='OPEN'
       ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'ward indent facility authority is immutable after creation'
      USING ERRCODE='23514', CONSTRAINT='chk_ward_indent_facility_immutable_753';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_ward_indent_facility_authority_753
BEFORE UPDATE OF facility_id, facility_authority_version ON ward_indents
FOR EACH ROW EXECUTE FUNCTION guard_ward_indent_facility_authority_753();
INSERT INTO pharmacy_inventory_authority_recovery_worklist (
  tenant_id, entity_type, entity_id, inventory_item_id,
  facility_id, catalog_id, reason_code, authority_snapshot
)
SELECT pii.tenant_id, 'inventory_item', pii.id, pii.id,
       pii.facility_id, pii.catalog_id,
       CASE
         WHEN pii.facility_id IS NULL AND pii.catalog_id IS NULL THEN 'FACILITY_AND_CATALOG_UNRESOLVED'
         WHEN pii.facility_id IS NULL THEN 'FACILITY_UNRESOLVED'
         WHEN pii.catalog_id IS NULL THEN 'CATALOG_UNRESOLVED'
         WHEN facility.id IS NULL AND EXISTS (
           SELECT 1 FROM facilities any_facility WHERE any_facility.id=pii.facility_id
         ) THEN 'FACILITY_CROSS_TENANT'
         WHEN facility.id IS NULL THEN 'FACILITY_MISSING_OR_INACTIVE'
         WHEN catalog.id IS NULL AND EXISTS (
           SELECT 1 FROM pharmacy_catalog any_catalog WHERE any_catalog.id=pii.catalog_id
         ) THEN 'CATALOG_CROSS_TENANT'
         ELSE 'CATALOG_MISSING_OR_INACTIVE'
       END,
       jsonb_build_object(
         'sku_code', pii.sku_code,
         'display_name', pii.display_name,
         'status', pii.status,
         'remaining_quantity', COALESCE(SUM(pib.remaining_quantity), 0),
         -- Candidate only. This migration never applies it; an operator
         -- resolves the worklist row and pins the facility explicitly.
         'candidate_facility_ids', COALESCE((
           SELECT jsonb_agg(facility.id ORDER BY facility.id)
             FROM facilities facility
            WHERE facility.tenant_id=pii.tenant_id
              AND facility.status='active'
              AND facility.is_default=TRUE
         ), '[]'::jsonb)
       )
  FROM pharmacy_inventory_items pii
  LEFT JOIN facilities facility
    ON facility.tenant_id=pii.tenant_id
   AND facility.id=pii.facility_id
   AND facility.status='active'
  LEFT JOIN pharmacy_catalog catalog
    ON catalog.tenant_id=pii.tenant_id
   AND catalog.id=pii.catalog_id
   AND catalog.is_active=TRUE
  LEFT JOIN pharmacy_inventory_batches pib
    ON pib.tenant_id=pii.tenant_id AND pib.inventory_item_id=pii.id
 WHERE pii.status='active'
   AND (facility.id IS NULL OR catalog.id IS NULL)
 GROUP BY pii.tenant_id, pii.id, pii.facility_id, pii.catalog_id,
          pii.sku_code, pii.display_name, pii.status, facility.id, catalog.id
ON CONFLICT (tenant_id, entity_type, entity_id, reason_code) DO NOTHING;

WITH ranked_links AS (
  SELECT ep.tenant_id, ep.id, ep.pharmacy_order_id,
         ROW_NUMBER() OVER (
           PARTITION BY ep.tenant_id, ep.pharmacy_order_id
           ORDER BY ep.id
         ) AS link_rank,
         COUNT(*) OVER (
           PARTITION BY ep.tenant_id, ep.pharmacy_order_id
         ) AS link_count
    FROM e_prescriptions ep
   WHERE ep.pharmacy_order_id IS NOT NULL
)
INSERT INTO pharmacy_inventory_authority_recovery_worklist (
  tenant_id, entity_type, entity_id, reason_code, authority_snapshot
)
SELECT ranked.tenant_id, 'e_prescription', ranked.id,
       'PRESCRIPTION_ORDER_DUPLICATE_LINK',
       jsonb_build_object(
         'pharmacy_order_id', ranked.pharmacy_order_id,
         'retained_link_rank', 1,
         'duplicate_link_rank', ranked.link_rank,
         'link_count', ranked.link_count
       )
  FROM ranked_links ranked
 WHERE ranked.link_count > 1 AND ranked.link_rank > 1
ON CONFLICT (tenant_id, entity_type, entity_id, reason_code) DO NOTHING;

UPDATE pharmacy_orders po
   SET clinical_verification_status='pending',
       clinically_verified_by=NULL,
       clinically_verified_at=NULL,
       clinical_verification_notes=NULL,
       clinically_verified_order_version=NULL,
       clinical_verification_items_sha256=NULL,
       clinical_verification_catalog_sha256=NULL,
       clinical_verification_active_therapy_sha256=NULL,
       clinical_verification_safety_version=NULL,
       clinical_verification_kb_version=NULL,
       clinical_verification_ruleset_version=NULL,
       updated_at=NOW()
 WHERE EXISTS (
   SELECT 1
     FROM pharmacy_inventory_authority_recovery_worklist recovery
    WHERE recovery.tenant_id=po.tenant_id
      AND recovery.entity_type='e_prescription'
      AND recovery.reason_code='PRESCRIPTION_ORDER_DUPLICATE_LINK'
      AND (recovery.authority_snapshot->>'pharmacy_order_id')::integer=po.id
      AND recovery.status='OPEN'
 );

UPDATE e_prescriptions ep
   SET pharmacy_order_id=NULL,
       updated_at=NOW()
 WHERE EXISTS (
   SELECT 1
     FROM pharmacy_inventory_authority_recovery_worklist recovery
    WHERE recovery.tenant_id=ep.tenant_id
      AND recovery.entity_type='e_prescription'
      AND recovery.entity_id=ep.id
      AND recovery.reason_code='PRESCRIPTION_ORDER_DUPLICATE_LINK'
      AND recovery.status='OPEN'
 );

INSERT INTO pharmacy_inventory_authority_recovery_worklist (
  tenant_id, entity_type, entity_id, reason_code, authority_snapshot
)
SELECT po.tenant_id, 'pharmacy_order', po.id, 'ORDER_STATUS_NONCANONICAL',
       jsonb_build_object('status', po.status, 'order_number', po.order_number)
  FROM pharmacy_orders po
 WHERE po.status IS NULL OR po.status <> ALL(ARRAY[
   'PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'DISPATCHED',
   'PARTIALLY_DISPENSED', 'DELIVERED', 'DISPENSED', 'UNAVAILABLE',
   'CANCELLED', 'ON_HOLD', 'REJECTED'
 ]::TEXT[])
ON CONFLICT (tenant_id, entity_type, entity_id, reason_code) DO NOTHING;

-- Governed replacement for the removed authority_origin backfill: orders with
-- neither a linked e-prescription nor a prescription photo keep a NULL origin
-- and are worklisted with the candidate value, never stamped with it.
INSERT INTO pharmacy_inventory_authority_recovery_worklist (
  tenant_id, entity_type, entity_id, facility_id, reason_code, authority_snapshot
)
SELECT po.tenant_id, 'pharmacy_order', po.id, po.facility_id,
       'ORDER_AUTHORITY_ORIGIN_UNRESOLVED',
       jsonb_build_object(
         'candidate_authority_origin', 'legacy_unresolved',
         'status', po.status,
         'order_number', po.order_number,
         'has_prescription_photo', po.prescription_photo_key IS NOT NULL,
         'linked_prescription_count', (
           SELECT COUNT(*)
             FROM e_prescriptions ep
            WHERE ep.tenant_id=po.tenant_id AND ep.pharmacy_order_id=po.id
         )
       )
  FROM pharmacy_orders po
 WHERE po.authority_origin IS NULL
ON CONFLICT (tenant_id, entity_type, entity_id, reason_code) DO NOTHING;

-- Governed replacement for the removed tenant-default facility backfill. The
-- candidate default facilities are carried in the snapshot for an operator to
-- confirm; facility_id itself stays NULL and
-- chk_pharmacy_orders_facility_progression_753 holds the order.
INSERT INTO pharmacy_inventory_authority_recovery_worklist (
  tenant_id, entity_type, entity_id, reason_code, authority_snapshot
)
SELECT po.tenant_id, 'pharmacy_order', po.id, 'ORDER_FACILITY_UNRESOLVED',
       jsonb_build_object(
         'status', po.status,
         'order_number', po.order_number,
         'delivery_type', po.delivery_type,
         'candidate_facility_ids', COALESCE((
           SELECT jsonb_agg(facility.id ORDER BY facility.id)
             FROM facilities facility
            WHERE facility.tenant_id=po.tenant_id
              AND facility.status='active'
              AND facility.is_default=TRUE
         ), '[]'::jsonb)
       )
  FROM pharmacy_orders po
 WHERE po.facility_id IS NULL
   AND po.status NOT IN ('CANCELLED', 'DELIVERED', 'DISPENSED', 'UNAVAILABLE')
ON CONFLICT (tenant_id, entity_type, entity_id, reason_code) DO NOTHING;

INSERT INTO pharmacy_inventory_authority_recovery_worklist (
  tenant_id, entity_type, entity_id, reason_code, authority_snapshot
)
SELECT ep.tenant_id, 'e_prescription', ep.id, 'PRESCRIPTION_ORDER_PATIENT_MISMATCH',
       jsonb_build_object(
         'pharmacy_order_id', ep.pharmacy_order_id,
         'prescription_patient_id', ep.patient_id,
         'prescription_patient_uid', ep.patient_uid,
         'order_patient_id', po.patient_id,
         'resolved_patient_uid', patient.uid
       )
  FROM e_prescriptions ep
  LEFT JOIN pharmacy_orders po
    ON po.tenant_id=ep.tenant_id AND po.id=ep.pharmacy_order_id
  LEFT JOIN users patient
    ON patient.tenant_id=ep.tenant_id
   AND patient.id=ep.patient_id
   AND patient.uid=ep.patient_uid
   AND patient.role='PATIENT'
   AND patient.is_active=TRUE
   AND patient.status='active'
   AND patient.is_deleted=FALSE
   AND patient.merged_into_uid IS NULL
 WHERE ep.pharmacy_order_id IS NOT NULL
   AND (
     po.id IS NULL OR ep.patient_id IS NULL OR ep.patient_uid IS NULL
     OR po.patient_id IS NULL OR ep.patient_id IS DISTINCT FROM po.patient_id
     OR patient.id IS NULL
   )
ON CONFLICT (tenant_id, entity_type, entity_id, reason_code) DO NOTHING;

UPDATE pharmacy_orders po
   SET clinical_verification_status='pending',
       clinically_verified_by=NULL,
       clinically_verified_at=NULL,
       clinical_verification_notes=NULL,
       clinically_verified_order_version=NULL,
       clinical_verification_items_sha256=NULL,
       clinical_verification_catalog_sha256=NULL,
       clinical_verification_active_therapy_sha256=NULL,
       clinical_verification_safety_version=NULL,
       clinical_verification_kb_version=NULL,
       clinical_verification_ruleset_version=NULL,
       updated_at=NOW()
 WHERE EXISTS (
   SELECT 1
     FROM pharmacy_inventory_authority_recovery_worklist recovery
    WHERE recovery.tenant_id=po.tenant_id
      AND recovery.entity_type='e_prescription'
      AND recovery.reason_code='PRESCRIPTION_ORDER_PATIENT_MISMATCH'
      AND (recovery.authority_snapshot->>'pharmacy_order_id')::integer=po.id
      AND recovery.status='OPEN'
 );

INSERT INTO pharmacy_inventory_authority_recovery_worklist (
  tenant_id, entity_type, entity_id, inventory_item_id,
  facility_id, catalog_id, reason_code, authority_snapshot
)
SELECT pii.tenant_id, 'inventory_item', pii.id, pii.id,
       pii.facility_id, pii.catalog_id, 'DEFAULT_SUPPLIER_TENANT_MISMATCH',
       jsonb_build_object('default_supplier_id', pii.default_supplier_id)
  FROM pharmacy_inventory_items pii
  LEFT JOIN pharmacy_suppliers supplier
    ON supplier.tenant_id=pii.tenant_id AND supplier.id=pii.default_supplier_id
 WHERE pii.default_supplier_id IS NOT NULL AND supplier.id IS NULL
ON CONFLICT (tenant_id, entity_type, entity_id, reason_code) DO NOTHING;

UPDATE pharmacy_inventory_items pii
   SET default_supplier_id=NULL,
       metadata=COALESCE(pii.metadata, '{}'::jsonb)
         || jsonb_build_object('supplier_authority_recovery_required', TRUE),
       updated_at=NOW()
 WHERE pii.default_supplier_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM pharmacy_suppliers supplier
      WHERE supplier.tenant_id=pii.tenant_id AND supplier.id=pii.default_supplier_id
   );

INSERT INTO pharmacy_inventory_authority_recovery_worklist (
  tenant_id, entity_type, entity_id, inventory_item_id,
  facility_id, reason_code, authority_snapshot
)
SELECT pib.tenant_id, 'inventory_batch', pib.id, pib.inventory_item_id,
       pib.facility_id, 'BATCH_SUPPLIER_TENANT_MISMATCH',
       jsonb_build_object('supplier_id', pib.supplier_id)
  FROM pharmacy_inventory_batches pib
  LEFT JOIN pharmacy_suppliers supplier
    ON supplier.tenant_id=pib.tenant_id AND supplier.id=pib.supplier_id
 WHERE pib.supplier_id IS NOT NULL AND supplier.id IS NULL
ON CONFLICT (tenant_id, entity_type, entity_id, reason_code) DO NOTHING;

UPDATE pharmacy_inventory_batches pib
   SET supplier_id=NULL,
       metadata=COALESCE(pib.metadata, '{}'::jsonb)
         || jsonb_build_object('supplier_authority_recovery_required', TRUE),
       updated_at=NOW()
 WHERE pib.supplier_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM pharmacy_suppliers supplier
      WHERE supplier.tenant_id=pib.tenant_id AND supplier.id=pib.supplier_id
   );

INSERT INTO pharmacy_inventory_authority_recovery_worklist (
  tenant_id, entity_type, entity_id, facility_id, reason_code, authority_snapshot
)
SELECT po.tenant_id, 'purchase_order', po.id, po.facility_id,
       'PURCHASE_ORDER_AUTHORITY_MISMATCH',
       jsonb_build_object('supplier_id', po.supplier_id, 'status', po.status)
  FROM pharmacy_purchase_orders po
  LEFT JOIN pharmacy_suppliers supplier
    ON supplier.tenant_id=po.tenant_id AND supplier.id=po.supplier_id
  LEFT JOIN facilities facility
    ON facility.tenant_id=po.tenant_id AND facility.id=po.facility_id
 WHERE supplier.id IS NULL OR po.facility_id IS NULL OR facility.id IS NULL
ON CONFLICT (tenant_id, entity_type, entity_id, reason_code) DO NOTHING;

UPDATE pharmacy_purchase_orders po
   SET status='draft',
       metadata=COALESCE(po.metadata, '{}'::jsonb)
         || jsonb_build_object('authority_recovery_required', TRUE),
       updated_at=NOW()
 WHERE EXISTS (
   SELECT 1 FROM pharmacy_inventory_authority_recovery_worklist recovery
    WHERE recovery.tenant_id=po.tenant_id
      AND recovery.entity_type='purchase_order'
      AND recovery.entity_id=po.id
      AND recovery.status='OPEN'
 )
   AND po.status NOT IN ('cancelled', 'closed');

INSERT INTO pharmacy_inventory_authority_recovery_worklist (
  tenant_id, entity_type, entity_id, inventory_item_id,
  reason_code, authority_snapshot
)
SELECT poi.tenant_id, 'purchase_order_item', poi.id, poi.inventory_item_id,
       'PURCHASE_ORDER_ITEM_AUTHORITY_MISMATCH',
       jsonb_build_object('purchase_order_id', poi.purchase_order_id)
  FROM pharmacy_purchase_order_items poi
  LEFT JOIN pharmacy_purchase_orders po
    ON po.tenant_id=poi.tenant_id AND po.id=poi.purchase_order_id
 LEFT JOIN pharmacy_inventory_items pii
    ON pii.tenant_id=poi.tenant_id AND pii.id=poi.inventory_item_id
 WHERE po.id IS NULL OR pii.id IS NULL
   OR po.facility_id IS DISTINCT FROM pii.facility_id
ON CONFLICT (tenant_id, entity_type, entity_id, reason_code) DO NOTHING;

INSERT INTO pharmacy_inventory_authority_recovery_worklist (
  tenant_id, entity_type, entity_id, facility_id, reason_code, authority_snapshot
)
SELECT grn.tenant_id, 'goods_receipt', grn.id, grn.facility_id,
       'GOODS_RECEIPT_AUTHORITY_MISMATCH',
       jsonb_build_object(
         'purchase_order_id', grn.purchase_order_id,
         'supplier_id', grn.supplier_id,
         'status', grn.status
       )
  FROM pharmacy_goods_receipts grn
  LEFT JOIN pharmacy_purchase_orders po
    ON po.tenant_id=grn.tenant_id AND po.id=grn.purchase_order_id
  LEFT JOIN pharmacy_suppliers supplier
    ON supplier.tenant_id=grn.tenant_id AND supplier.id=grn.supplier_id
  LEFT JOIN facilities facility
    ON facility.tenant_id=grn.tenant_id AND facility.id=grn.facility_id
 WHERE grn.facility_id IS NULL OR facility.id IS NULL
   OR (grn.purchase_order_id IS NOT NULL AND po.id IS NULL)
   OR (grn.supplier_id IS NOT NULL AND supplier.id IS NULL)
   OR (po.id IS NOT NULL AND (
     po.facility_id IS DISTINCT FROM grn.facility_id
     OR po.supplier_id IS DISTINCT FROM grn.supplier_id
   ))
ON CONFLICT (tenant_id, entity_type, entity_id, reason_code) DO NOTHING;

UPDATE pharmacy_goods_receipts grn
   SET status='qc_failed',
       metadata=COALESCE(grn.metadata, '{}'::jsonb)
         || jsonb_build_object('authority_recovery_required', TRUE),
       updated_at=NOW()
 WHERE EXISTS (
   SELECT 1 FROM pharmacy_inventory_authority_recovery_worklist recovery
    WHERE recovery.tenant_id=grn.tenant_id
      AND recovery.entity_type='goods_receipt'
      AND recovery.entity_id=grn.id
      AND recovery.status='OPEN'
 )
   AND grn.status NOT IN ('rejected', 'archived');

INSERT INTO pharmacy_inventory_authority_recovery_worklist (
  tenant_id, entity_type, entity_id, inventory_item_id,
  reason_code, authority_snapshot
)
SELECT gri.tenant_id, 'goods_receipt_item', gri.id, gri.inventory_item_id,
       'GOODS_RECEIPT_ITEM_AUTHORITY_MISMATCH',
       jsonb_build_object(
         'goods_receipt_id', gri.goods_receipt_id,
         'inventory_batch_id', gri.inventory_batch_id,
         'purchase_order_item_id', gri.purchase_order_item_id
       )
  FROM pharmacy_goods_receipt_items gri
  LEFT JOIN pharmacy_goods_receipts grn
    ON grn.tenant_id=gri.tenant_id AND grn.id=gri.goods_receipt_id
  LEFT JOIN pharmacy_inventory_items pii
    ON pii.tenant_id=gri.tenant_id AND pii.id=gri.inventory_item_id
  LEFT JOIN pharmacy_inventory_batches pib
    ON pib.tenant_id=gri.tenant_id AND pib.id=gri.inventory_batch_id
  LEFT JOIN pharmacy_purchase_order_items poi
    ON poi.tenant_id=gri.tenant_id AND poi.id=gri.purchase_order_item_id
  LEFT JOIN pharmacy_purchase_orders po
    ON po.tenant_id=poi.tenant_id AND po.id=poi.purchase_order_id
 WHERE grn.id IS NULL OR pii.id IS NULL
   OR (gri.inventory_batch_id IS NOT NULL AND pib.id IS NULL)
   OR (gri.purchase_order_item_id IS NOT NULL AND poi.id IS NULL)
   OR (grn.id IS NOT NULL AND po.id IS NOT NULL AND (
     grn.purchase_order_id IS DISTINCT FROM po.id
     OR grn.facility_id IS DISTINCT FROM po.facility_id
     OR grn.supplier_id IS DISTINCT FROM po.supplier_id
   ))
   OR (poi.id IS NOT NULL AND poi.inventory_item_id IS DISTINCT FROM gri.inventory_item_id)
   OR (pib.id IS NOT NULL AND (
     pib.inventory_item_id IS DISTINCT FROM gri.inventory_item_id
     OR pib.facility_id IS DISTINCT FROM grn.facility_id
     OR pib.goods_receipt_id IS DISTINCT FROM grn.id
   ))
ON CONFLICT (tenant_id, entity_type, entity_id, reason_code) DO NOTHING;

INSERT INTO pharmacy_inventory_authority_recovery_worklist (
  tenant_id, entity_type, entity_id, inventory_item_id,
  facility_id, catalog_id, reason_code, authority_snapshot
)
SELECT pib.tenant_id, 'inventory_batch', pib.id, pib.inventory_item_id,
       pib.facility_id, pii.catalog_id, 'BATCH_ITEM_AUTHORITY_MISMATCH',
       jsonb_build_object(
         'batch_number', pib.batch_number,
         'batch_status', pib.status,
         'remaining_quantity', pib.remaining_quantity,
         'item_facility_id', pii.facility_id
       )
  FROM pharmacy_inventory_batches pib
  LEFT JOIN pharmacy_inventory_items pii
    ON pii.tenant_id=pib.tenant_id AND pii.id=pib.inventory_item_id
  LEFT JOIN facilities facility
    ON facility.tenant_id=pii.tenant_id
   AND facility.id=pii.facility_id
   AND facility.status='active'
  LEFT JOIN pharmacy_catalog catalog
    ON catalog.tenant_id=pii.tenant_id
   AND catalog.id=pii.catalog_id
   AND catalog.is_active=TRUE
  LEFT JOIN pharmacy_goods_receipts grn
    ON grn.tenant_id=pib.tenant_id AND grn.id=pib.goods_receipt_id
 WHERE pib.status IN ('in_stock', 'reserved')
   AND (
     pii.id IS NULL
     OR pib.facility_id IS NULL
     OR facility.id IS NULL
     OR catalog.id IS NULL
     OR pib.facility_id IS DISTINCT FROM pii.facility_id
     OR (pib.goods_receipt_id IS NOT NULL AND (
       grn.id IS NULL
       OR grn.facility_id IS DISTINCT FROM pib.facility_id
       OR (pib.supplier_id IS NOT NULL
         AND grn.supplier_id IS DISTINCT FROM pib.supplier_id)
     ))
   )
ON CONFLICT (tenant_id, entity_type, entity_id, reason_code) DO NOTHING;

UPDATE pharmacy_inventory_items
   SET status='paused',
       metadata=COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
         'inventory_authority_recovery_required', TRUE,
         'inventory_authority_quarantined_by', 'migration_753'
       ),
       updated_at=NOW()
 WHERE status='active'
   AND (
     NOT EXISTS (
       SELECT 1 FROM facilities facility
        WHERE facility.tenant_id=pharmacy_inventory_items.tenant_id
          AND facility.id=pharmacy_inventory_items.facility_id
          AND facility.status='active'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pharmacy_catalog catalog
        WHERE catalog.tenant_id=pharmacy_inventory_items.tenant_id
          AND catalog.id=pharmacy_inventory_items.catalog_id
          AND catalog.is_active=TRUE
     )
   );

UPDATE pharmacy_inventory_batches pib
   SET status='quarantined',
       metadata=COALESCE(pib.metadata, '{}'::jsonb) || jsonb_build_object(
         'inventory_authority_recovery_required', TRUE,
         'inventory_authority_quarantined_by', 'migration_753'
       ),
       updated_at=NOW()
 WHERE pib.status IN ('in_stock', 'reserved')
   AND EXISTS (
     SELECT 1
       FROM pharmacy_inventory_authority_recovery_worklist recovery
      WHERE recovery.tenant_id=pib.tenant_id
        AND recovery.entity_type='inventory_batch'
        AND recovery.entity_id=pib.id
        AND recovery.reason_code='BATCH_ITEM_AUTHORITY_MISMATCH'
        AND recovery.status='OPEN'
   );

INSERT INTO pharmacy_ward_allocation_authority_recovery (
  tenant_id, allocation_id, ward_indent_id, ward_indent_item_id,
  inventory_item_id, inventory_batch_id, facility_id, catalog_id,
  reason_code, authority_snapshot
)
SELECT allocation.tenant_id, allocation.id, allocation.ward_indent_id,
       allocation.ward_indent_item_id, allocation.inventory_item_id,
       allocation.inventory_batch_id,
       COALESCE(batch.facility_id, item.facility_id, indent.facility_id),
       COALESCE(ward_item.pharmacy_catalog_id, item.catalog_id),
       CASE
         WHEN item.id IS NULL THEN 'WARD_ALLOCATION_ITEM_AUTHORITY_MISSING'
         WHEN batch.id IS NULL THEN 'WARD_ALLOCATION_BATCH_AUTHORITY_MISSING'
         WHEN facility.id IS NULL
           OR batch.facility_id IS DISTINCT FROM item.facility_id
           OR indent.facility_id IS DISTINCT FROM item.facility_id
           THEN 'WARD_ALLOCATION_FACILITY_AUTHORITY_INVALID'
         WHEN catalog.id IS NULL OR catalog.is_active=FALSE
           OR ward_item.pharmacy_catalog_id IS DISTINCT FROM item.catalog_id
           THEN 'WARD_ALLOCATION_CATALOG_AUTHORITY_INVALID'
         ELSE 'WARD_ALLOCATION_LINEAGE_AUTHORITY_MISMATCH'
       END,
       jsonb_build_object(
         'migration', 753,
         'allocation_id', allocation.id::text,
         'allocation_status', allocation.status,
         'reserved_quantity', allocation.reserved_quantity,
         'issued_quantity', allocation.issued_quantity,
         'received_quantity', allocation.received_quantity,
         'consumed_quantity', allocation.consumed_quantity,
         'returned_quantity', allocation.returned_quantity,
         'ward_indent_facility_id', indent.facility_id,
         'ward_catalog_id', ward_item.pharmacy_catalog_id,
         'inventory_item_facility_id', item.facility_id,
         'inventory_item_catalog_id', item.catalog_id,
         'inventory_item_status', item.status,
         'inventory_batch_facility_id', batch.facility_id,
         'inventory_batch_status', batch.status,
         'catalog_active', catalog.is_active
       )
  FROM ward_indent_inventory_allocations allocation
  JOIN ward_indents indent
    ON indent.tenant_id=allocation.tenant_id
   AND indent.id=allocation.ward_indent_id
  JOIN ward_indent_items ward_item
    ON ward_item.tenant_id=allocation.tenant_id
   AND ward_item.id=allocation.ward_indent_item_id
   AND ward_item.ward_indent_id=allocation.ward_indent_id
  LEFT JOIN pharmacy_inventory_items item
    ON item.tenant_id=allocation.tenant_id
   AND item.id=allocation.inventory_item_id
  LEFT JOIN pharmacy_inventory_batches batch
    ON batch.tenant_id=allocation.tenant_id
   AND batch.id=allocation.inventory_batch_id
   AND batch.inventory_item_id=allocation.inventory_item_id
  LEFT JOIN facilities facility
    ON facility.tenant_id=allocation.tenant_id
   AND facility.id=COALESCE(batch.facility_id, item.facility_id, indent.facility_id)
   AND facility.status='active'
  LEFT JOIN pharmacy_catalog catalog
    ON catalog.tenant_id=allocation.tenant_id
   AND catalog.id=COALESCE(ward_item.pharmacy_catalog_id, item.catalog_id)
 WHERE allocation.status IN ('issued', 'partially_issued')
   AND allocation.issued_quantity>0
   AND (
     item.id IS NULL OR batch.id IS NULL OR facility.id IS NULL
     OR batch.facility_id IS DISTINCT FROM item.facility_id
     OR indent.facility_id IS DISTINCT FROM item.facility_id
     OR catalog.id IS NULL OR catalog.is_active=FALSE
     OR ward_item.pharmacy_catalog_id IS DISTINCT FROM item.catalog_id
     OR item.status<>'active'
     OR batch.status NOT IN ('in_stock', 'reserved', 'issued', 'depleted', 'quarantined')
   )
ON CONFLICT (tenant_id, allocation_id, reason_code) DO NOTHING;

ALTER TABLE pharmacy_inventory_items
  DROP CONSTRAINT IF EXISTS fk_pharmacy_inventory_items_facility_tenant_753,
  DROP CONSTRAINT IF EXISTS fk_pharmacy_inventory_items_catalog_tenant_753,
  DROP CONSTRAINT IF EXISTS chk_pharmacy_inventory_items_active_authority_753,
  ADD CONSTRAINT fk_pharmacy_inventory_items_facility_tenant_753
    FOREIGN KEY (tenant_id, facility_id)
    REFERENCES facilities (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT fk_pharmacy_inventory_items_catalog_tenant_753
    FOREIGN KEY (tenant_id, catalog_id)
    REFERENCES pharmacy_catalog (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT chk_pharmacy_inventory_items_active_authority_753
    CHECK (status <> 'active' OR (facility_id IS NOT NULL AND catalog_id IS NOT NULL)) NOT VALID;

INSERT INTO pharmacy_inventory_authority_recovery_worklist (
  tenant_id, entity_type, entity_id, facility_id, reason_code, authority_snapshot
)
SELECT po.tenant_id, 'pharmacy_order', po.id, po.facility_id,
       'ORDER_PATIENT_TENANT_MISMATCH',
       jsonb_build_object(
         'patient_id', po.patient_id,
         'status', po.status,
         'order_number', po.order_number
       )
  FROM pharmacy_orders po
  LEFT JOIN users patient
    ON patient.tenant_id=po.tenant_id
   AND patient.id=po.patient_id
   AND patient.role='PATIENT'
   AND patient.is_active=TRUE
   AND patient.status='active'
   AND patient.is_deleted=FALSE
   AND patient.merged_into_uid IS NULL
 WHERE po.patient_id IS NOT NULL AND patient.id IS NULL
ON CONFLICT (tenant_id, entity_type, entity_id, reason_code) DO NOTHING;

UPDATE pharmacy_orders po
   SET patient_id=NULL,
       inventory_authority_version=inventory_authority_version+1,
       clinical_verification_status='pending',
       clinically_verified_by=NULL,
       clinically_verified_at=NULL,
       clinical_verification_notes=NULL,
       clinically_verified_order_version=NULL,
       clinical_verification_items_sha256=NULL,
       clinical_verification_catalog_sha256=NULL,
       clinical_verification_active_therapy_sha256=NULL,
       clinical_verification_safety_version=NULL,
       clinical_verification_kb_version=NULL,
       clinical_verification_ruleset_version=NULL,
       updated_at=NOW()
 WHERE EXISTS (
   SELECT 1
     FROM pharmacy_inventory_authority_recovery_worklist recovery
    WHERE recovery.tenant_id=po.tenant_id
      AND recovery.entity_type='pharmacy_order'
      AND recovery.entity_id=po.id
      AND recovery.reason_code='ORDER_PATIENT_TENANT_MISMATCH'
      AND recovery.status='OPEN'
 );

ALTER TABLE pharmacy_inventory_authority_recovery_worklist ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_inventory_authority_recovery_worklist FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON pharmacy_inventory_authority_recovery_worklist;
DROP POLICY IF EXISTS tenant_context_required ON pharmacy_inventory_authority_recovery_worklist;
CREATE POLICY tenant_isolation ON pharmacy_inventory_authority_recovery_worklist
  AS PERMISSIVE
  USING (tenant_id = public.app_current_tenant_id_uuid())
  WITH CHECK (tenant_id = public.app_current_tenant_id_uuid());
CREATE POLICY tenant_context_required ON pharmacy_inventory_authority_recovery_worklist
  AS RESTRICTIVE
  USING (public.app_current_tenant_id_uuid() IS NOT NULL)
  WITH CHECK (public.app_current_tenant_id_uuid() IS NOT NULL);

ALTER TABLE pharmacy_orders
  DROP CONSTRAINT IF EXISTS fk_pharmacy_orders_facility_tenant_753,
  DROP CONSTRAINT IF EXISTS fk_pharmacy_orders_patient_tenant_753,
  DROP CONSTRAINT IF EXISTS chk_pharmacy_orders_inventory_authority_version_753,
  DROP CONSTRAINT IF EXISTS chk_pharmacy_orders_authority_origin_753,
  DROP CONSTRAINT IF EXISTS chk_pharmacy_orders_facility_progression_753,
  DROP CONSTRAINT IF EXISTS chk_pharmacy_orders_verification_provenance_753,
  DROP CONSTRAINT IF EXISTS chk_pharmacy_orders_legacy_verification_753,
  DROP CONSTRAINT IF EXISTS chk_pharmacy_orders_rejected_hold_753,
  DROP CONSTRAINT IF EXISTS fk_pharmacy_orders_verifier_tenant_753,
  DROP CONSTRAINT IF EXISTS fk_pharmacy_orders_assigned_pharmacist_tenant_753,
  DROP CONSTRAINT IF EXISTS fk_pharmacy_orders_funding_admission_tenant_753,
  DROP CONSTRAINT IF EXISTS chk_pharmacy_orders_funding_admission_authority_753,
  ADD CONSTRAINT fk_pharmacy_orders_facility_tenant_753
    FOREIGN KEY (tenant_id, facility_id)
    REFERENCES facilities (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    NOT VALID,
  ADD CONSTRAINT fk_pharmacy_orders_patient_tenant_753
    FOREIGN KEY (tenant_id, patient_id)
    REFERENCES users (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  ADD CONSTRAINT chk_pharmacy_orders_inventory_authority_version_753
    CHECK (inventory_authority_version > 0) NOT VALID,
  ADD CONSTRAINT chk_pharmacy_orders_authority_origin_753
    CHECK (authority_origin IN ('e_prescription', 'patient_manual', 'legacy_unresolved')) NOT VALID,
  ADD CONSTRAINT chk_pharmacy_orders_facility_progression_753
    CHECK (
      facility_id IS NOT NULL
      OR status IN ('CANCELLED', 'DELIVERED', 'DISPENSED', 'UNAVAILABLE')
    ) NOT VALID,
  ADD CONSTRAINT chk_pharmacy_orders_legacy_verification_753
    CHECK (
      legacy_verification_grandfathered = FALSE
      OR status IN ('CANCELLED', 'DELIVERED', 'DISPENSED', 'UNAVAILABLE')
    ) NOT VALID,
  ADD CONSTRAINT chk_pharmacy_orders_rejected_hold_753
    CHECK (
      clinical_verification_status <> 'rejected'
      OR status IN ('ON_HOLD', 'CANCELLED', 'UNAVAILABLE')
    ) NOT VALID,
  ADD CONSTRAINT fk_pharmacy_orders_verifier_tenant_753
    FOREIGN KEY (tenant_id, clinically_verified_by)
    REFERENCES users (tenant_id, uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT fk_pharmacy_orders_assigned_pharmacist_tenant_753
    FOREIGN KEY (tenant_id, assigned_pharmacist)
    REFERENCES users (tenant_id, uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT fk_pharmacy_orders_funding_admission_tenant_753
    FOREIGN KEY (tenant_id, funding_admission_id)
    REFERENCES admissions (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT chk_pharmacy_orders_funding_admission_authority_753
    CHECK (
      (funding_admission_id IS NULL
       AND funding_admission_order_version IS NULL
       AND funding_admission_items_sha256 IS NULL)
      OR
      (funding_admission_id IS NOT NULL
       AND funding_admission_order_version > 0
       AND funding_admission_items_sha256 ~ '^[0-9a-f]{64}$')
    ) NOT VALID,
  ADD CONSTRAINT chk_pharmacy_orders_verification_provenance_753
    CHECK (
      clinical_verification_status NOT IN ('verified', 'override')
      OR (
        legacy_verification_grandfathered = TRUE
        AND status IN ('CANCELLED', 'DELIVERED', 'DISPENSED', 'UNAVAILABLE')
      )
      OR (
        clinically_verified_order_version IS NOT NULL
        AND clinically_verified_order_version = inventory_authority_version
        AND clinical_verification_items_sha256 IS NOT NULL
        AND clinical_verification_items_sha256 ~ '^[0-9a-f]{64}$'
        AND clinical_verification_catalog_sha256 IS NOT NULL
        AND clinical_verification_catalog_sha256 ~ '^[0-9a-f]{64}$'
        AND (
          patient_id IS NULL
          OR (
            clinical_verification_active_therapy_sha256 IS NOT NULL
            AND clinical_verification_active_therapy_sha256 ~ '^[0-9a-f]{64}$'
          )
        )
        AND clinical_verification_kb_version IS NOT NULL
        AND clinical_verification_ruleset_version IS NOT NULL
        AND clinical_verification_ruleset_version > 0
        AND clinically_verified_by IS NOT NULL
        AND clinically_verified_at IS NOT NULL
        AND (patient_id IS NULL OR clinical_verification_safety_version IS NOT NULL)
      )
    ) NOT VALID;

CREATE INDEX IF NOT EXISTS idx_pharmacy_orders_facility_queue_753
  ON pharmacy_orders (tenant_id, facility_id, status, created_at, id)
  WHERE facility_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.invalidate_pharmacy_order_patient_change_753()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.patient_id IS DISTINCT FROM OLD.patient_id THEN
    NEW.inventory_authority_version := COALESCE(OLD.inventory_authority_version, 1) + 1;
    NEW.clinical_verification_status := 'pending';
    NEW.clinically_verified_by := NULL;
    NEW.clinically_verified_at := NULL;
    NEW.clinical_verification_notes := NULL;
    NEW.clinically_verified_order_version := NULL;
    NEW.clinical_verification_items_sha256 := NULL;
    NEW.clinical_verification_catalog_sha256 := NULL;
    NEW.clinical_verification_active_therapy_sha256 := NULL;
    NEW.clinical_verification_safety_version := NULL;
    NEW.clinical_verification_kb_version := NULL;
    NEW.clinical_verification_ruleset_version := NULL;
    NEW.updated_at := NOW();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pharmacy_order_patient_change_753 ON pharmacy_orders;
CREATE TRIGGER trg_pharmacy_order_patient_change_753
BEFORE UPDATE OF patient_id ON pharmacy_orders
FOR EACH ROW
EXECUTE FUNCTION public.invalidate_pharmacy_order_patient_change_753();

CREATE TABLE IF NOT EXISTS pharmacy_patient_safety_versions (
  tenant_id  UUID NOT NULL,
  patient_id INTEGER NOT NULL,
  version    BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, patient_id),
  CONSTRAINT chk_pharmacy_patient_safety_version_753 CHECK (version > 0),
  CONSTRAINT fk_pharmacy_patient_safety_patient_753
    FOREIGN KEY (tenant_id, patient_id)
    REFERENCES users (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pharmacy_clinical_knowledge_revision (
  singleton  BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  version    BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO pharmacy_clinical_knowledge_revision (singleton, version)
VALUES (TRUE, 1)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS pharmacy_order_command_receipts (
  id                 BIGSERIAL PRIMARY KEY,
  tenant_id          UUID NOT NULL,
  pharmacy_order_id  INTEGER NOT NULL,
  action             VARCHAR(64) NOT NULL,
  command_key_sha256 CHAR(64) NOT NULL,
  request_sha256     CHAR(64) NOT NULL,
  response_payload   JSONB NOT NULL,
  response_message   VARCHAR(255),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_pharmacy_order_command_receipt_hashes_753 CHECK (
    command_key_sha256 ~ '^[0-9a-f]{64}$' AND request_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT fk_pharmacy_order_command_receipt_order_753
    FOREIGN KEY (tenant_id, pharmacy_order_id)
    REFERENCES pharmacy_orders (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_order_command_receipts_753
  ON pharmacy_order_command_receipts (tenant_id, pharmacy_order_id, action, command_key_sha256);
CREATE INDEX IF NOT EXISTS idx_pharmacy_order_command_receipts_order_753
  ON pharmacy_order_command_receipts (tenant_id, pharmacy_order_id, created_at DESC);
CREATE OR REPLACE FUNCTION reject_pharmacy_order_command_receipt_mutation_753()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pharmacy order command receipts are append-only'
    USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER trg_pharmacy_order_command_receipts_append_only_753
BEFORE UPDATE OR DELETE ON pharmacy_order_command_receipts
FOR EACH ROW EXECUTE FUNCTION reject_pharmacy_order_command_receipt_mutation_753();
ALTER TABLE pharmacy_order_command_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_order_command_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON pharmacy_order_command_receipts;
DROP POLICY IF EXISTS tenant_context_required ON pharmacy_order_command_receipts;
CREATE POLICY tenant_isolation ON pharmacy_order_command_receipts
  AS PERMISSIVE
  USING (tenant_id = public.app_current_tenant_id_uuid())
  WITH CHECK (tenant_id = public.app_current_tenant_id_uuid());
CREATE POLICY tenant_context_required ON pharmacy_order_command_receipts
  AS RESTRICTIVE
  USING (public.app_current_tenant_id_uuid() IS NOT NULL)
  WITH CHECK (public.app_current_tenant_id_uuid() IS NOT NULL);

CREATE TABLE IF NOT EXISTS pharmacy_delivery_custody_events (
  id                    BIGSERIAL PRIMARY KEY,
  tenant_id             UUID NOT NULL,
  pharmacy_order_id     INTEGER NOT NULL,
  facility_id           INTEGER NOT NULL,
  event_type            VARCHAR(32) NOT NULL,
  actor_uid             UUID NOT NULL,
  actor_role            VARCHAR(64) NOT NULL,
  command_key_sha256    CHAR(64) NOT NULL,
  request_sha256        CHAR(64) NOT NULL,
  order_authority_version INTEGER NOT NULL,
  order_items_sha256    CHAR(64) NOT NULL,
  handoff_generation    INTEGER NOT NULL,
  handoff_token_sha256  CHAR(64) NOT NULL,
  notification_outbox_ids INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  inventory_evidence    JSONB NOT NULL DEFAULT '[]'::jsonb,
  funding_evidence      JSONB NOT NULL DEFAULT '{}'::jsonb,
  custody_evidence      JSONB NOT NULL DEFAULT '{}'::jsonb,
  reason                VARCHAR(500),
  contract_version      INTEGER NOT NULL DEFAULT 1,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_pharmacy_delivery_custody_event_order_753
    FOREIGN KEY (tenant_id, pharmacy_order_id)
    REFERENCES pharmacy_orders(tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pharmacy_delivery_custody_event_facility_753
    FOREIGN KEY (tenant_id, facility_id)
    REFERENCES facilities(tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pharmacy_delivery_custody_event_actor_753
    FOREIGN KEY (tenant_id, actor_uid)
    REFERENCES users(tenant_id, uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_pharmacy_delivery_custody_event_type_753
    CHECK (event_type IN (
      'PACKAGE_ISSUED','HANDOFF_REISSUED','HANDOFF_ROTATED','DELIVERED',
      'RETURN_REQUESTED','RETURNED','QUARANTINED'
    )),
  CONSTRAINT chk_pharmacy_delivery_custody_event_receipt_753
    CHECK (
      command_key_sha256 ~ '^[0-9a-f]{64}$'
      AND request_sha256 ~ '^[0-9a-f]{64}$'
      AND order_items_sha256 ~ '^[0-9a-f]{64}$'
      AND handoff_token_sha256 ~ '^[0-9a-f]{64}$'
      AND order_authority_version>0
      AND handoff_generation>0
      AND contract_version=1
      AND jsonb_typeof(inventory_evidence)='array'
      AND jsonb_array_length(inventory_evidence)>0
      AND funding_evidence->>'contract'='pharmacy_funding_authority_v1'
      AND jsonb_typeof(custody_evidence)='object'
      AND custody_evidence<>'{}'::jsonb
      AND (
        event_type NOT IN ('PACKAGE_ISSUED','HANDOFF_REISSUED','HANDOFF_ROTATED')
        OR cardinality(notification_outbox_ids)>0
      )
    ),
  CONSTRAINT ux_pharmacy_delivery_custody_event_command_753
    UNIQUE (tenant_id, command_key_sha256),
  CONSTRAINT ux_pharmacy_delivery_custody_event_tenant_id_753
    UNIQUE (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_pharmacy_delivery_custody_event_order_753
  ON pharmacy_delivery_custody_events(tenant_id, pharmacy_order_id, created_at, id);
CREATE OR REPLACE FUNCTION reject_pharmacy_delivery_custody_event_mutation_753()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pharmacy delivery custody events are append-only'
    USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER trg_pharmacy_delivery_custody_events_append_only_753
BEFORE UPDATE OR DELETE ON pharmacy_delivery_custody_events
FOR EACH ROW EXECUTE FUNCTION reject_pharmacy_delivery_custody_event_mutation_753();
ALTER TABLE pharmacy_delivery_custody_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_delivery_custody_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pharmacy_delivery_custody_events
  AS PERMISSIVE
  USING (tenant_id=public.app_current_tenant_id_uuid())
  WITH CHECK (tenant_id=public.app_current_tenant_id_uuid());
CREATE POLICY tenant_context_required ON pharmacy_delivery_custody_events
  AS RESTRICTIVE
  USING (public.app_current_tenant_id_uuid() IS NOT NULL)
  WITH CHECK (public.app_current_tenant_id_uuid() IS NOT NULL);

CREATE TABLE IF NOT EXISTS pharmacy_delivery_location_updates (
  id                    BIGSERIAL PRIMARY KEY,
  tenant_id             UUID NOT NULL,
  pharmacy_order_id     INTEGER NOT NULL,
  facility_id           INTEGER NOT NULL,
  delivery_assignee_uid UUID NOT NULL,
  handoff_generation    INTEGER NOT NULL,
  latitude              NUMERIC(9,6) NOT NULL,
  longitude             NUMERIC(9,6) NOT NULL,
  accuracy_m            NUMERIC(10,2),
  speed_kmh             NUMERIC(10,2),
  heading_degrees       NUMERIC(6,2),
  battery_level         NUMERIC(5,2),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_pharmacy_delivery_location_order_753
    FOREIGN KEY (tenant_id, pharmacy_order_id)
    REFERENCES pharmacy_orders(tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pharmacy_delivery_location_facility_753
    FOREIGN KEY (tenant_id, facility_id)
    REFERENCES facilities(tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pharmacy_delivery_location_assignee_753
    FOREIGN KEY (tenant_id, delivery_assignee_uid)
    REFERENCES users(tenant_id, uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_pharmacy_delivery_location_coordinates_753
    CHECK (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180),
  CONSTRAINT chk_pharmacy_delivery_location_metrics_753
    CHECK (
      handoff_generation>0
      AND (accuracy_m IS NULL OR accuracy_m>=0)
      AND (speed_kmh IS NULL OR speed_kmh>=0)
      AND (heading_degrees IS NULL OR heading_degrees BETWEEN 0 AND 360)
      AND (battery_level IS NULL OR battery_level BETWEEN 0 AND 100)
    ),
  CONSTRAINT ux_pharmacy_delivery_location_tenant_id_753
    UNIQUE (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_pharmacy_delivery_location_order_753
  ON pharmacy_delivery_location_updates(
    tenant_id, pharmacy_order_id, created_at DESC, id DESC
  );
CREATE OR REPLACE FUNCTION reject_pharmacy_delivery_location_mutation_753()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pharmacy delivery location evidence is append-only'
    USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER trg_pharmacy_delivery_location_append_only_753
BEFORE UPDATE OR DELETE ON pharmacy_delivery_location_updates
FOR EACH ROW EXECUTE FUNCTION reject_pharmacy_delivery_location_mutation_753();
ALTER TABLE pharmacy_delivery_location_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_delivery_location_updates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pharmacy_delivery_location_updates
  AS PERMISSIVE
  USING (tenant_id=public.app_current_tenant_id_uuid())
  WITH CHECK (tenant_id=public.app_current_tenant_id_uuid());
CREATE POLICY tenant_context_required ON pharmacy_delivery_location_updates
  AS RESTRICTIVE
  USING (public.app_current_tenant_id_uuid() IS NOT NULL)
  WITH CHECK (public.app_current_tenant_id_uuid() IS NOT NULL);

CREATE OR REPLACE FUNCTION public.bump_pharmacy_clinical_knowledge_revision_753()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE pharmacy_clinical_knowledge_revision
     SET version = version + 1,
         updated_at = NOW()
   WHERE singleton = TRUE;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.bump_pharmacy_clinical_knowledge_revision_753() FROM PUBLIC;

DO $med03_kb$
DECLARE
  source_table TEXT;
BEGIN
  FOREACH source_table IN ARRAY ARRAY[
    'drug_kb_sources', 'drug_kb_monographs', 'drug_kb_interactions',
    'drug_kb_allergy_groups', 'drug_kb_allergy_cross_reactivity',
    'drug_kb_condition_cautions', 'drug_kb_dose_ranges',
    'drug_kb_iv_compatibility', 'drug_kb_catalog_links',
    'terminology_catalog_bindings'
  ]
  LOOP
    IF to_regclass('public.' || source_table) IS NOT NULL THEN
      EXECUTE format(
        'DROP TRIGGER IF EXISTS trg_pharmacy_clinical_knowledge_revision_753 ON public.%I',
        source_table
      );
      EXECUTE format(
        'CREATE TRIGGER trg_pharmacy_clinical_knowledge_revision_753 '
        || 'AFTER INSERT OR UPDATE OR DELETE ON public.%I '
        || 'FOR EACH STATEMENT EXECUTE FUNCTION public.bump_pharmacy_clinical_knowledge_revision_753()',
        source_table
      );
    END IF;
  END LOOP;
END;
$med03_kb$;

ALTER TABLE pharmacy_patient_safety_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_patient_safety_versions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON pharmacy_patient_safety_versions;
CREATE POLICY tenant_isolation ON pharmacy_patient_safety_versions
  AS PERMISSIVE
  USING (tenant_id = public.app_current_tenant_id_uuid())
  WITH CHECK (tenant_id = public.app_current_tenant_id_uuid());

DROP POLICY IF EXISTS explicit_tenant_context ON pharmacy_patient_safety_versions;
CREATE POLICY explicit_tenant_context ON pharmacy_patient_safety_versions
  AS RESTRICTIVE
  USING (
    current_setting('app.current_tenant_id', TRUE) IS NOT NULL
    AND current_setting('app.current_tenant_id', TRUE) <> ''
    AND current_setting('app.current_tenant_id', TRUE) <> 'bypass'
    AND tenant_id = public.app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', TRUE) IS NOT NULL
    AND current_setting('app.current_tenant_id', TRUE) <> ''
    AND current_setting('app.current_tenant_id', TRUE) <> 'bypass'
    AND tenant_id = public.app_current_tenant_id_uuid()
  );

CREATE OR REPLACE FUNCTION public.pharmacy_erx_clinical_projection_753(lines JSONB)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'catalog_id', value->'catalog_id',
      'original_catalog_id', value->'original_catalog_id',
      'name', value->'name',
      'medicine_name', value->'medicine_name',
      'generic_name', value->'generic_name',
      'strength', value->'strength',
      'form', value->'form',
      'dose', value->'dose',
      'dosage', value->'dosage',
      'route', value->'route',
      'frequency', value->'frequency',
      'duration', value->'duration',
      'duration_days', value->'duration_days',
      'instructions', value->'instructions',
      'quantity', value->'quantity',
      'qty', value->'qty',
      'ordered_quantity', value->'ordered_quantity',
      'order_line_index', value->'order_line_index',
      'prescription_line_index', value->'prescription_line_index'
    )) ORDER BY ordinality),
    '[]'::jsonb
  )
  FROM jsonb_array_elements(COALESCE(lines, '[]'::jsonb)) WITH ORDINALITY AS item(value, ordinality)
$$;

CREATE OR REPLACE FUNCTION public.pharmacy_patient_safety_projection_753(
  source_table TEXT,
  payload JSONB
)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE source_table
    WHEN 'users' THEN jsonb_build_object(
      'birthday', payload->'birthday', 'gender', payload->'gender',
      'is_pregnant', payload->'is_pregnant',
      'pregnancy_lmp_date', payload->'pregnancy_lmp_date',
      'allergies', payload->'allergies', 'role', payload->'role',
      'status', payload->'status', 'is_active', payload->'is_active',
      'is_deleted', payload->'is_deleted', 'merged_into_uid', payload->'merged_into_uid',
      'chronic_medications', public.pharmacy_erx_clinical_projection_753(payload->'chronic_medications'),
      'chronic_medications_updated_at', payload->'chronic_medications_updated_at'
    )
    WHEN 'patient_allergies' THEN payload - ARRAY['updated_at', 'created_at']::TEXT[]
    WHEN 'allergies' THEN payload - ARRAY['updated_at', 'created_at']::TEXT[]
    WHEN 'admissions' THEN jsonb_build_object(
      'patient_uid', payload->'patient_uid', 'status', payload->'status',
      'allergies', payload->'allergies', 'created_at', payload->'created_at'
    )
    WHEN 'appointments' THEN jsonb_build_object(
      'patient_id', payload->'patient_id', 'notes', payload->'notes',
      'reason', payload->'reason', 'created_at', payload->'created_at'
    )
    WHEN 'clinical_notes' THEN jsonb_build_object(
      'patient_uid', payload->'patient_uid', 'notes', payload->'notes',
      'content', payload->'content', 'status', payload->'status',
      'created_at', payload->'created_at'
    )
    WHEN 'e_prescriptions' THEN jsonb_build_object(
      'patient_id', payload->'patient_id', 'patient_uid', payload->'patient_uid',
      'pharmacy_order_id', payload->'pharmacy_order_id',
      'status', payload->'status', 'follow_up_date', payload->'follow_up_date',
      'lifecycle_status', payload->'lifecycle_status', 'signed_at', payload->'signed_at',
      'medication_name', payload->'medication_name',
      'medications', public.pharmacy_erx_clinical_projection_753(payload->'medications')
    )
    WHEN 'pharmacy_orders' THEN jsonb_build_object(
      'patient_id', payload->'patient_id',
      'authority_origin', payload->'authority_origin',
      'status_class', CASE
        WHEN payload->>'status' IN (
          'PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'DISPATCHED',
          'PARTIALLY_DISPENSED', 'ON_HOLD'
        ) THEN 'active'
        WHEN payload->>'status' IN ('DISPENSED', 'DELIVERED') THEN 'dispensed'
        ELSE payload->>'status'
      END,
      'ordered_at', payload->'ordered_at', 'dispensed_at', payload->'dispensed_at',
      'items_list', public.pharmacy_erx_clinical_projection_753(payload->'items_list'),
      'dispensed_medications', public.pharmacy_erx_clinical_projection_753(payload->'dispensed_medications')
    )
    WHEN 'clinical_orders' THEN jsonb_build_object(
      'patient_uid', payload->'patient_uid', 'order_type', payload->'order_type',
      'status', payload->'status', 'start_date', payload->'start_date',
      'end_date', payload->'end_date', 'route', payload->'route',
      'details', payload->'details', 'updated_at', payload->'updated_at'
    )
    WHEN 'medication_administrations' THEN jsonb_build_object(
      'patient_uid', payload->'patient_uid',
      'medication_name', payload->'medication_name',
      'dose', payload->'dose', 'dosage', payload->'dosage',
      'route', payload->'route',
      'status_class', CASE
        WHEN payload->>'status' IN ('scheduled', 'due', 'administered') THEN 'active'
        ELSE payload->>'status'
      END,
      'clinical_order_id', payload->'clinical_order_id',
      'scheduled_time', payload->'scheduled_time', 'administered_at', payload->'administered_at',
      'updated_at', payload->'updated_at'
    )
    WHEN 'medication_reconciliations' THEN jsonb_build_object(
      'patient_id', payload->'patient_id', 'patient_uid', payload->'patient_uid',
      'status', payload->'status', 'rec_type', payload->'rec_type',
      'completed_at', payload->'completed_at', 'updated_at', payload->'updated_at'
    )
    WHEN 'medication_reconciliation_items' THEN jsonb_build_object(
      'reconciliation_id', payload->'reconciliation_id',
      'medication_name', payload->'medication_name', 'dose', payload->'dose',
      'frequency', payload->'frequency', 'route', payload->'route',
      'decision', payload->'decision', 'changed_dose', payload->'changed_dose',
      'changed_frequency', payload->'changed_frequency', 'changed_route', payload->'changed_route',
      'source_ref', payload->'source_ref', 'metadata', payload->'metadata',
      'updated_at', payload->'updated_at'
    )
    WHEN 'medication_reminders' THEN jsonb_build_object(
      'patient_uid', payload->'patient_uid', 'medication_name', payload->'medication_name',
      'dosage', payload->'dosage', 'frequency', payload->'frequency',
      'start_date', payload->'start_date', 'end_date', payload->'end_date',
      'is_active', payload->'is_active', 'updated_at', payload->'updated_at'
    )
    WHEN 'prescriptions' THEN jsonb_build_object(
      'patient_uid', payload->'patient_uid', 'medication_name', payload->'medication_name',
      'dosage', payload->'dosage', 'frequency', payload->'frequency',
      'status', payload->'status', 'duration_days', payload->'duration_days',
      'issued_at', payload->'issued_at'
    )
    WHEN 'pharmacy_counter_sales' THEN jsonb_build_object(
      'patient_uid', payload->'patient_uid', 'status', payload->'status',
      'voided_at', payload->'voided_at', 'updated_at', payload->'updated_at'
    )
    WHEN 'pharmacy_counter_sale_lines' THEN jsonb_build_object(
      'counter_sale_id', payload->'counter_sale_id',
      'inventory_item_id', payload->'inventory_item_id',
      'item_name', payload->'item_name', 'quantity', payload->'quantity'
    )
    WHEN 'chemo_treatment_plans' THEN jsonb_build_object(
      'patient_uid', payload->'patient_uid', 'status', payload->'status',
      'start_date', payload->'start_date', 'updated_at', payload->'updated_at'
    )
    WHEN 'chemo_cycles' THEN jsonb_build_object(
      'plan_id', payload->'plan_id', 'scheduled_date', payload->'scheduled_date',
      'status', payload->'status', 'updated_at', payload->'updated_at'
    )
    WHEN 'chemo_administrations' THEN jsonb_build_object(
      'cycle_id', payload->'cycle_id', 'drug_name', payload->'drug_name',
      'final_dose', payload->'final_dose', 'route', payload->'route',
      'status', payload->'status', 'administered_at', payload->'administered_at',
      'updated_at', payload->'updated_at'
    )
    WHEN 'dialysis_patients' THEN jsonb_build_object(
      'patient_uid', payload->'patient_uid', 'status', payload->'status',
      'updated_at', payload->'updated_at'
    )
    WHEN 'dialysis_prescriptions' THEN jsonb_build_object(
      'dialysis_patient_id', payload->'dialysis_patient_id',
      'anticoag', payload->'anticoag', 'anticoag_loading', payload->'anticoag_loading',
      'anticoag_maintenance', payload->'anticoag_maintenance',
      'status', payload->'status', 'valid_from', payload->'valid_from',
      'superseded_at', payload->'superseded_at', 'updated_at', payload->'updated_at'
    )
    WHEN 'maternity_supplements' THEN jsonb_build_object(
      'pregnancy_id', payload->'pregnancy_id', 'supplement', payload->'supplement',
      'dose', payload->'dose', 'frequency', payload->'frequency', 'route', payload->'route',
      'start_date', payload->'start_date', 'end_date', payload->'end_date',
      'updated_at', payload->'updated_at'
    )
    WHEN 'resuscitation_medication_links' THEN jsonb_build_object(
      'patient_uid', payload->'patient_uid',
      'mar_administration_id', payload->'mar_administration_id',
      'medication_name', payload->'medication_name', 'dose', payload->'dose',
      'route', payload->'route', 'reconciliation_status', payload->'reconciliation_status',
      'updated_at', payload->'updated_at'
    )
    WHEN 'vitals_chart' THEN jsonb_build_object(
      'patient_uid', payload->'patient_uid', 'weight_kg', payload->'weight_kg',
      'recorded_at', payload->'recorded_at'
    )
    WHEN 'maternity_pregnancies' THEN jsonb_build_object(
      'patient_uid', payload->'patient_uid', 'status', payload->'status'
    )
    WHEN 'lab_results' THEN jsonb_build_object(
      'patient_uid', payload->'patient_uid', 'test_name', payload->'test_name',
      'test_code', payload->'test_code', 'value_numeric', payload->'value_numeric',
      'value_text', payload->'value_text', 'unit', payload->'unit',
      'received_at', payload->'received_at'
    )
    WHEN 'patient_problems' THEN jsonb_build_object(
      'patient_uid', payload->'patient_uid', 'icd10_code', payload->'icd10_code',
      'title', payload->'title', 'status', payload->'status'
    )
    ELSE payload - ARRAY['updated_at']::TEXT[]
  END
$$;

CREATE OR REPLACE FUNCTION public.bump_pharmacy_patient_safety_version_753()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  payload JSONB;
  prior_payload JSONB;
  resolved_tenant UUID;
  resolved_patient INTEGER;
  candidate_tenant TEXT;
  candidate_patient TEXT;
  candidate_uid TEXT;
  identity_payload JSONB;
  identity_key TEXT;
  seen_identities TEXT[] := ARRAY[]::TEXT[];
  prior_tenant_context TEXT := current_setting('app.current_tenant_id', TRUE);
BEGIN
  payload := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  prior_payload := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END;

  IF TG_OP = 'UPDATE'
     AND prior_payload->>'tenant_id' IS NOT DISTINCT FROM payload->>'tenant_id'
     AND (
       CASE WHEN TG_TABLE_NAME = 'users' THEN prior_payload->>'id'
            ELSE prior_payload->>'patient_id' END
     ) IS NOT DISTINCT FROM (
       CASE WHEN TG_TABLE_NAME = 'users' THEN payload->>'id'
            ELSE payload->>'patient_id' END
     )
     AND (
       CASE WHEN TG_TABLE_NAME = 'users' THEN prior_payload->>'uid'
            ELSE prior_payload->>'patient_uid' END
     ) IS NOT DISTINCT FROM (
       CASE WHEN TG_TABLE_NAME = 'users' THEN payload->>'uid'
            ELSE payload->>'patient_uid' END
     )
     AND public.pharmacy_patient_safety_projection_753(TG_TABLE_NAME, prior_payload)
         IS NOT DISTINCT FROM public.pharmacy_patient_safety_projection_753(TG_TABLE_NAME, payload) THEN
    RETURN NEW;
  END IF;

  FOR identity_payload IN
    SELECT value
      FROM jsonb_array_elements(
        CASE WHEN TG_OP = 'UPDATE'
          THEN jsonb_build_array(prior_payload, payload)
          ELSE jsonb_build_array(payload)
        END
      )
  LOOP
    candidate_tenant := NULLIF(identity_payload->>'tenant_id', '');
    candidate_patient := CASE
      WHEN TG_TABLE_NAME = 'users' THEN NULLIF(identity_payload->>'id', '')
      ELSE NULLIF(identity_payload->>'patient_id', '')
    END;
    candidate_uid := CASE
      WHEN TG_TABLE_NAME = 'users' THEN NULLIF(identity_payload->>'uid', '')
      ELSE NULLIF(identity_payload->>'patient_uid', '')
    END;

    -- Child therapy tables do not carry patient identity. Resolve it only
    -- through their same-tenant canonical parent before incrementing the
    -- patient safety fence; a missing/ambiguous parent produces no authority.
    IF candidate_uid IS NULL AND candidate_tenant IS NOT NULL THEN
      CASE TG_TABLE_NAME
        WHEN 'medication_reconciliation_items' THEN
          SELECT reconciliation.patient_uid::text, reconciliation.patient_id::text
            INTO candidate_uid, candidate_patient
            FROM medication_reconciliations reconciliation
           WHERE reconciliation.tenant_id=candidate_tenant::uuid
             AND reconciliation.id=(identity_payload->>'reconciliation_id')::uuid
           LIMIT 1;
        WHEN 'pharmacy_counter_sale_lines' THEN
          SELECT sale.patient_uid::text
            INTO candidate_uid
            FROM pharmacy_counter_sales sale
           WHERE sale.tenant_id=candidate_tenant::uuid
             AND sale.id=(identity_payload->>'counter_sale_id')::bigint
           LIMIT 1;
        WHEN 'chemo_cycles' THEN
          SELECT plan.patient_uid::text
            INTO candidate_uid
            FROM chemo_treatment_plans plan
           WHERE plan.tenant_id=candidate_tenant::uuid
             AND plan.id=(identity_payload->>'plan_id')::integer
           LIMIT 1;
        WHEN 'chemo_administrations' THEN
          SELECT plan.patient_uid::text
            INTO candidate_uid
            FROM chemo_cycles cycle
            JOIN chemo_treatment_plans plan
              ON plan.tenant_id=cycle.tenant_id AND plan.id=cycle.plan_id
           WHERE cycle.tenant_id=candidate_tenant::uuid
             AND cycle.id=(identity_payload->>'cycle_id')::integer
           LIMIT 1;
        WHEN 'dialysis_prescriptions' THEN
          SELECT patient.patient_uid::text
            INTO candidate_uid
            FROM dialysis_patients patient
           WHERE patient.tenant_id=candidate_tenant::uuid
             AND patient.id=(identity_payload->>'dialysis_patient_id')::integer
           LIMIT 1;
        WHEN 'maternity_supplements' THEN
          SELECT pregnancy.patient_uid::text
            INTO candidate_uid
            FROM maternity_pregnancies pregnancy
           WHERE pregnancy.tenant_id=candidate_tenant::uuid
             AND pregnancy.id=(identity_payload->>'pregnancy_id')::integer
           LIMIT 1;
        ELSE NULL;
      END CASE;
    END IF;

    resolved_tenant := NULL;
    resolved_patient := NULL;
    SELECT u.tenant_id, u.id
      INTO resolved_tenant, resolved_patient
      FROM users u
     WHERE (candidate_tenant IS NULL OR u.tenant_id = candidate_tenant::uuid)
       AND (
         (candidate_patient ~ '^[0-9]+$' AND u.id = candidate_patient::integer)
         OR
         (candidate_uid ~* '^[0-9a-f-]{36}$' AND u.uid = candidate_uid::uuid)
       )
     ORDER BY CASE
       WHEN candidate_patient ~ '^[0-9]+$' AND u.id=candidate_patient::integer THEN 0
       ELSE 1
     END, u.id
     LIMIT 1;

    identity_key := COALESCE(resolved_tenant::text, '') || ':' || COALESCE(resolved_patient::text, '');
    IF resolved_tenant IS NOT NULL AND resolved_patient IS NOT NULL
       AND NOT (identity_key = ANY(seen_identities)) THEN
      seen_identities := array_append(seen_identities, identity_key);
      PERFORM set_config('app.current_tenant_id', resolved_tenant::text, TRUE);
      INSERT INTO pharmacy_patient_safety_versions (tenant_id, patient_id, version, updated_at)
      VALUES (resolved_tenant, resolved_patient, 2, NOW())
      ON CONFLICT (tenant_id, patient_id) DO UPDATE
        SET version = pharmacy_patient_safety_versions.version + 1,
            updated_at = NOW();
    END IF;
  END LOOP;

  PERFORM set_config('app.current_tenant_id', COALESCE(prior_tenant_context, ''), TRUE);

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

REVOKE ALL ON FUNCTION public.bump_pharmacy_patient_safety_version_753() FROM PUBLIC;

DO $med03$
DECLARE
  source_table TEXT;
BEGIN
  FOREACH source_table IN ARRAY ARRAY[
    'users', 'patient_allergies', 'allergies', 'admissions', 'appointments',
    'clinical_notes', 'e_prescriptions', 'pharmacy_orders', 'clinical_orders',
    'medication_administrations', 'medication_reconciliations',
    'medication_reconciliation_items', 'medication_reminders', 'prescriptions',
    'pharmacy_counter_sales', 'pharmacy_counter_sale_lines',
    'chemo_treatment_plans', 'chemo_cycles', 'chemo_administrations',
    'dialysis_patients', 'dialysis_prescriptions',
    'maternity_pregnancies', 'maternity_supplements',
    'resuscitation_medication_links', 'vitals_chart',
    'lab_results', 'patient_problems'
  ]
  LOOP
    IF to_regclass('public.' || source_table) IS NOT NULL THEN
      EXECUTE format(
        'DROP TRIGGER IF EXISTS trg_pharmacy_patient_safety_version_753 ON public.%I',
        source_table
      );
      EXECUTE format(
        'CREATE TRIGGER trg_pharmacy_patient_safety_version_753 '
        || 'BEFORE INSERT OR UPDATE OR DELETE ON public.%I '
        || 'FOR EACH ROW EXECUTE FUNCTION public.bump_pharmacy_patient_safety_version_753()',
        source_table
      );
    END IF;
  END LOOP;
END;
$med03$;

ALTER TABLE pharmacy_inventory_batches
  DROP CONSTRAINT IF EXISTS fk_pharmacy_batches_item_facility_753,
  DROP CONSTRAINT IF EXISTS chk_pharmacy_batches_usable_authority_753,
  ADD CONSTRAINT fk_pharmacy_batches_item_facility_753
    FOREIGN KEY (tenant_id, facility_id, inventory_item_id)
    REFERENCES pharmacy_inventory_items (tenant_id, facility_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    NOT VALID,
  ADD CONSTRAINT chk_pharmacy_batches_usable_authority_753
    CHECK (status NOT IN ('in_stock', 'reserved') OR facility_id IS NOT NULL) NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_suppliers_tenant_id_753
  ON pharmacy_suppliers (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_purchase_orders_tenant_id_753
  ON pharmacy_purchase_orders (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_purchase_order_items_tenant_id_753
  ON pharmacy_purchase_order_items (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_goods_receipts_tenant_id_753
  ON pharmacy_goods_receipts (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_goods_receipt_items_tenant_id_753
  ON pharmacy_goods_receipt_items (tenant_id, id);

ALTER TABLE pharmacy_inventory_items
  DROP CONSTRAINT IF EXISTS fk_pharmacy_inventory_items_supplier_tenant_753,
  ADD CONSTRAINT fk_pharmacy_inventory_items_supplier_tenant_753
    FOREIGN KEY (tenant_id, default_supplier_id)
    REFERENCES pharmacy_suppliers (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID;
ALTER TABLE pharmacy_inventory_batches
  DROP CONSTRAINT IF EXISTS fk_pharmacy_batches_supplier_tenant_753,
  DROP CONSTRAINT IF EXISTS fk_pharmacy_batches_goods_receipt_tenant_753,
  ADD CONSTRAINT fk_pharmacy_batches_supplier_tenant_753
    FOREIGN KEY (tenant_id, supplier_id)
    REFERENCES pharmacy_suppliers (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT fk_pharmacy_batches_goods_receipt_tenant_753
    FOREIGN KEY (tenant_id, goods_receipt_id)
    REFERENCES pharmacy_goods_receipts (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID;

ALTER TABLE pharmacy_purchase_orders
  DROP CONSTRAINT IF EXISTS fk_pharmacy_purchase_orders_supplier_tenant_753,
  DROP CONSTRAINT IF EXISTS fk_pharmacy_purchase_orders_facility_tenant_753,
  ADD CONSTRAINT fk_pharmacy_purchase_orders_supplier_tenant_753
    FOREIGN KEY (tenant_id, supplier_id)
    REFERENCES pharmacy_suppliers (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT fk_pharmacy_purchase_orders_facility_tenant_753
    FOREIGN KEY (tenant_id, facility_id)
    REFERENCES facilities (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID;

ALTER TABLE pharmacy_purchase_order_items
  DROP CONSTRAINT IF EXISTS fk_pharmacy_purchase_order_items_order_tenant_753,
  DROP CONSTRAINT IF EXISTS fk_pharmacy_purchase_order_items_item_tenant_753,
  DROP CONSTRAINT IF EXISTS chk_pharmacy_purchase_order_item_quantities_753,
  ADD CONSTRAINT fk_pharmacy_purchase_order_items_order_tenant_753
    FOREIGN KEY (tenant_id, purchase_order_id)
    REFERENCES pharmacy_purchase_orders (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT fk_pharmacy_purchase_order_items_item_tenant_753
    FOREIGN KEY (tenant_id, inventory_item_id)
    REFERENCES pharmacy_inventory_items (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT chk_pharmacy_purchase_order_item_quantities_753
    CHECK (
      ordered_quantity > 0
      AND received_quantity >= 0
      AND received_quantity <= ordered_quantity
    ) NOT VALID;

ALTER TABLE pharmacy_goods_receipts
  DROP CONSTRAINT IF EXISTS fk_pharmacy_goods_receipts_order_tenant_753,
  DROP CONSTRAINT IF EXISTS fk_pharmacy_goods_receipts_supplier_tenant_753,
  DROP CONSTRAINT IF EXISTS fk_pharmacy_goods_receipts_facility_tenant_753,
  ADD CONSTRAINT fk_pharmacy_goods_receipts_order_tenant_753
    FOREIGN KEY (tenant_id, purchase_order_id)
    REFERENCES pharmacy_purchase_orders (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT fk_pharmacy_goods_receipts_supplier_tenant_753
    FOREIGN KEY (tenant_id, supplier_id)
    REFERENCES pharmacy_suppliers (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT fk_pharmacy_goods_receipts_facility_tenant_753
    FOREIGN KEY (tenant_id, facility_id)
    REFERENCES facilities (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID;

ALTER TABLE pharmacy_goods_receipt_items
  DROP CONSTRAINT IF EXISTS fk_pharmacy_goods_receipt_items_receipt_tenant_753,
  DROP CONSTRAINT IF EXISTS fk_pharmacy_goods_receipt_items_item_tenant_753,
  DROP CONSTRAINT IF EXISTS fk_pharmacy_goods_receipt_items_batch_tenant_753,
  DROP CONSTRAINT IF EXISTS fk_pharmacy_goods_receipt_items_order_item_tenant_753,
  ADD CONSTRAINT fk_pharmacy_goods_receipt_items_receipt_tenant_753
    FOREIGN KEY (tenant_id, goods_receipt_id)
    REFERENCES pharmacy_goods_receipts (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT fk_pharmacy_goods_receipt_items_item_tenant_753
    FOREIGN KEY (tenant_id, inventory_item_id)
    REFERENCES pharmacy_inventory_items (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT fk_pharmacy_goods_receipt_items_batch_tenant_753
    FOREIGN KEY (tenant_id, inventory_batch_id)
    REFERENCES pharmacy_inventory_batches (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT fk_pharmacy_goods_receipt_items_order_item_tenant_753
    FOREIGN KEY (tenant_id, purchase_order_item_id)
    REFERENCES pharmacy_purchase_order_items (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID;

ALTER TABLE e_prescriptions
  DROP CONSTRAINT IF EXISTS fk_e_prescriptions_pharmacy_order_patient_753,
  DROP CONSTRAINT IF EXISTS fk_e_prescriptions_patient_identity_753,
  DROP CONSTRAINT IF EXISTS chk_e_prescriptions_link_identity_753,
  ADD CONSTRAINT fk_e_prescriptions_pharmacy_order_patient_753
    FOREIGN KEY (tenant_id, pharmacy_order_id, patient_id)
    REFERENCES pharmacy_orders (tenant_id, id, patient_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  ADD CONSTRAINT fk_e_prescriptions_patient_identity_753
    FOREIGN KEY (tenant_id, patient_id, patient_uid)
    REFERENCES users (tenant_id, id, uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  ADD CONSTRAINT chk_e_prescriptions_link_identity_753
    CHECK (
      pharmacy_order_id IS NULL
      OR (patient_id IS NOT NULL AND patient_uid IS NOT NULL)
    ) NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS ux_e_prescriptions_pharmacy_order_753
  ON e_prescriptions (tenant_id, pharmacy_order_id)
  WHERE pharmacy_order_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_stock_movements_direct_receive_command_753
  ON pharmacy_stock_movements (tenant_id, (metadata->>'command_key_sha256'))
  WHERE metadata->>'contract'='pharmacy_inventory_direct_receive_v1';
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_stock_movements_grn_receive_command_753
  ON pharmacy_stock_movements (tenant_id, (metadata->>'command_key_sha256'))
  WHERE metadata->>'contract'='pharmacy_grn_receive_line_v1';
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_stock_movements_public_command_753
  ON pharmacy_stock_movements (tenant_id, (metadata->>'command_key_sha256'))
  WHERE metadata->>'contract'='pharmacy_inventory_movement_v1';
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_stock_movements_controlled_command_753
  ON pharmacy_stock_movements (tenant_id, (metadata->>'command_key_sha256'))
  WHERE metadata->>'contract'='pharmacy_inventory_controlled_dispense_v1';
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_stock_movements_supply_command_753
  ON pharmacy_stock_movements (tenant_id, (metadata->>'command_key_sha256'))
  WHERE metadata->>'contract'='pharmacy_supply_stock_movement_v1';

CREATE OR REPLACE FUNCTION public.prevent_new_duplicate_pharmacy_billing_line_753()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.source_ref_type='pharmacy_order'
     AND NEW.source_ref_id IS NOT NULL
     AND NEW.source_ref_active THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'vh:pharmacy_billing_line:' || NEW.tenant_id::text || ':' || NEW.source_ref_id::text,
      753
    ));
    IF EXISTS (
      SELECT 1 FROM billing_invoice_items existing
       WHERE existing.tenant_id=NEW.tenant_id
         AND existing.source_ref_type='pharmacy_order'
         AND existing.source_ref_id=NEW.source_ref_id
         AND existing.source_ref_active
         AND existing.id IS DISTINCT FROM NEW.id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE='23505',
        CONSTRAINT='trg_prevent_new_duplicate_pharmacy_billing_line_753',
        MESSAGE='A governed active pharmacy billing line already owns this order';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_new_duplicate_pharmacy_billing_line_753
  ON billing_invoice_items;
CREATE TRIGGER trg_prevent_new_duplicate_pharmacy_billing_line_753
BEFORE INSERT OR UPDATE OF tenant_id,source_ref_type,source_ref_id,source_ref_active
ON billing_invoice_items
FOR EACH ROW EXECUTE FUNCTION public.prevent_new_duplicate_pharmacy_billing_line_753();

ALTER TABLE billing_invoice_items
  ADD COLUMN IF NOT EXISTS source_authority_version INTEGER,
  ADD COLUMN IF NOT EXISTS source_authority_sha256 CHAR(64);

ALTER TABLE tpa_claim_line_decisions
  ADD COLUMN IF NOT EXISTS source_authority_version INTEGER,
  ADD COLUMN IF NOT EXISTS source_authority_sha256 CHAR(64),
  ADD COLUMN IF NOT EXISTS invalidated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS invalidated_by UUID;

ALTER TABLE billing_invoice_items
  DROP CONSTRAINT IF EXISTS chk_billing_invoice_items_source_authority_753,
  ADD CONSTRAINT chk_billing_invoice_items_source_authority_753 CHECK (
    (source_authority_version IS NULL AND source_authority_sha256 IS NULL)
    OR
    (source_authority_version > 0
      AND source_authority_sha256 ~ '^[0-9a-f]{64}$')
  ) NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS ux_tpa_claims_tenant_id_753
  ON tpa_claims (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_tpa_claims_funding_admission_753
  ON tpa_claims (tenant_id, id, admission_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_orders_funding_admission_753
  ON pharmacy_orders (tenant_id, id, funding_admission_id);

ALTER TABLE tpa_claim_line_decisions
  DROP CONSTRAINT IF EXISTS chk_tpa_claim_line_decisions_source_authority_753,
  DROP CONSTRAINT IF EXISTS chk_tpa_claim_line_decisions_invalidation_753,
  ADD CONSTRAINT chk_tpa_claim_line_decisions_source_authority_753 CHECK (
    (source_authority_version IS NULL AND source_authority_sha256 IS NULL)
    OR
    (source_authority_version > 0
      AND source_authority_sha256 ~ '^[0-9a-f]{64}$')
  ) NOT VALID,
  ADD CONSTRAINT chk_tpa_claim_line_decisions_invalidation_753 CHECK (
    (invalidated_at IS NULL AND invalidated_by IS NULL)
    OR
    (invalidated_at IS NOT NULL AND invalidated_by IS NOT NULL)
  ) NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS ux_tasks_pharmacy_funding_target_753
  ON tasks (tenant_id,id,related_resource_type,related_resource_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_billing_items_invoice_scope_753
  ON billing_invoice_items (tenant_id,id,invoice_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_billing_payments_invoice_scope_753
  ON billing_payments (tenant_id,id,invoice_id);

CREATE TABLE IF NOT EXISTS pharmacy_funding_decision_events (
  id                    BIGSERIAL PRIMARY KEY,
  tenant_id             UUID NOT NULL,
  facility_id           INTEGER NOT NULL,
  pharmacy_order_id     INTEGER NOT NULL,
  admission_id          INTEGER,
  event_type            VARCHAR(40) NOT NULL,
  source_authority_version INTEGER NOT NULL,
  source_authority_sha256 CHAR(64) NOT NULL,
  invoice_id            INTEGER NOT NULL,
  invoice_item_id       INTEGER NOT NULL,
  tpa_claim_id          INTEGER,
  billing_payment_id    INTEGER,
  task_id               INTEGER,
  amount                NUMERIC(12,2) NOT NULL DEFAULT 0,
  command_key_sha256    CHAR(64) NOT NULL,
  evidence              JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_by           UUID NOT NULL,
  recorded_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  authority_generation  BIGINT,
  supersedes_event_id   BIGINT,
  CONSTRAINT chk_pharmacy_funding_event_type_753 CHECK (
    event_type IN (
      'LINE_MATERIALIZED', 'AUTHORITY_INVALIDATED', 'TPA_DECISION_RECORDED',
      'PAYMENT_VERIFIED', 'FUNDING_RESOLVED'
    )
  ),
  CONSTRAINT chk_pharmacy_funding_event_authority_753 CHECK (
    source_authority_version > 0
    AND source_authority_sha256 ~ '^[0-9a-f]{64}$'
    AND command_key_sha256 ~ '^[0-9a-f]{64}$'
    AND amount >= 0
  ),
  CONSTRAINT chk_pharmacy_funding_event_generation_753 CHECK (
    (
      event_type IN ('FUNDING_RESOLVED','AUTHORITY_INVALIDATED')
      AND authority_generation IS NOT NULL
      AND authority_generation > 0
      AND (
        (event_type='FUNDING_RESOLVED'
          AND authority_generation=1 AND supersedes_event_id IS NULL)
        OR (authority_generation>1 AND supersedes_event_id IS NOT NULL)
      )
    )
    OR
    (
      event_type NOT IN ('FUNDING_RESOLVED','AUTHORITY_INVALIDATED')
      AND authority_generation IS NULL AND supersedes_event_id IS NULL
    )
  ),
  CONSTRAINT fk_pharmacy_funding_event_order_753
    FOREIGN KEY (tenant_id, pharmacy_order_id, facility_id)
    REFERENCES pharmacy_orders (tenant_id, id, facility_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pharmacy_funding_event_admission_753
    FOREIGN KEY (tenant_id, admission_id)
    REFERENCES admissions (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pharmacy_funding_event_invoice_item_753
    FOREIGN KEY (tenant_id, invoice_item_id, invoice_id)
    REFERENCES billing_invoice_items (tenant_id, id, invoice_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pharmacy_funding_event_payment_753
    FOREIGN KEY (tenant_id, billing_payment_id, invoice_id)
    REFERENCES billing_payments (tenant_id, id, invoice_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pharmacy_funding_event_task_753
    FOREIGN KEY (tenant_id, task_id)
    REFERENCES tasks (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pharmacy_funding_event_claim_753
    FOREIGN KEY (tenant_id, tpa_claim_id)
    REFERENCES tpa_claims (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pharmacy_funding_event_actor_753
    FOREIGN KEY (tenant_id, recorded_by)
    REFERENCES users (tenant_id, uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS pharmacy_funding_commands (
  id                    BIGSERIAL PRIMARY KEY,
  tenant_id             UUID NOT NULL,
  command_key_sha256    CHAR(64) NOT NULL,
  command_type          VARCHAR(40) NOT NULL,
  task_id               INTEGER NOT NULL,
  task_resource_type    VARCHAR(60) NOT NULL,
  task_resource_id      VARCHAR(120) NOT NULL,
  pharmacy_order_id     INTEGER NOT NULL,
  facility_id           INTEGER,
  invoice_id            INTEGER,
  invoice_item_id       INTEGER NOT NULL,
  tpa_claim_id          INTEGER,
  approval_receipt_id   BIGINT,
  consumption_receipt_id BIGINT,
  governance_approval_id INTEGER,
  proposal_sha256       CHAR(64),
  proposer_uid          UUID,
  approved_patient_amount NUMERIC(12,2),
  request_sha256        CHAR(64) NOT NULL,
  status                VARCHAR(20) NOT NULL DEFAULT 'IN_PROGRESS',
  response_body         JSONB,
  created_by            UUID NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at          TIMESTAMPTZ,
  CONSTRAINT chk_pharmacy_funding_command_hashes_753 CHECK (
    command_key_sha256 ~ '^[0-9a-f]{64}$'
    AND request_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT chk_pharmacy_funding_command_status_753 CHECK (
    (status='IN_PROGRESS' AND completed_at IS NULL AND response_body IS NULL)
    OR
    (status='COMPLETE' AND completed_at IS NOT NULL AND response_body IS NOT NULL)
  ),
  CONSTRAINT chk_pharmacy_funding_command_task_target_753 CHECK (
    (
      (command_type='TPA_LINE_DECISION'
        AND task_resource_type='pharmacy_tpa_line_decision')
      OR
      (command_type='POSTED_PAYMENT_RETRY'
        AND task_resource_type='pharmacy_posted_payment')
      OR
      (command_type IN (
          'SUBSTITUTION_FUNDING_APPROVAL','SUBSTITUTION_FUNDING_CONSUMPTION'
        )
        AND task_resource_type IN (
          'pharmacy_tpa_line_decision','pharmacy_posted_payment',
          'pharmacy_patient_advance'
        ))
      OR
      (command_type='PHARMACY_ADVANCE_SETTLEMENT'
        AND task_resource_type='pharmacy_advance_settlement')
      OR
      (command_type='PHARMACY_ADVANCE_RELEASE'
        AND task_resource_type='pharmacy_advance_release')
    )
    AND (
      (command_type='PHARMACY_ADVANCE_SETTLEMENT'
        AND task_resource_id=consumption_receipt_id::text)
      OR
      (command_type='PHARMACY_ADVANCE_RELEASE'
        AND task_resource_id=approval_receipt_id::text)
      OR
      (command_type NOT IN ('PHARMACY_ADVANCE_SETTLEMENT','PHARMACY_ADVANCE_RELEASE')
        AND task_resource_id=pharmacy_order_id::text)
    )
  ),
  CONSTRAINT fk_pharmacy_funding_command_order_753
    FOREIGN KEY (tenant_id, pharmacy_order_id)
    REFERENCES pharmacy_orders (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pharmacy_funding_command_item_753
    FOREIGN KEY (tenant_id, invoice_item_id)
    REFERENCES billing_invoice_items (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pharmacy_funding_command_claim_753
    FOREIGN KEY (tenant_id, tpa_claim_id)
    REFERENCES tpa_claims (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pharmacy_funding_command_actor_753
    FOREIGN KEY (tenant_id, created_by)
    REFERENCES users (tenant_id, uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pharmacy_funding_command_task_753
    FOREIGN KEY (tenant_id, task_id, task_resource_type, task_resource_id)
    REFERENCES tasks (tenant_id, id, related_resource_type, related_resource_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_funding_commands_key_753
  ON pharmacy_funding_commands (tenant_id, command_key_sha256);

CREATE OR REPLACE FUNCTION public.enforce_pharmacy_funding_command_receipt_753()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'pharmacy funding command receipts cannot be deleted'
      USING ERRCODE='55000';
  END IF;
  IF OLD.status='IN_PROGRESS'
     AND NEW.status='COMPLETE'
     AND NEW.response_body IS NOT NULL
     AND NEW.completed_at IS NOT NULL
     AND NEW.id=OLD.id
     AND NEW.tenant_id=OLD.tenant_id
     AND NEW.command_key_sha256=OLD.command_key_sha256
     AND NEW.command_type=OLD.command_type
     AND NEW.task_id=OLD.task_id
     AND NEW.task_resource_type=OLD.task_resource_type
     AND NEW.task_resource_id=OLD.task_resource_id
     AND NEW.pharmacy_order_id=OLD.pharmacy_order_id
     AND NEW.invoice_item_id=OLD.invoice_item_id
     AND NEW.tpa_claim_id IS NOT DISTINCT FROM OLD.tpa_claim_id
     AND NEW.request_sha256=OLD.request_sha256
     AND NEW.created_by=OLD.created_by
     AND NEW.created_at=OLD.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'pharmacy funding command identity and completed response are immutable'
    USING ERRCODE='55000';
END;
$$;

DROP TRIGGER IF EXISTS trg_pharmacy_funding_commands_immutable_753
  ON pharmacy_funding_commands;
CREATE TRIGGER trg_pharmacy_funding_commands_immutable_753
BEFORE UPDATE OR DELETE ON pharmacy_funding_commands
FOR EACH ROW EXECUTE FUNCTION public.enforce_pharmacy_funding_command_receipt_753();

CREATE TABLE IF NOT EXISTS pharmacy_payment_allocations (
  id                    BIGSERIAL PRIMARY KEY,
  tenant_id             UUID NOT NULL,
  pharmacy_order_id     INTEGER NOT NULL,
  invoice_id            INTEGER NOT NULL,
  invoice_item_id       INTEGER NOT NULL,
  billing_payment_id    INTEGER NOT NULL,
  source_authority_version INTEGER NOT NULL,
  source_authority_sha256 CHAR(64) NOT NULL,
  allocated_amount      NUMERIC(12,2) NOT NULL,
  allocation_command_sha256 CHAR(64) NOT NULL,
  allocated_by          UUID NOT NULL,
  allocated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  evidence              JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT chk_pharmacy_payment_allocation_authority_753 CHECK (
    source_authority_version > 0
    AND source_authority_sha256 ~ '^[0-9a-f]{64}$'
    AND allocation_command_sha256 ~ '^[0-9a-f]{64}$'
    AND allocated_amount > 0
  ),
  CONSTRAINT fk_pharmacy_payment_allocation_order_753
    FOREIGN KEY (tenant_id, pharmacy_order_id)
    REFERENCES pharmacy_orders (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pharmacy_payment_allocation_invoice_753
    FOREIGN KEY (tenant_id, invoice_id)
    REFERENCES billing_invoices (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pharmacy_payment_allocation_item_753
    FOREIGN KEY (tenant_id, invoice_item_id, invoice_id)
    REFERENCES billing_invoice_items (tenant_id, id, invoice_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pharmacy_payment_allocation_payment_753
    FOREIGN KEY (tenant_id, billing_payment_id, invoice_id)
    REFERENCES billing_payments (tenant_id, id, invoice_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pharmacy_payment_allocation_actor_753
    FOREIGN KEY (tenant_id, allocated_by)
    REFERENCES users (tenant_id, uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_payment_allocations_exact_753
  ON pharmacy_payment_allocations (
    tenant_id,billing_payment_id,invoice_item_id,
    source_authority_version,source_authority_sha256
  );
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_payment_allocations_identity_753
  ON pharmacy_payment_allocations (
    tenant_id,id,pharmacy_order_id,invoice_id,invoice_item_id,billing_payment_id,
    source_authority_version,source_authority_sha256
  );
CREATE INDEX IF NOT EXISTS idx_pharmacy_payment_allocations_payment_753
  ON pharmacy_payment_allocations (tenant_id,billing_payment_id,allocated_at,id);
CREATE INDEX IF NOT EXISTS idx_pharmacy_payment_allocations_order_753
  ON pharmacy_payment_allocations (
    tenant_id,pharmacy_order_id,source_authority_version,source_authority_sha256,id
  );

CREATE TABLE IF NOT EXISTS pharmacy_payment_allocation_reversals (
  id                    BIGSERIAL PRIMARY KEY,
  tenant_id             UUID NOT NULL,
  allocation_id         BIGINT NOT NULL,
  pharmacy_order_id     INTEGER NOT NULL,
  invoice_id            INTEGER NOT NULL,
  invoice_item_id       INTEGER NOT NULL,
  billing_payment_id    INTEGER NOT NULL,
  source_authority_version INTEGER NOT NULL,
  source_authority_sha256 CHAR(64) NOT NULL,
  reversed_amount       NUMERIC(12,2) NOT NULL,
  reversal_command_sha256 CHAR(64) NOT NULL,
  reason                VARCHAR(255) NOT NULL,
  reversed_by           UUID NOT NULL,
  evidence              JSONB NOT NULL DEFAULT '{}'::jsonb,
  reversed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_pharmacy_payment_allocation_reversal_amount_753
    CHECK (reversed_amount > 0),
  CONSTRAINT chk_pharmacy_payment_allocation_reversal_hashes_753 CHECK (
    source_authority_sha256 ~ '^[0-9a-f]{64}$'
    AND reversal_command_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT fk_pharmacy_payment_allocation_reversal_exact_753
    FOREIGN KEY (
      tenant_id,allocation_id,pharmacy_order_id,invoice_id,invoice_item_id,
      billing_payment_id,source_authority_version,source_authority_sha256
    ) REFERENCES pharmacy_payment_allocations (
      tenant_id,id,pharmacy_order_id,invoice_id,invoice_item_id,
      billing_payment_id,source_authority_version,source_authority_sha256
    ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pharmacy_payment_allocation_reversal_actor_753
    FOREIGN KEY (tenant_id,reversed_by)
    REFERENCES users (tenant_id,uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_payment_allocation_reversals_command_753
  ON pharmacy_payment_allocation_reversals (tenant_id,reversal_command_sha256);

ALTER TABLE billing_advances
  ADD COLUMN ipd_advance_deposit_id INTEGER,
  ADD COLUMN ipd_advance_deposit_payment_method VARCHAR(40),
  ADD COLUMN ipd_advance_deposit_collected_at TIMESTAMPTZ;

ALTER TABLE billing_advance_settlements
  ADD COLUMN pharmacy_advance_allocation_id BIGINT,
  ADD COLUMN pharmacy_advance_allocation_evidence_sha256 CHAR(64),
  ADD COLUMN pharmacy_advance_conversion_command_sha256 CHAR(64),
  ADD COLUMN pharmacy_advance_conversion_evidence_sha256 CHAR(64);

CREATE TABLE IF NOT EXISTS pharmacy_advance_allocations (
  id                             BIGSERIAL PRIMARY KEY,
  tenant_id                      UUID NOT NULL,
  pharmacy_order_id              INTEGER NOT NULL,
  invoice_id                     INTEGER NOT NULL,
  invoice_item_id                INTEGER NOT NULL,
  billing_advance_id             INTEGER NOT NULL,
  source_authority_version       INTEGER NOT NULL,
  source_authority_sha256        CHAR(64) NOT NULL,
  allocated_amount               NUMERIC(12,2) NOT NULL,
  allocation_command_sha256      CHAR(64) NOT NULL,
  funding_task_id                INTEGER NOT NULL,
  funding_approval_receipt_id    BIGINT NOT NULL,
  allocated_by                   UUID NOT NULL,
  allocated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  evidence                       JSONB NOT NULL,
  evidence_sha256                CHAR(64) GENERATED ALWAYS AS (
    encode(public.digest(evidence::text,'sha256'),'hex')
  ) STORED NOT NULL
);

CREATE TABLE IF NOT EXISTS pharmacy_advance_allocation_reversals (
  id                             BIGSERIAL PRIMARY KEY,
  tenant_id                      UUID NOT NULL,
  allocation_id                  BIGINT NOT NULL,
  pharmacy_order_id              INTEGER NOT NULL,
  invoice_id                     INTEGER NOT NULL,
  invoice_item_id                INTEGER NOT NULL,
  billing_advance_id             INTEGER NOT NULL,
  source_authority_version       INTEGER NOT NULL,
  source_authority_sha256        CHAR(64) NOT NULL,
  funding_task_id                INTEGER NOT NULL,
  funding_approval_receipt_id    BIGINT NOT NULL,
  allocation_evidence_sha256     CHAR(64) NOT NULL,
  reversed_amount                NUMERIC(12,2) NOT NULL,
  reversal_command_sha256        CHAR(64) NOT NULL,
  reason                         VARCHAR(40) NOT NULL,
  billing_advance_settlement_id  INTEGER,
  funding_settlement_receipt_id  BIGINT,
  funding_release_receipt_id     BIGINT,
  reversed_by                    UUID NOT NULL,
  reversed_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  evidence                       JSONB NOT NULL,
  evidence_sha256                CHAR(64) GENERATED ALWAYS AS (
    encode(public.digest(evidence::text,'sha256'),'hex')
  ) STORED NOT NULL
);

CREATE OR REPLACE FUNCTION public.enforce_pharmacy_allocation_reversal_balance_753()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  allocation_amount NUMERIC(12,2);
  prior_reversed_amount NUMERIC(12,2);
BEGIN
  SELECT allocation.allocated_amount
    INTO allocation_amount
    FROM pharmacy_payment_allocations allocation
   WHERE allocation.tenant_id=NEW.tenant_id
     AND allocation.id=NEW.allocation_id
     AND allocation.pharmacy_order_id=NEW.pharmacy_order_id
     AND allocation.invoice_id=NEW.invoice_id
     AND allocation.invoice_item_id=NEW.invoice_item_id
     AND allocation.billing_payment_id=NEW.billing_payment_id
     AND allocation.source_authority_version=NEW.source_authority_version
     AND allocation.source_authority_sha256=NEW.source_authority_sha256
   FOR UPDATE;
  IF allocation_amount IS NULL THEN
    RAISE EXCEPTION 'Pharmacy allocation reversal does not match exact allocation authority'
      USING ERRCODE='23503';
  END IF;

  SELECT COALESCE(SUM(reversal.reversed_amount),0)
    INTO prior_reversed_amount
    FROM pharmacy_payment_allocation_reversals reversal
   WHERE reversal.tenant_id=NEW.tenant_id
     AND reversal.allocation_id=NEW.allocation_id;
  IF prior_reversed_amount + NEW.reversed_amount > allocation_amount THEN
    RAISE EXCEPTION 'Pharmacy allocation reversal exceeds remaining allocation balance'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pharmacy_payment_allocation_reversal_balance_753
  ON pharmacy_payment_allocation_reversals;
CREATE TRIGGER trg_pharmacy_payment_allocation_reversal_balance_753
BEFORE INSERT ON pharmacy_payment_allocation_reversals
FOR EACH ROW EXECUTE FUNCTION public.enforce_pharmacy_allocation_reversal_balance_753();

CREATE OR REPLACE FUNCTION public.prevent_allocated_billing_payment_reversal_753()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF COALESCE(OLD.reversed,FALSE)=FALSE AND COALESCE(NEW.reversed,FALSE)=TRUE
     AND EXISTS (
       SELECT 1
         FROM pharmacy_payment_allocations allocation
         LEFT JOIN pharmacy_payment_allocation_reversals reversal
           ON reversal.tenant_id=allocation.tenant_id
          AND reversal.allocation_id=allocation.id
        WHERE allocation.tenant_id=OLD.tenant_id
          AND allocation.billing_payment_id=OLD.id
        GROUP BY allocation.id,allocation.allocated_amount
       HAVING allocation.allocated_amount
              - COALESCE(SUM(reversal.reversed_amount),0) > 0.001
     ) THEN
    RAISE EXCEPTION 'Allocated pharmacy funding payment % has unreversed pharmacy allocations', OLD.id
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_allocated_billing_payment_reversal_753
  ON billing_payments;
CREATE TRIGGER trg_prevent_allocated_billing_payment_reversal_753
BEFORE UPDATE OF reversed ON billing_payments
FOR EACH ROW EXECUTE FUNCTION public.prevent_allocated_billing_payment_reversal_753();

CREATE OR REPLACE FUNCTION public.prevent_pharmacy_payment_allocation_mutation_753()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE='23514';
END;
$$;

DROP TRIGGER IF EXISTS trg_pharmacy_payment_allocations_append_only_753
  ON pharmacy_payment_allocations;
CREATE TRIGGER trg_pharmacy_payment_allocations_append_only_753
BEFORE UPDATE OR DELETE ON pharmacy_payment_allocations
FOR EACH ROW EXECUTE FUNCTION public.prevent_pharmacy_payment_allocation_mutation_753();

DROP TRIGGER IF EXISTS trg_pharmacy_payment_allocation_reversals_append_only_753
  ON pharmacy_payment_allocation_reversals;
CREATE TRIGGER trg_pharmacy_payment_allocation_reversals_append_only_753
BEFORE UPDATE OR DELETE ON pharmacy_payment_allocation_reversals
FOR EACH ROW EXECUTE FUNCTION public.prevent_pharmacy_payment_allocation_mutation_753();

DROP TRIGGER IF EXISTS trg_pharmacy_funding_decision_events_append_only_753
  ON pharmacy_funding_decision_events;
CREATE TRIGGER trg_pharmacy_funding_decision_events_append_only_753
BEFORE UPDATE OR DELETE ON pharmacy_funding_decision_events
FOR EACH ROW EXECUTE FUNCTION public.prevent_pharmacy_payment_allocation_mutation_753();

CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_funding_events_command_753
  ON pharmacy_funding_decision_events (tenant_id, event_type, command_key_sha256);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_funding_events_tenant_id_753
  ON pharmacy_funding_decision_events (tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_funding_events_generation_753
  ON pharmacy_funding_decision_events (
    tenant_id,pharmacy_order_id,source_authority_version,
    source_authority_sha256,authority_generation
  ) WHERE authority_generation IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_funding_events_supersedes_753
  ON pharmacy_funding_decision_events (tenant_id,supersedes_event_id)
  WHERE supersedes_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pharmacy_funding_events_order_753
  ON pharmacy_funding_decision_events (tenant_id, pharmacy_order_id, recorded_at, id);
CREATE INDEX IF NOT EXISTS idx_pharmacy_funding_events_current_authority_753
  ON pharmacy_funding_decision_events (
    tenant_id,pharmacy_order_id,event_type,
    source_authority_version,source_authority_sha256,recorded_at,id
  );

ALTER TABLE pharmacy_funding_decision_events
  ADD CONSTRAINT fk_pharmacy_funding_event_supersedes_753
  FOREIGN KEY (tenant_id,supersedes_event_id)
  REFERENCES pharmacy_funding_decision_events (tenant_id,id)
  ON UPDATE RESTRICT ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION public.enforce_pharmacy_funding_event_chain_753()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  prior_event pharmacy_funding_decision_events%ROWTYPE;
BEGIN
  IF NEW.authority_generation IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'vh:pharmacy_funding_event_chain:' || NEW.tenant_id::text || ':'
      || NEW.pharmacy_order_id::text || ':' || NEW.source_authority_version::text
      || ':' || NEW.source_authority_sha256,
    753
  ));
  IF NEW.authority_generation=1 THEN
    IF EXISTS (
      SELECT 1 FROM pharmacy_funding_decision_events event
       WHERE event.tenant_id=NEW.tenant_id
         AND event.pharmacy_order_id=NEW.pharmacy_order_id
         AND event.source_authority_version=NEW.source_authority_version
         AND event.source_authority_sha256=NEW.source_authority_sha256
         AND event.authority_generation IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'Initial pharmacy funding authority generation already exists';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO prior_event
    FROM pharmacy_funding_decision_events event
   WHERE event.tenant_id=NEW.tenant_id AND event.id=NEW.supersedes_event_id
   FOR KEY SHARE;
  IF NOT FOUND
     OR prior_event.pharmacy_order_id<>NEW.pharmacy_order_id
     OR prior_event.source_authority_version<>NEW.source_authority_version
     OR prior_event.source_authority_sha256<>NEW.source_authority_sha256
     OR prior_event.authority_generation IS NULL
     OR prior_event.authority_generation<>NEW.authority_generation-1 THEN
    RAISE EXCEPTION 'Pharmacy funding supersession does not continue the exact authority chain';
  END IF;
  IF (NEW.event_type='AUTHORITY_INVALIDATED' AND prior_event.event_type<>'FUNDING_RESOLVED')
     OR (NEW.event_type='FUNDING_RESOLVED'
         AND prior_event.event_type<>'AUTHORITY_INVALIDATED') THEN
    RAISE EXCEPTION 'Pharmacy funding authority state transitions must alternate resolved and invalidated';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_pharmacy_funding_event_chain_753
  ON pharmacy_funding_decision_events;
CREATE TRIGGER trg_enforce_pharmacy_funding_event_chain_753
BEFORE INSERT ON pharmacy_funding_decision_events
FOR EACH ROW EXECUTE FUNCTION public.enforce_pharmacy_funding_event_chain_753();

ALTER TABLE pharmacy_funding_decision_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_funding_decision_events FORCE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_funding_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_funding_commands FORCE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_payment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_payment_allocations FORCE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_payment_allocation_reversals ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_payment_allocation_reversals FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON pharmacy_funding_decision_events;
CREATE POLICY tenant_isolation ON pharmacy_funding_decision_events
  AS PERMISSIVE
  USING (
    current_setting('app.current_tenant_id', TRUE) IS NULL
    OR current_setting('app.current_tenant_id', TRUE) = ''
    OR current_setting('app.current_tenant_id', TRUE) = 'bypass'
    OR tenant_id = public.app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', TRUE) IS NULL
    OR current_setting('app.current_tenant_id', TRUE) = ''
    OR current_setting('app.current_tenant_id', TRUE) = 'bypass'
    OR tenant_id = public.app_current_tenant_id_uuid()
  );

DROP POLICY IF EXISTS explicit_tenant_context ON pharmacy_funding_decision_events;
CREATE POLICY explicit_tenant_context ON pharmacy_funding_decision_events
  AS RESTRICTIVE
  USING (
    current_setting('app.current_tenant_id', TRUE) IS NOT NULL
    AND current_setting('app.current_tenant_id', TRUE) <> ''
    AND current_setting('app.current_tenant_id', TRUE) <> 'bypass'
    AND tenant_id = public.app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', TRUE) IS NOT NULL
    AND current_setting('app.current_tenant_id', TRUE) <> ''
    AND current_setting('app.current_tenant_id', TRUE) <> 'bypass'
    AND tenant_id = public.app_current_tenant_id_uuid()
  );

DROP POLICY IF EXISTS tenant_isolation ON pharmacy_funding_commands;
CREATE POLICY tenant_isolation ON pharmacy_funding_commands
  AS PERMISSIVE
  USING (
    current_setting('app.current_tenant_id', TRUE) IN ('', 'bypass')
    OR current_setting('app.current_tenant_id', TRUE) IS NULL
    OR tenant_id = public.app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', TRUE) IN ('', 'bypass')
    OR current_setting('app.current_tenant_id', TRUE) IS NULL
    OR tenant_id = public.app_current_tenant_id_uuid()
  );
DROP POLICY IF EXISTS explicit_tenant_context ON pharmacy_funding_commands;
CREATE POLICY explicit_tenant_context ON pharmacy_funding_commands
  AS RESTRICTIVE
  USING (
    current_setting('app.current_tenant_id', TRUE) IS NOT NULL
    AND current_setting('app.current_tenant_id', TRUE) NOT IN ('', 'bypass')
    AND tenant_id = public.app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', TRUE) IS NOT NULL
    AND current_setting('app.current_tenant_id', TRUE) NOT IN ('', 'bypass')
    AND tenant_id = public.app_current_tenant_id_uuid()
  );

DROP POLICY IF EXISTS tenant_isolation ON pharmacy_payment_allocations;
CREATE POLICY tenant_isolation ON pharmacy_payment_allocations
  AS PERMISSIVE
  USING (
    current_setting('app.current_tenant_id', TRUE) IN ('', 'bypass')
    OR current_setting('app.current_tenant_id', TRUE) IS NULL
    OR tenant_id = public.app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', TRUE) IN ('', 'bypass')
    OR current_setting('app.current_tenant_id', TRUE) IS NULL
    OR tenant_id = public.app_current_tenant_id_uuid()
  );
DROP POLICY IF EXISTS explicit_tenant_context ON pharmacy_payment_allocations;
CREATE POLICY explicit_tenant_context ON pharmacy_payment_allocations
  AS RESTRICTIVE
  USING (
    current_setting('app.current_tenant_id', TRUE) IS NOT NULL
    AND current_setting('app.current_tenant_id', TRUE) NOT IN ('', 'bypass')
    AND tenant_id = public.app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', TRUE) IS NOT NULL
    AND current_setting('app.current_tenant_id', TRUE) NOT IN ('', 'bypass')
    AND tenant_id = public.app_current_tenant_id_uuid()
  );

DROP POLICY IF EXISTS tenant_isolation ON pharmacy_payment_allocation_reversals;
CREATE POLICY tenant_isolation ON pharmacy_payment_allocation_reversals
  AS PERMISSIVE
  USING (
    current_setting('app.current_tenant_id', TRUE) IN ('', 'bypass')
    OR current_setting('app.current_tenant_id', TRUE) IS NULL
    OR tenant_id = public.app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', TRUE) IN ('', 'bypass')
    OR current_setting('app.current_tenant_id', TRUE) IS NULL
    OR tenant_id = public.app_current_tenant_id_uuid()
  );
DROP POLICY IF EXISTS explicit_tenant_context ON pharmacy_payment_allocation_reversals;
CREATE POLICY explicit_tenant_context ON pharmacy_payment_allocation_reversals
  AS RESTRICTIVE
  USING (
    current_setting('app.current_tenant_id', TRUE) IS NOT NULL
    AND current_setting('app.current_tenant_id', TRUE) NOT IN ('', 'bypass')
    AND tenant_id = public.app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', TRUE) IS NOT NULL
    AND current_setting('app.current_tenant_id', TRUE) NOT IN ('', 'bypass')
    AND tenant_id = public.app_current_tenant_id_uuid()
  );

CREATE UNIQUE INDEX IF NOT EXISTS ux_tpa_claims_tenant_id_753
  ON tpa_claims (tenant_id, id);

CREATE TABLE IF NOT EXISTS pharmacy_cap_reservations (
  id                    BIGSERIAL PRIMARY KEY,
  tenant_id             UUID NOT NULL,
  facility_id           INTEGER NOT NULL,
  pharmacy_order_id     INTEGER NOT NULL,
  admission_id          INTEGER NOT NULL,
  reserved_amount       NUMERIC(12,2) NOT NULL,
  funding_source        VARCHAR(32),
  funding_reference     VARCHAR(160),
  funding_tpa_claim_id  INTEGER,
  authorised_funding_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  status                VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  command_key_sha256    CHAR(64) NOT NULL,
  authority_evidence    JSONB NOT NULL DEFAULT '{}'::jsonb,
  reserved_by           UUID NOT NULL,
  released_by           UUID,
  released_at           TIMESTAMPTZ,
  release_reason        VARCHAR(255),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_pharmacy_cap_reservation_amount_753 CHECK (reserved_amount >= 0),
  CONSTRAINT chk_pharmacy_cap_reservation_funding_753 CHECK (
    authorised_funding_amount >= 0
    AND authorised_funding_amount <= reserved_amount
    AND (
      authorised_funding_amount = 0
      OR (funding_source IS NOT NULL AND funding_reference IS NOT NULL
          AND length(btrim(funding_reference)) > 0)
    )
    AND (
      (funding_source IN ('tpa_claim','mixed') AND funding_tpa_claim_id IS NOT NULL)
      OR
      (COALESCE(funding_source, '') NOT IN ('tpa_claim','mixed')
       AND funding_tpa_claim_id IS NULL)
    )
    AND COALESCE(funding_source, '') IN ('','tpa_claim','billing_payment','mixed')
  ),
  CONSTRAINT chk_pharmacy_cap_reservation_status_753 CHECK (
    status IN ('ACTIVE', 'RELEASED')
  ),
  CONSTRAINT chk_pharmacy_cap_reservation_release_753 CHECK (
    (status = 'ACTIVE' AND released_by IS NULL AND released_at IS NULL AND release_reason IS NULL)
    OR
    (status = 'RELEASED' AND released_by IS NOT NULL
      AND released_at IS NOT NULL AND release_reason IS NOT NULL
      AND length(btrim(release_reason)) BETWEEN 1 AND 255)
  ),
  CONSTRAINT chk_pharmacy_cap_reservation_command_753 CHECK (
    command_key_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT fk_pharmacy_cap_reservation_tenant_753
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pharmacy_cap_reservation_order_753
    FOREIGN KEY (tenant_id, pharmacy_order_id, facility_id)
    REFERENCES pharmacy_orders (tenant_id, id, facility_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pharmacy_cap_reservation_order_admission_753
    FOREIGN KEY (tenant_id, pharmacy_order_id, admission_id)
    REFERENCES pharmacy_orders (tenant_id, id, funding_admission_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pharmacy_cap_reservation_facility_753
    FOREIGN KEY (tenant_id, facility_id)
    REFERENCES facilities (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pharmacy_cap_reservation_admission_753
    FOREIGN KEY (tenant_id, admission_id)
    REFERENCES admissions (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pharmacy_cap_reservation_tpa_claim_753
    FOREIGN KEY (tenant_id, funding_tpa_claim_id, admission_id)
    REFERENCES tpa_claims (tenant_id, id, admission_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pharmacy_cap_reservation_actor_753
    FOREIGN KEY (tenant_id, reserved_by)
    REFERENCES users (tenant_id, uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pharmacy_cap_reservation_releaser_753
    FOREIGN KEY (tenant_id, released_by)
    REFERENCES users (tenant_id, uid)
  ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_cap_reservations_tenant_id_753
  ON pharmacy_cap_reservations (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_cap_reservations_event_identity_753
  ON pharmacy_cap_reservations (tenant_id, id, pharmacy_order_id, admission_id);

CREATE TABLE IF NOT EXISTS pharmacy_cap_reservation_events (
  id                    BIGSERIAL PRIMARY KEY,
  tenant_id             UUID NOT NULL,
  reservation_id        BIGINT NOT NULL,
  pharmacy_order_id     INTEGER NOT NULL,
  admission_id          INTEGER NOT NULL,
  event_type            VARCHAR(20) NOT NULL,
  prior_amount          NUMERIC(12,2),
  resulting_amount      NUMERIC(12,2) NOT NULL,
  command_key_sha256    CHAR(64) NOT NULL,
  reason                VARCHAR(255),
  evidence              JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_by           UUID NOT NULL,
  recorded_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_pharmacy_cap_reservation_event_type_753 CHECK (
    event_type IN ('RESERVED', 'UPDATED', 'RELEASED')
  ),
  CONSTRAINT chk_pharmacy_cap_reservation_event_amount_753 CHECK (
    (prior_amount IS NULL OR prior_amount >= 0)
    AND resulting_amount >= 0
    AND command_key_sha256 ~ '^[0-9a-f]{64}$'
    AND (
      (event_type='RESERVED' AND prior_amount IS NULL AND reason IS NULL)
      OR
      (event_type='UPDATED' AND prior_amount IS NOT NULL AND reason IS NULL)
      OR
      (event_type='RELEASED' AND prior_amount IS NOT NULL
       AND resulting_amount=0 AND reason IS NOT NULL AND length(btrim(reason)) > 0)
    )
  ),
  CONSTRAINT fk_pharmacy_cap_reservation_event_reservation_753
    FOREIGN KEY (tenant_id, reservation_id, pharmacy_order_id, admission_id)
    REFERENCES pharmacy_cap_reservations (tenant_id, id, pharmacy_order_id, admission_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pharmacy_cap_reservation_event_order_753
    FOREIGN KEY (tenant_id, pharmacy_order_id)
    REFERENCES pharmacy_orders (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pharmacy_cap_reservation_event_admission_753
    FOREIGN KEY (tenant_id, admission_id)
    REFERENCES admissions (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pharmacy_cap_reservation_event_actor_753
    FOREIGN KEY (tenant_id, recorded_by)
    REFERENCES users (tenant_id, uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_cap_reservations_tenant_id_753
  ON pharmacy_cap_reservations (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_cap_reservations_order_753
  ON pharmacy_cap_reservations (tenant_id, pharmacy_order_id);
CREATE INDEX IF NOT EXISTS idx_pharmacy_cap_reservations_admission_753
  ON pharmacy_cap_reservations (tenant_id, admission_id, status)
  WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_cap_reservation_events_command_753
  ON pharmacy_cap_reservation_events (tenant_id, event_type, command_key_sha256);
CREATE INDEX IF NOT EXISTS idx_pharmacy_cap_reservation_events_order_753
  ON pharmacy_cap_reservation_events (tenant_id, pharmacy_order_id, recorded_at, id);

DROP TRIGGER IF EXISTS trg_pharmacy_cap_reservation_events_append_only_753
  ON pharmacy_cap_reservation_events;
CREATE TRIGGER trg_pharmacy_cap_reservation_events_append_only_753
BEFORE UPDATE OR DELETE ON pharmacy_cap_reservation_events
FOR EACH ROW EXECUTE FUNCTION public.prevent_pharmacy_payment_allocation_mutation_753();

ALTER TABLE pharmacy_cap_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_cap_reservations FORCE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_cap_reservation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_cap_reservation_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON pharmacy_cap_reservations;
CREATE POLICY tenant_isolation ON pharmacy_cap_reservations
  AS PERMISSIVE
  USING (
    current_setting('app.current_tenant_id', TRUE) IS NULL
    OR current_setting('app.current_tenant_id', TRUE) = ''
    OR current_setting('app.current_tenant_id', TRUE) = 'bypass'
    OR tenant_id = public.app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', TRUE) IS NULL
    OR current_setting('app.current_tenant_id', TRUE) = ''
    OR current_setting('app.current_tenant_id', TRUE) = 'bypass'
    OR tenant_id = public.app_current_tenant_id_uuid()
  );

DROP POLICY IF EXISTS explicit_tenant_context ON pharmacy_cap_reservations;
CREATE POLICY explicit_tenant_context ON pharmacy_cap_reservations
  AS RESTRICTIVE
  USING (
    current_setting('app.current_tenant_id', TRUE) IS NOT NULL
    AND current_setting('app.current_tenant_id', TRUE) <> ''
    AND current_setting('app.current_tenant_id', TRUE) <> 'bypass'
    AND tenant_id = public.app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', TRUE) IS NOT NULL
    AND current_setting('app.current_tenant_id', TRUE) <> ''
    AND current_setting('app.current_tenant_id', TRUE) <> 'bypass'
    AND tenant_id = public.app_current_tenant_id_uuid()
  );

DROP POLICY IF EXISTS tenant_isolation ON pharmacy_cap_reservation_events;
CREATE POLICY tenant_isolation ON pharmacy_cap_reservation_events
  AS PERMISSIVE
  USING (
    current_setting('app.current_tenant_id', TRUE) IS NULL
    OR current_setting('app.current_tenant_id', TRUE) = ''
    OR current_setting('app.current_tenant_id', TRUE) = 'bypass'
    OR tenant_id = public.app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', TRUE) IS NULL
    OR current_setting('app.current_tenant_id', TRUE) = ''
    OR current_setting('app.current_tenant_id', TRUE) = 'bypass'
    OR tenant_id = public.app_current_tenant_id_uuid()
  );

DROP POLICY IF EXISTS explicit_tenant_context ON pharmacy_cap_reservation_events;
CREATE POLICY explicit_tenant_context ON pharmacy_cap_reservation_events
  AS RESTRICTIVE
  USING (
    current_setting('app.current_tenant_id', TRUE) IS NOT NULL
    AND current_setting('app.current_tenant_id', TRUE) <> ''
    AND current_setting('app.current_tenant_id', TRUE) <> 'bypass'
    AND tenant_id = public.app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', TRUE) IS NOT NULL
    AND current_setting('app.current_tenant_id', TRUE) <> ''
    AND current_setting('app.current_tenant_id', TRUE) <> 'bypass'
    AND tenant_id = public.app_current_tenant_id_uuid()
  );

-- Cath consumable custody is pinned to the exact active facility/item mapping.
-- Legacy rows that cannot be proven are kept visible in the authority worklist;
-- they are never assigned to a default facility by this migration.
-- The cath entity types ('cath_consumable_catalog', 'cath_consumable_usage',
-- 'cath_lab_case') are already in the single authoritative entity_type CHECK
-- on pharmacy_inventory_authority_recovery_worklist. A second CHECK here would
-- AND with it and drop 'ward_indent' / 'supplier' / 'counter_sale' out of the
-- effective allow-list, aborting this migration on any data-bearing database.
ALTER TABLE cath_consumable_catalog
  ADD COLUMN IF NOT EXISTS facility_id INTEGER;

ALTER TABLE cath_lab_cases
  ADD COLUMN IF NOT EXISTS facility_id INTEGER;

ALTER TABLE cath_case_consumable_usage
  ADD COLUMN IF NOT EXISTS facility_id INTEGER,
  ADD COLUMN IF NOT EXISTS inventory_item_id INTEGER;

UPDATE cath_lab_cases cath_case
   SET facility_id=(cath_case.metadata->>'facility_id')::int,
       updated_at=NOW()
  FROM facilities facility
 WHERE cath_case.facility_id IS NULL
   AND cath_case.metadata->>'facility_id' ~ '^[1-9][0-9]*$'
   AND facility.tenant_id=cath_case.tenant_id
   AND facility.id=(cath_case.metadata->>'facility_id')::int
   AND facility.status='active';

UPDATE cath_lab_cases cath_case
   SET facility_id=(encounter.metadata->>'facility_id')::int,
       updated_at=NOW()
  FROM patient_encounters encounter
  JOIN facilities facility
    ON facility.tenant_id=encounter.tenant_id
   AND encounter.metadata->>'facility_id' ~ '^[1-9][0-9]*$'
   AND facility.id=(encounter.metadata->>'facility_id')::int
   AND facility.status='active'
 WHERE cath_case.facility_id IS NULL
   AND cath_case.tenant_id=encounter.tenant_id
   AND cath_case.encounter_id=encounter.id
   AND cath_case.patient_uid=encounter.patient_uid;

ALTER TABLE cath_consumable_catalog
  DROP CONSTRAINT IF EXISTS chk_cath_catalog_active_facility_mapping_753,
  ADD CONSTRAINT chk_cath_catalog_active_facility_mapping_753
    CHECK (
      status <> 'active'
      OR (facility_id IS NOT NULL AND inventory_item_id IS NOT NULL)
    ) NOT VALID;

ALTER TABLE cath_lab_cases
  DROP CONSTRAINT IF EXISTS chk_cath_lab_case_facility_required_753,
  ADD CONSTRAINT chk_cath_lab_case_facility_required_753
    CHECK (facility_id IS NOT NULL) NOT VALID;

ALTER TABLE cath_case_consumable_usage
  DROP CONSTRAINT IF EXISTS cath_consumable_usage_inventory_status_check,
  ADD CONSTRAINT cath_consumable_usage_inventory_status_check
    CHECK (inventory_decrement_status IN (
      'pending', 'not_linked', 'decremented', 'insufficient_stock', 'error',
      'not_applicable'
    )),
  DROP CONSTRAINT IF EXISTS chk_cath_usage_exact_inventory_authority_753,
  ADD CONSTRAINT chk_cath_usage_exact_inventory_authority_753
    CHECK (
      (
        facility_id IS NOT NULL
        AND inventory_item_id IS NOT NULL
        AND inventory_batch_id IS NOT NULL
      )
      OR (
        inventory_decrement_status='not_applicable'
        AND metadata->'authority_recovery'->>'action' IN ('PRESERVE','CANCEL')
        AND facility_id IS NULL
        AND inventory_item_id IS NULL
        AND inventory_batch_id IS NULL
        AND inventory_movement_id IS NULL
      )
    ) NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS ux_cath_catalog_facility_item_scope_753
  ON cath_consumable_catalog (tenant_id, facility_id, id, inventory_item_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_batches_facility_item_id_cath_753
  ON pharmacy_inventory_batches (tenant_id, facility_id, id, inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_cath_usage_facility_reconciliation_753
  ON cath_case_consumable_usage (
    tenant_id, facility_id, inventory_decrement_status, used_at, id
  );
CREATE UNIQUE INDEX IF NOT EXISTS ux_cath_lab_cases_usage_facility_753
  ON cath_lab_cases (tenant_id, id, patient_uid, facility_id);
CREATE INDEX IF NOT EXISTS idx_cath_lab_cases_facility_753
  ON cath_lab_cases (tenant_id, facility_id, status, planned_start_at)
  WHERE facility_id IS NOT NULL;

ALTER TABLE cath_lab_cases
  DROP CONSTRAINT IF EXISTS fk_cath_lab_case_facility_753,
  ADD CONSTRAINT fk_cath_lab_case_facility_753
    FOREIGN KEY (tenant_id, facility_id)
    REFERENCES facilities (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID;

ALTER TABLE cath_consumable_catalog
  DROP CONSTRAINT IF EXISTS fk_cath_catalog_facility_753,
  DROP CONSTRAINT IF EXISTS fk_cath_catalog_facility_item_753,
  ADD CONSTRAINT fk_cath_catalog_facility_753
    FOREIGN KEY (tenant_id, facility_id)
    REFERENCES facilities (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT fk_cath_catalog_facility_item_753
    FOREIGN KEY (tenant_id, facility_id, inventory_item_id)
    REFERENCES pharmacy_inventory_items (tenant_id, facility_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID;

ALTER TABLE cath_case_consumable_usage
  DROP CONSTRAINT IF EXISTS fk_cath_usage_case_facility_753,
  DROP CONSTRAINT IF EXISTS fk_cath_usage_facility_catalog_item_753,
  DROP CONSTRAINT IF EXISTS fk_cath_usage_facility_batch_753,
  ADD CONSTRAINT fk_cath_usage_case_facility_753
    FOREIGN KEY (tenant_id, case_id, patient_uid, facility_id)
    REFERENCES cath_lab_cases (tenant_id, id, patient_uid, facility_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  ADD CONSTRAINT fk_cath_usage_facility_catalog_item_753
    FOREIGN KEY (tenant_id, facility_id, catalog_item_id, inventory_item_id)
    REFERENCES cath_consumable_catalog (tenant_id, facility_id, id, inventory_item_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT fk_cath_usage_facility_batch_753
    FOREIGN KEY (tenant_id, facility_id, inventory_batch_id, inventory_item_id)
    REFERENCES pharmacy_inventory_batches (tenant_id, facility_id, id, inventory_item_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID;

INSERT INTO pharmacy_inventory_authority_recovery_worklist (
  tenant_id, entity_type, entity_id, inventory_item_id, facility_id,
  reason_code, authority_snapshot
)
SELECT catalog.tenant_id, 'cath_consumable_catalog', catalog.id,
       catalog.inventory_item_id, catalog.facility_id,
       'CATH_CATALOG_FACILITY_UNRESOLVED',
       jsonb_build_object(
         'catalog_item_id', catalog.id::text,
         'inventory_item_id', catalog.inventory_item_id,
         'facility_id', catalog.facility_id,
         'catalog_status', catalog.status,
         'inventory_item_status', item.status,
         'inventory_item_facility_id', item.facility_id,
         'facility_status', facility.status,
         'recovery_action', 'retire_or_map_catalog_to_one_active_facility_inventory_item'
       )
  FROM cath_consumable_catalog catalog
  LEFT JOIN pharmacy_inventory_items item
    ON item.tenant_id=catalog.tenant_id AND item.id=catalog.inventory_item_id
  LEFT JOIN facilities facility
    ON facility.tenant_id=catalog.tenant_id AND facility.id=catalog.facility_id
 WHERE catalog.facility_id IS NULL
    OR catalog.inventory_item_id IS NULL
    OR item.id IS NULL
    OR item.facility_id IS DISTINCT FROM catalog.facility_id
    OR item.status IS DISTINCT FROM 'active'
    OR facility.status IS DISTINCT FROM 'active'
ON CONFLICT (tenant_id, entity_type, entity_id, reason_code) DO UPDATE
  SET inventory_item_id=EXCLUDED.inventory_item_id,
      facility_id=EXCLUDED.facility_id,
      authority_snapshot=EXCLUDED.authority_snapshot,
      status='OPEN', resolved_by=NULL, resolved_at=NULL, resolution_note=NULL,
      updated_at=NOW();

INSERT INTO pharmacy_inventory_authority_recovery_worklist (
  tenant_id, entity_type, entity_id, facility_id, reason_code, authority_snapshot
)
SELECT cath_case.tenant_id, 'cath_lab_case', cath_case.id, cath_case.facility_id,
       'CATH_CASE_FACILITY_UNRESOLVED',
       jsonb_build_object(
         'case_id', cath_case.id::text,
         'patient_uid', cath_case.patient_uid,
         'encounter_id', cath_case.encounter_id,
         'facility_id', cath_case.facility_id,
         'facility_status', facility.status,
         'encounter_facility_id', CASE
           WHEN encounter.metadata->>'facility_id' ~ '^[1-9][0-9]*$'
           THEN (encounter.metadata->>'facility_id')::int
           ELSE NULL
         END,
         'case_status', cath_case.status,
         'recovery_action', 'pin_case_to_one_exact_active_facility'
       )
  FROM cath_lab_cases cath_case
  LEFT JOIN facilities facility
    ON facility.tenant_id=cath_case.tenant_id
   AND facility.id=cath_case.facility_id
  LEFT JOIN patient_encounters encounter
    ON encounter.tenant_id=cath_case.tenant_id
   AND encounter.id=cath_case.encounter_id
   AND encounter.patient_uid=cath_case.patient_uid
 WHERE cath_case.facility_id IS NULL
    OR facility.status IS DISTINCT FROM 'active'
    OR (
      cath_case.encounter_id IS NOT NULL
      AND (
        encounter.id IS NULL
        OR cath_case.facility_id IS DISTINCT FROM
             CASE
               WHEN encounter.metadata->>'facility_id' ~ '^[1-9][0-9]*$'
               THEN (encounter.metadata->>'facility_id')::int
               ELSE NULL
             END
      )
    )
ON CONFLICT (tenant_id, entity_type, entity_id, reason_code) DO UPDATE
  SET facility_id=EXCLUDED.facility_id,
      authority_snapshot=EXCLUDED.authority_snapshot,
      status='OPEN', resolved_by=NULL, resolved_at=NULL, resolution_note=NULL,
      updated_at=NOW();

INSERT INTO pharmacy_inventory_authority_recovery_worklist (
  tenant_id, entity_type, entity_id, inventory_item_id, facility_id,
  reason_code, authority_snapshot
)
SELECT usage.tenant_id, 'cath_consumable_usage', usage.id,
       usage.inventory_item_id, usage.facility_id,
       'CATH_USAGE_AUTHORITY_UNRESOLVED',
       jsonb_build_object(
         'usage_id', usage.id::text,
         'case_id', usage.case_id::text,
         'catalog_item_id', usage.catalog_item_id::text,
           'inventory_item_id', usage.inventory_item_id,
           'inventory_batch_id', usage.inventory_batch_id,
           'facility_id', usage.facility_id,
           'case_facility_id', cath_case.facility_id,
           'encounter_facility_id', CASE
             WHEN case_encounter.metadata->>'facility_id' ~ '^[1-9][0-9]*$'
             THEN (case_encounter.metadata->>'facility_id')::int
             ELSE NULL
           END,
           'catalog_facility_id', catalog.facility_id,
           'catalog_inventory_item_id', catalog.inventory_item_id,
           'batch_facility_id', batch.facility_id,
           'batch_inventory_item_id', batch.inventory_item_id,
           'batch_status', batch.status,
           'recovery_action', 'bind_usage_to_the_exact_catalog_facility_inventory_identity'
         )
  FROM cath_case_consumable_usage usage
  LEFT JOIN cath_consumable_catalog catalog
    ON catalog.tenant_id=usage.tenant_id AND catalog.id=usage.catalog_item_id
  LEFT JOIN pharmacy_inventory_items item
    ON item.tenant_id=usage.tenant_id
   AND item.facility_id=usage.facility_id
   AND item.id=usage.inventory_item_id
    LEFT JOIN facilities facility
      ON facility.tenant_id=usage.tenant_id AND facility.id=usage.facility_id
  LEFT JOIN pharmacy_inventory_batches batch
      ON batch.tenant_id=usage.tenant_id AND batch.id=usage.inventory_batch_id
  LEFT JOIN cath_lab_cases cath_case
    ON cath_case.tenant_id=usage.tenant_id
   AND cath_case.id=usage.case_id
   AND cath_case.patient_uid=usage.patient_uid
  LEFT JOIN patient_encounters case_encounter
    ON case_encounter.tenant_id=cath_case.tenant_id
   AND case_encounter.id=cath_case.encounter_id
   AND case_encounter.patient_uid=cath_case.patient_uid
   WHERE usage.facility_id IS NULL
      OR usage.inventory_item_id IS NULL
      OR usage.inventory_batch_id IS NULL
      OR catalog.facility_id IS DISTINCT FROM usage.facility_id
      OR catalog.inventory_item_id IS DISTINCT FROM usage.inventory_item_id
      OR item.status IS DISTINCT FROM 'active'
      OR facility.status IS DISTINCT FROM 'active'
      OR batch.id IS NULL
      OR batch.facility_id IS DISTINCT FROM usage.facility_id
      OR batch.inventory_item_id IS DISTINCT FROM usage.inventory_item_id
      OR batch.batch_number IS DISTINCT FROM usage.batch_number
      OR batch.lot_number IS DISTINCT FROM usage.lot_number
      OR batch.expiry_date IS DISTINCT FROM usage.expiry_date
      OR cath_case.facility_id IS DISTINCT FROM usage.facility_id
      OR (
        cath_case.encounter_id IS NOT NULL
        AND (
          case_encounter.id IS NULL
          OR cath_case.facility_id IS DISTINCT FROM
               CASE
                 WHEN case_encounter.metadata->>'facility_id' ~ '^[1-9][0-9]*$'
                 THEN (case_encounter.metadata->>'facility_id')::int
                 ELSE NULL
               END
        )
      )
      OR NOT EXISTS (
        SELECT 1
          FROM clinical_timeline_events timeline
         WHERE timeline.tenant_id=usage.tenant_id
           AND timeline.id=usage.timeline_event_id
           AND timeline.patient_uid=usage.patient_uid
           AND timeline.encounter_id IS NOT DISTINCT FROM cath_case.encounter_id
           AND timeline.source_table='cath_case_consumable_usage'
           AND timeline.source_id=usage.id::text
           AND timeline.resource_type='cath_case_consumable_usage'
           AND timeline.resource_id=usage.id::text
           AND timeline.actor_uid IS NOT DISTINCT FROM usage.used_by
           AND timeline.event_type=CASE WHEN usage.wasted
             THEN 'cath_lab.consumable_wasted' ELSE 'cath_lab.consumable_used' END
           AND timeline.payload->>'facility_id'=usage.facility_id::text
           AND timeline.payload->>'inventory_item_id'=usage.inventory_item_id::text
           AND timeline.payload->>'inventory_batch_id'=usage.inventory_batch_id::text
      )
      OR NOT EXISTS (
        SELECT 1
          FROM clinical_audit_events audit
         WHERE audit.tenant_id=usage.tenant_id
           AND audit.id=usage.audit_event_id
           AND audit.patient_uid IS NOT DISTINCT FROM usage.patient_uid
           AND audit.encounter_id IS NOT DISTINCT FROM cath_case.encounter_id
           AND audit.resource_table='cath_case_consumable_usage'
           AND audit.resource_id=usage.id::text
           AND audit.actor_uid IS NOT DISTINCT FROM usage.used_by
           AND audit.action=CASE WHEN usage.wasted
             THEN 'cath_lab.consumable_wasted' ELSE 'cath_lab.consumable_used' END
      )
      OR EXISTS (
        SELECT 1
          FROM pharmacy_stock_movements movement
         WHERE movement.tenant_id=usage.tenant_id
           AND (
             (movement.reference_type='cath_consumable_usage'
              AND movement.reference_id=usage.id::text)
             OR (movement.reference_type='cath_consumable_reconciliation'
              AND movement.metadata->>'cath_consumable_usage_id'=usage.id::text)
           )
           AND (
             movement.inventory_item_id IS DISTINCT FROM usage.inventory_item_id
             OR movement.inventory_batch_id IS DISTINCT FROM usage.inventory_batch_id
             OR movement.movement_kind IS DISTINCT FROM
                  CASE WHEN usage.wasted THEN 'dispose' ELSE 'issue' END
             OR movement.quantity_delta >= 0
             OR movement.metadata->>'facility_id' IS DISTINCT FROM usage.facility_id::text
             OR movement.performed_by::text
                  IS DISTINCT FROM movement.metadata->>'canonical_actor_uid'
             OR movement.metadata->>'actor_facility_grant_id' !~ '^[1-9][0-9]*$'
             OR NOT EXISTS (
               SELECT 1
                 FROM pharmacy_staff_facility_grants movement_grant
                WHERE movement_grant.tenant_id=movement.tenant_id
                  AND movement_grant.id::text=
                        movement.metadata->>'actor_facility_grant_id'
                  AND movement_grant.staff_uid=movement.performed_by
                  AND movement_grant.facility_id=usage.facility_id
                  AND movement_grant.granted_at <= movement.created_at
                  AND (movement_grant.revoked_at IS NULL
                       OR movement_grant.revoked_at >= movement.created_at)
             )
           )
      )
      OR (
        usage.inventory_decrement_status IN (
          'pending','not_linked','insufficient_stock','error'
        )
        AND (
          NOT EXISTS (
            SELECT 1
              FROM tasks task
             WHERE task.tenant_id=usage.tenant_id
               AND task.related_resource_type='cath_case_consumable_usage'
               AND task.related_resource_id=usage.id::text
               AND task.metadata->>'task_contract'='cath_inventory_shortfall_v1'
               AND task.patient_uid=usage.patient_uid
               AND task.metadata->>'cath_consumable_usage_id'=usage.id::text
               AND task.metadata->>'cath_case_id'=usage.case_id::text
               AND task.metadata->>'facility_id'=usage.facility_id::text
               AND task.metadata->>'inventory_item_id'=usage.inventory_item_id::text
               AND task.metadata->>'inventory_batch_id'=usage.inventory_batch_id::text
          )
          OR NOT EXISTS (
            SELECT 1
              FROM workflow_sla_instances sla
             WHERE sla.tenant_id=usage.tenant_id
               AND sla.rule_code='cath_consumable_inventory_reconciliation'
               AND sla.source_table='cath_case_consumable_usage'
               AND sla.source_id=usage.id::text
               AND sla.patient_uid=usage.patient_uid
               AND sla.encounter_id IS NOT DISTINCT FROM cath_case.encounter_id
               AND sla.metadata->>'cath_case_id'=usage.case_id::text
               AND sla.metadata->>'inventory_facility_id'=usage.facility_id::text
               AND sla.metadata->>'inventory_item_id'=usage.inventory_item_id::text
               AND sla.metadata->>'inventory_batch_id'=usage.inventory_batch_id::text
          )
          OR NOT EXISTS (
            SELECT 1
              FROM notification_outbox outbox
             WHERE outbox.tenant_id=usage.tenant_id
               AND outbox.type='cath_inventory_shortfall'
               AND outbox.source_event_key='cath-inventory-shortfall:' || usage.id::text
               AND outbox.payload->>'cath_consumable_usage_id'=usage.id::text
               AND outbox.payload->>'cath_case_id'=usage.case_id::text
               AND outbox.payload->>'facility_id'=usage.facility_id::text
               AND outbox.payload->>'inventory_item_id'=usage.inventory_item_id::text
               AND outbox.payload->>'inventory_batch_id'=usage.inventory_batch_id::text
               AND (
                 outbox.payload->>'delivery_coverage' IS DISTINCT FROM 'direct'
                 OR (
                   outbox.payload->>'recipient_facility_grant_id' ~ '^[1-9][0-9]*$'
                   AND EXISTS (
                     SELECT 1
                       FROM pharmacy_staff_facility_grants recipient_grant
                       JOIN users recipient
                         ON recipient.tenant_id=recipient_grant.tenant_id
                        AND recipient.uid=recipient_grant.staff_uid
                       JOIN staff recipient_staff
                         ON recipient_staff.tenant_id=recipient.tenant_id
                        AND recipient_staff.user_id=recipient.uid
                      WHERE recipient_grant.tenant_id=usage.tenant_id
                        AND recipient_grant.id::text=
                              outbox.payload->>'recipient_facility_grant_id'
                        AND recipient_grant.facility_id=usage.facility_id
                        AND recipient_grant.staff_uid::text=
                              outbox.payload->>'recipient_uid'
                        AND recipient.id::text=outbox.recipient_id
                        AND outbox.payload->>'recipient_status_snapshot'='active'
                        AND outbox.payload->>'recipient_not_deleted_snapshot'='true'
                        AND recipient_grant.granted_at <= outbox.created_at
                        AND (recipient_grant.revoked_at IS NULL
                             OR recipient_grant.revoked_at >= outbox.created_at)
                   )
                 )
               )
          )
        )
      )
ON CONFLICT (tenant_id, entity_type, entity_id, reason_code) DO UPDATE
  SET inventory_item_id=EXCLUDED.inventory_item_id,
      facility_id=EXCLUDED.facility_id,
      authority_snapshot=EXCLUDED.authority_snapshot,
      status='OPEN', resolved_by=NULL, resolved_at=NULL, resolution_note=NULL,
      updated_at=NOW();

-- Cath authority identity is append-only after it has been established. A governed
-- recovery may repair a disputed mapping only while the matching recovery row is
-- locked OPEN and a durable command receipt is present in the transaction context.
CREATE OR REPLACE FUNCTION public.cath_authority_identity_guard_753()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $cath_authority_identity_guard_753$
DECLARE
  command_sha TEXT := current_setting(
    'app.pharmacy_recovery_command_key_sha256', TRUE
  );
  recovery_open BOOLEAN := FALSE;
  recovery_required BOOLEAN := FALSE;
BEGIN
  IF TG_TABLE_NAME = 'cath_lab_cases' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Cath case authority identity is append-only'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.id IS DISTINCT FROM OLD.id
       OR NEW.patient_uid IS DISTINCT FROM OLD.patient_uid
       OR NEW.encounter_id IS DISTINCT FROM OLD.encounter_id
    THEN
      RAISE EXCEPTION 'Cath case clinical identity is immutable'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.facility_id IS DISTINCT FROM OLD.facility_id THEN
      recovery_required := TRUE;
      SELECT EXISTS (
        SELECT 1
          FROM public.pharmacy_inventory_authority_recovery_worklist recovery
         WHERE recovery.tenant_id=OLD.tenant_id
           AND recovery.entity_type='cath_lab_case'
           AND recovery.entity_id=OLD.id
           AND recovery.status='OPEN'
      ) INTO recovery_open;
    END IF;
  ELSIF TG_TABLE_NAME = 'cath_consumable_catalog' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Cath consumable catalog authority identity is append-only'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.id IS DISTINCT FROM OLD.id
    THEN
      RAISE EXCEPTION 'Cath consumable catalog identity is immutable'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.facility_id IS DISTINCT FROM OLD.facility_id
       OR NEW.inventory_item_id IS DISTINCT FROM OLD.inventory_item_id
    THEN
      recovery_required := TRUE;
      SELECT EXISTS (
        SELECT 1
          FROM public.pharmacy_inventory_authority_recovery_worklist recovery
         WHERE recovery.tenant_id=OLD.tenant_id
           AND recovery.entity_type='cath_consumable_catalog'
           AND recovery.entity_id=OLD.id
           AND recovery.status='OPEN'
      ) INTO recovery_open;
    END IF;
  ELSIF TG_TABLE_NAME = 'cath_case_consumable_usage' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Cath consumable clinical history is append-only'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.id IS DISTINCT FROM OLD.id
       OR NEW.case_id IS DISTINCT FROM OLD.case_id
       OR NEW.procedure_log_id IS DISTINCT FROM OLD.procedure_log_id
       OR NEW.catalog_item_id IS DISTINCT FROM OLD.catalog_item_id
       OR NEW.patient_uid IS DISTINCT FROM OLD.patient_uid
       OR NEW.quantity IS DISTINCT FROM OLD.quantity
       OR NEW.batch_tracked IS DISTINCT FROM OLD.batch_tracked
       OR NEW.is_implant IS DISTINCT FROM OLD.is_implant
       OR NEW.serial_number IS DISTINCT FROM OLD.serial_number
       OR NEW.used_by IS DISTINCT FROM OLD.used_by
       OR NEW.used_at IS DISTINCT FROM OLD.used_at
       OR NEW.wasted IS DISTINCT FROM OLD.wasted
       OR NEW.waste_reason IS DISTINCT FROM OLD.waste_reason
       OR (OLD.timeline_event_id IS NOT NULL
           AND NEW.timeline_event_id IS DISTINCT FROM OLD.timeline_event_id)
       OR (OLD.audit_event_id IS NOT NULL
           AND NEW.audit_event_id IS DISTINCT FROM OLD.audit_event_id)
    THEN
      RAISE EXCEPTION 'Cath consumable clinical and canonical-event identity is immutable'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.facility_id IS DISTINCT FROM OLD.facility_id
       OR NEW.inventory_item_id IS DISTINCT FROM OLD.inventory_item_id
       OR NEW.inventory_batch_id IS DISTINCT FROM OLD.inventory_batch_id
       OR NEW.batch_number IS DISTINCT FROM OLD.batch_number
       OR NEW.lot_number IS DISTINCT FROM OLD.lot_number
       OR NEW.expiry_date IS DISTINCT FROM OLD.expiry_date
    THEN
      recovery_required := TRUE;
      SELECT EXISTS (
        SELECT 1
          FROM public.pharmacy_inventory_authority_recovery_worklist recovery
         WHERE recovery.tenant_id=OLD.tenant_id
           AND recovery.entity_type='cath_consumable_usage'
           AND recovery.entity_id=OLD.id
           AND recovery.status='OPEN'
      ) INTO recovery_open;
    END IF;
  ELSIF TG_TABLE_NAME = 'tasks' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Cath inventory worklist identity is append-only'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.id IS DISTINCT FROM OLD.id
       OR NEW.patient_uid IS DISTINCT FROM OLD.patient_uid
       OR NEW.related_resource_type IS DISTINCT FROM OLD.related_resource_type
       OR NEW.related_resource_id IS DISTINCT FROM OLD.related_resource_id
       OR NEW.workflow_sla_instance_id IS DISTINCT FROM OLD.workflow_sla_instance_id
       OR NEW.stage_occurrence_key IS DISTINCT FROM OLD.stage_occurrence_key
       OR NEW.metadata->>'task_contract' IS DISTINCT FROM OLD.metadata->>'task_contract'
       OR NEW.metadata->>'cath_consumable_usage_id'
            IS DISTINCT FROM OLD.metadata->>'cath_consumable_usage_id'
       OR NEW.metadata->>'cath_case_id' IS DISTINCT FROM OLD.metadata->>'cath_case_id'
       OR NEW.metadata->>'facility_id' IS DISTINCT FROM OLD.metadata->>'facility_id'
       OR NEW.metadata->>'inventory_item_id'
            IS DISTINCT FROM OLD.metadata->>'inventory_item_id'
       OR NEW.metadata->>'inventory_batch_id'
            IS DISTINCT FROM OLD.metadata->>'inventory_batch_id'
    THEN
      RAISE EXCEPTION 'Cath inventory worklist source authority is immutable'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'workflow_sla_instances' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Cath inventory SLA identity is append-only'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.id IS DISTINCT FROM OLD.id
       OR NEW.rule_id IS DISTINCT FROM OLD.rule_id
       OR NEW.rule_code IS DISTINCT FROM OLD.rule_code
       OR NEW.patient_uid IS DISTINCT FROM OLD.patient_uid
       OR NEW.encounter_id IS DISTINCT FROM OLD.encounter_id
       OR NEW.source_table IS DISTINCT FROM OLD.source_table
       OR NEW.source_id IS DISTINCT FROM OLD.source_id
       OR NEW.metadata->>'task_contract' IS DISTINCT FROM OLD.metadata->>'task_contract'
       OR NEW.metadata->>'cath_consumable_usage_id'
            IS DISTINCT FROM OLD.metadata->>'cath_consumable_usage_id'
       OR NEW.metadata->>'cath_case_id' IS DISTINCT FROM OLD.metadata->>'cath_case_id'
       OR NEW.metadata->>'inventory_facility_id'
            IS DISTINCT FROM OLD.metadata->>'inventory_facility_id'
       OR NEW.metadata->>'inventory_item_id'
            IS DISTINCT FROM OLD.metadata->>'inventory_item_id'
       OR NEW.metadata->>'inventory_batch_id'
            IS DISTINCT FROM OLD.metadata->>'inventory_batch_id'
    THEN
      RAISE EXCEPTION 'Cath inventory SLA source authority is immutable'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'notification_outbox' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Cath inventory notification intent is append-only'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.id IS DISTINCT FROM OLD.id
       OR NEW.type IS DISTINCT FROM OLD.type
       OR NEW.recipient_id IS DISTINCT FROM OLD.recipient_id
       OR NEW.channel IS DISTINCT FROM OLD.channel
       OR NEW.source_event_key IS DISTINCT FROM OLD.source_event_key
       OR NEW.recipient_key IS DISTINCT FROM OLD.recipient_key
       OR NEW.template_version IS DISTINCT FROM OLD.template_version
       OR NEW.rendered_intent_hash IS DISTINCT FROM OLD.rendered_intent_hash
       OR NEW.payload->>'cath_consumable_usage_id'
            IS DISTINCT FROM OLD.payload->>'cath_consumable_usage_id'
       OR NEW.payload->>'cath_case_id' IS DISTINCT FROM OLD.payload->>'cath_case_id'
       OR NEW.payload->>'facility_id' IS DISTINCT FROM OLD.payload->>'facility_id'
       OR NEW.payload->>'inventory_item_id'
            IS DISTINCT FROM OLD.payload->>'inventory_item_id'
       OR NEW.payload->>'inventory_batch_id'
            IS DISTINCT FROM OLD.payload->>'inventory_batch_id'
       OR NEW.payload->>'recipient_uid' IS DISTINCT FROM OLD.payload->>'recipient_uid'
       OR NEW.payload->>'recipient_facility_grant_id'
            IS DISTINCT FROM OLD.payload->>'recipient_facility_grant_id'
    THEN
      RAISE EXCEPTION 'Cath inventory notification authority identity is immutable'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'pharmacy_stock_movements' THEN
    RAISE EXCEPTION 'Cath inventory stock movement evidence is append-only'
      USING ERRCODE = '23514';
  ELSE
    RAISE EXCEPTION 'Unsupported Cath authority identity source'
      USING ERRCODE = '23514';
  END IF;

  IF recovery_required AND NOT recovery_open THEN
    RAISE EXCEPTION 'Cath inventory authority identity may only change through governed recovery'
      USING ERRCODE = '23514';
  END IF;
  IF recovery_required
     AND (command_sha IS NULL OR command_sha !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'Cath authority repair requires a durable recovery command receipt'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$cath_authority_identity_guard_753$;

CREATE OR REPLACE FUNCTION public.cath_authority_recovery_receipt_constraint_753()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $cath_authority_recovery_receipt_constraint_753$
DECLARE
  entity_type_value TEXT;
  recovery_id_text TEXT;
  recovery_actor_text TEXT;
  old_inventory_item_text TEXT;
  new_inventory_item_text TEXT;
  facility_changed BOOLEAN := FALSE;
  inventory_item_changed BOOLEAN := FALSE;
BEGIN
  IF TG_TABLE_NAME='cath_lab_cases' THEN
    entity_type_value := 'cath_lab_case';
    facility_changed := NEW.facility_id IS DISTINCT FROM OLD.facility_id;
  ELSIF TG_TABLE_NAME='cath_consumable_catalog' THEN
    entity_type_value := 'cath_consumable_catalog';
    facility_changed := NEW.facility_id IS DISTINCT FROM OLD.facility_id;
    inventory_item_changed := NEW.inventory_item_id IS DISTINCT FROM OLD.inventory_item_id;
    old_inventory_item_text := OLD.inventory_item_id::text;
    new_inventory_item_text := NEW.inventory_item_id::text;
  ELSE
    RAISE EXCEPTION 'Unsupported Cath recovery receipt target'
      USING ERRCODE='23514';
  END IF;
  IF NOT facility_changed AND NOT inventory_item_changed THEN RETURN NULL; END IF;

  recovery_id_text := NEW.metadata->'authority_recovery'->>'recovery_id';
  recovery_actor_text := NEW.metadata->'authority_recovery'->>'actor_uid';
  IF NEW.metadata->'authority_recovery'->>'action' IS DISTINCT FROM 'REATTACH'
     OR recovery_id_text !~ '^[1-9][0-9]*$'
     OR recovery_actor_text
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR NOT EXISTS (
       SELECT 1
         FROM public.pharmacy_inventory_authority_recovery_worklist recovery
         JOIN public.pharmacy_inventory_authority_recovery_events event
           ON event.tenant_id=recovery.tenant_id AND event.recovery_id=recovery.id
        WHERE recovery.tenant_id=NEW.tenant_id
          AND recovery.id::text=recovery_id_text
          AND recovery.entity_type=entity_type_value
          AND recovery.entity_id=NEW.id
          AND recovery.status='RESOLVED'
          AND recovery.resolved_by::text=recovery_actor_text
          AND event.event_type='RESOLVED'
          AND event.actor_uid=recovery.resolved_by
          AND event.command_key_sha256 ~ '^[0-9a-f]{64}$'
          AND event.request_sha256 ~ '^[0-9a-f]{64}$'
          AND event.target_identity->>'entity_type'=entity_type_value
          AND event.target_identity->>'entity_id'=NEW.id::text
          AND event.target_identity->>'governing_facility_id'=NEW.facility_id::text
          AND event.target_before->>'facility_id' IS NOT DISTINCT FROM OLD.facility_id::text
          AND event.target_after->>'facility_id' IS NOT DISTINCT FROM NEW.facility_id::text
          AND (
            entity_type_value<>'cath_consumable_catalog'
            OR (
              event.target_before->>'inventory_item_id'
                IS NOT DISTINCT FROM old_inventory_item_text
              AND event.target_after->>'inventory_item_id'
                IS NOT DISTINCT FROM new_inventory_item_text
              AND event.target_identity->>'inventory_item_id'
                IS NOT DISTINCT FROM new_inventory_item_text
            )
          )
     )
  THEN
    RAISE EXCEPTION 'Cath authority identity repair lacks its exact governed recovery receipt'
      USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$cath_authority_recovery_receipt_constraint_753$;

CREATE OR REPLACE FUNCTION public.cath_inventory_authority_assert_contract_753(
  target_tenant_id UUID,
  target_usage_id BIGINT
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $cath_inventory_authority_assert_contract_753$
DECLARE
  usage_record public.cath_case_consumable_usage%ROWTYPE;
  case_record public.cath_lab_cases%ROWTYPE;
  catalog_record public.cath_consumable_catalog%ROWTYPE;
  task_record public.tasks%ROWTYPE;
  sla_record public.workflow_sla_instances%ROWTYPE;
  outbox_record public.notification_outbox%ROWTYPE;
  movement_record public.pharmacy_stock_movements%ROWTYPE;
  movement_total NUMERIC := 0;
  final_movement_id INTEGER;
BEGIN
  SELECT usage.* INTO usage_record
    FROM public.cath_case_consumable_usage usage
   WHERE usage.tenant_id=target_tenant_id AND usage.id=target_usage_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cath inventory authority references a missing clinical usage'
      USING ERRCODE='23514';
  END IF;

  IF usage_record.inventory_decrement_status='not_applicable'
     AND usage_record.metadata->'authority_recovery'->>'action' IN ('PRESERVE','CANCEL')
  THEN
    IF usage_record.facility_id IS NOT NULL
       OR usage_record.inventory_item_id IS NOT NULL
       OR usage_record.inventory_batch_id IS NOT NULL
       OR usage_record.inventory_movement_id IS NOT NULL
       OR usage_record.metadata->'authority_recovery'->>'recovery_id' !~ '^[1-9][0-9]*$'
       OR usage_record.metadata->'authority_recovery'->>'actor_uid'
            !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       OR EXISTS (
         SELECT 1
           FROM public.pharmacy_stock_movements movement
          WHERE movement.tenant_id=usage_record.tenant_id
            AND (
              (movement.reference_type='cath_consumable_usage'
               AND movement.reference_id=usage_record.id::text)
              OR (movement.reference_type='cath_consumable_reconciliation'
               AND movement.metadata->>'cath_consumable_usage_id'=usage_record.id::text)
            )
       )
       OR NOT EXISTS (
         SELECT 1
          FROM public.pharmacy_inventory_authority_recovery_worklist recovery
           JOIN public.pharmacy_inventory_authority_recovery_events event
             ON event.tenant_id=recovery.tenant_id AND event.recovery_id=recovery.id
          WHERE recovery.tenant_id=usage_record.tenant_id
            AND recovery.id::text=usage_record.metadata->'authority_recovery'->>'recovery_id'
            AND recovery.entity_type='cath_consumable_usage'
            AND recovery.entity_id=usage_record.id
            AND recovery.status='RESOLVED'
            AND recovery.resolved_by::text=
                  usage_record.metadata->'authority_recovery'->>'actor_uid'
            AND event.event_type='RESOLVED'
            AND event.actor_uid=recovery.resolved_by
            AND event.command_key_sha256 ~ '^[0-9a-f]{64}$'
            AND event.request_sha256 ~ '^[0-9a-f]{64}$'
            AND event.target_identity->>'entity_type'='cath_consumable_usage'
            AND event.target_identity->>'entity_id'=usage_record.id::text
            AND event.target_after->>'inventory_decrement_status'='not_applicable'
            AND event.target_after->>'facility_id' IS NULL
            AND event.target_after->>'inventory_item_id' IS NULL
            AND event.target_after->>'inventory_batch_id' IS NULL
            AND event.target_after->'metadata'->'authority_recovery'->>'action'=
                  usage_record.metadata->'authority_recovery'->>'action'
       )
    THEN
      RAISE EXCEPTION 'Terminal Cath usage preservation lacks its governed recovery receipt'
        USING ERRCODE='23514';
    END IF;
    RETURN;
  END IF;

  SELECT cath_case.* INTO case_record
    FROM public.cath_lab_cases cath_case
   WHERE cath_case.tenant_id=usage_record.tenant_id
     AND cath_case.id=usage_record.case_id
     AND cath_case.patient_uid=usage_record.patient_uid
     AND cath_case.facility_id=usage_record.facility_id;
  SELECT catalog.* INTO catalog_record
    FROM public.cath_consumable_catalog catalog
   WHERE catalog.tenant_id=usage_record.tenant_id
     AND catalog.id=usage_record.catalog_item_id
     AND catalog.facility_id=usage_record.facility_id
     AND catalog.inventory_item_id=usage_record.inventory_item_id;
  IF case_record.id IS NULL OR catalog_record.id IS NULL
     OR usage_record.facility_id IS NULL
     OR usage_record.inventory_item_id IS NULL
     OR usage_record.inventory_batch_id IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.pharmacy_inventory_batches batch
        WHERE batch.tenant_id=usage_record.tenant_id
          AND batch.facility_id=usage_record.facility_id
          AND batch.id=usage_record.inventory_batch_id
          AND batch.inventory_item_id=usage_record.inventory_item_id
          AND batch.batch_number IS NOT DISTINCT FROM usage_record.batch_number
          AND batch.lot_number IS NOT DISTINCT FROM usage_record.lot_number
          AND batch.expiry_date IS NOT DISTINCT FROM usage_record.expiry_date
     )
  THEN
    RAISE EXCEPTION 'Cath usage is not bound to one exact case/catalog/batch facility authority'
      USING ERRCODE='23514';
  END IF;

  IF usage_record.timeline_event_id IS NULL
     OR usage_record.audit_event_id IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.clinical_timeline_events timeline
        WHERE timeline.tenant_id=usage_record.tenant_id
          AND timeline.id=usage_record.timeline_event_id
          AND timeline.patient_uid=usage_record.patient_uid
          AND timeline.encounter_id IS NOT DISTINCT FROM case_record.encounter_id
          AND timeline.source_table='cath_case_consumable_usage'
          AND timeline.source_id=usage_record.id::text
          AND timeline.resource_type='cath_case_consumable_usage'
          AND timeline.resource_id=usage_record.id::text
          AND timeline.actor_uid IS NOT DISTINCT FROM usage_record.used_by
          AND timeline.event_type=CASE WHEN usage_record.wasted
            THEN 'cath_lab.consumable_wasted' ELSE 'cath_lab.consumable_used' END
          AND timeline.payload->>'facility_id'=usage_record.facility_id::text
          AND timeline.payload->>'inventory_item_id'=usage_record.inventory_item_id::text
          AND timeline.payload->>'inventory_batch_id'=usage_record.inventory_batch_id::text
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.clinical_audit_events audit
        WHERE audit.tenant_id=usage_record.tenant_id
          AND audit.id=usage_record.audit_event_id
          AND audit.patient_uid IS NOT DISTINCT FROM usage_record.patient_uid
          AND audit.encounter_id IS NOT DISTINCT FROM case_record.encounter_id
          AND audit.resource_table='cath_case_consumable_usage'
          AND audit.resource_id=usage_record.id::text
          AND audit.actor_uid IS NOT DISTINCT FROM usage_record.used_by
          AND audit.action=CASE WHEN usage_record.wasted
            THEN 'cath_lab.consumable_wasted' ELSE 'cath_lab.consumable_used' END
     )
  THEN
    RAISE EXCEPTION 'Cath usage lacks exact immutable canonical clinical-event provenance'
      USING ERRCODE='23514';
  END IF;

  IF usage_record.metadata->'authority_recovery'->>'action'='REATTACH'
     AND NOT EXISTS (
       SELECT 1
         FROM public.pharmacy_inventory_authority_recovery_worklist recovery
         JOIN public.pharmacy_inventory_authority_recovery_events event
           ON event.tenant_id=recovery.tenant_id AND event.recovery_id=recovery.id
        WHERE recovery.tenant_id=usage_record.tenant_id
          AND recovery.id::text=usage_record.metadata->'authority_recovery'->>'recovery_id'
          AND recovery.entity_type='cath_consumable_usage'
          AND recovery.entity_id=usage_record.id
          AND recovery.status='RESOLVED'
          AND recovery.resolved_by::text=
                usage_record.metadata->'authority_recovery'->>'actor_uid'
          AND event.event_type='RESOLVED'
          AND event.actor_uid=recovery.resolved_by
          AND event.target_identity->>'entity_type'='cath_consumable_usage'
          AND event.target_identity->>'entity_id'=usage_record.id::text
          AND event.target_identity->>'governing_facility_id'=
                usage_record.facility_id::text
          AND event.target_identity->>'inventory_item_id'=
                usage_record.inventory_item_id::text
          AND event.target_identity->>'inventory_batch_id'=
                usage_record.inventory_batch_id::text
          AND event.target_after->>'facility_id'=usage_record.facility_id::text
          AND event.target_after->>'inventory_item_id'=usage_record.inventory_item_id::text
          AND event.target_after->>'inventory_batch_id'=usage_record.inventory_batch_id::text
     )
  THEN
    RAISE EXCEPTION 'Reattached Cath usage lacks its exact governed recovery receipt'
      USING ERRCODE='23514';
  END IF;

  SELECT task.* INTO task_record
    FROM public.tasks task
   WHERE task.tenant_id=usage_record.tenant_id
     AND task.related_resource_type='cath_case_consumable_usage'
     AND task.related_resource_id=usage_record.id::text
     AND task.metadata->>'task_contract'='cath_inventory_shortfall_v1';
  SELECT sla.* INTO sla_record
    FROM public.workflow_sla_instances sla
   WHERE sla.tenant_id=usage_record.tenant_id
     AND sla.rule_code='cath_consumable_inventory_reconciliation'
     AND sla.source_table='cath_case_consumable_usage'
     AND sla.source_id=usage_record.id::text;
  SELECT outbox.* INTO outbox_record
    FROM public.notification_outbox outbox
   WHERE outbox.tenant_id=usage_record.tenant_id
     AND outbox.type='cath_inventory_shortfall'
     AND outbox.source_event_key='cath-inventory-shortfall:' || usage_record.id::text;
  IF task_record.id IS NULL OR sla_record.id IS NULL OR outbox_record.id IS NULL
     OR task_record.patient_uid IS DISTINCT FROM usage_record.patient_uid
     OR task_record.workflow_sla_instance_id IS DISTINCT FROM sla_record.id
     OR task_record.metadata->>'cath_case_id' IS DISTINCT FROM usage_record.case_id::text
     OR task_record.metadata->>'facility_id' IS DISTINCT FROM usage_record.facility_id::text
     OR task_record.metadata->>'inventory_item_id'
          IS DISTINCT FROM usage_record.inventory_item_id::text
     OR task_record.metadata->>'inventory_batch_id'
          IS DISTINCT FROM usage_record.inventory_batch_id::text
     OR sla_record.patient_uid IS DISTINCT FROM usage_record.patient_uid
     OR sla_record.encounter_id IS DISTINCT FROM case_record.encounter_id
     OR sla_record.metadata->>'cath_case_id' IS DISTINCT FROM usage_record.case_id::text
     OR sla_record.metadata->>'inventory_facility_id'
          IS DISTINCT FROM usage_record.facility_id::text
     OR sla_record.metadata->>'inventory_item_id'
          IS DISTINCT FROM usage_record.inventory_item_id::text
     OR sla_record.metadata->>'inventory_batch_id'
          IS DISTINCT FROM usage_record.inventory_batch_id::text
     OR outbox_record.payload->>'cath_case_id' IS DISTINCT FROM usage_record.case_id::text
     OR outbox_record.payload->>'cath_consumable_usage_id'
          IS DISTINCT FROM usage_record.id::text
     OR outbox_record.payload->>'facility_id' IS DISTINCT FROM usage_record.facility_id::text
     OR outbox_record.payload->>'inventory_item_id'
          IS DISTINCT FROM usage_record.inventory_item_id::text
     OR outbox_record.payload->>'inventory_batch_id'
          IS DISTINCT FROM usage_record.inventory_batch_id::text
  THEN
    RAISE EXCEPTION 'Cath clinical usage and durable pharmacy worklist identities diverged'
      USING ERRCODE='23514';
  END IF;

  IF outbox_record.payload->>'delivery_coverage'='direct' AND (
    outbox_record.payload->>'recipient_facility_grant_id' !~ '^[1-9][0-9]*$'
    OR NOT EXISTS (
      SELECT 1
        FROM public.pharmacy_staff_facility_grants facility_grant
        JOIN public.users recipient
          ON recipient.tenant_id=facility_grant.tenant_id
         AND recipient.uid=facility_grant.staff_uid
        JOIN public.staff recipient_staff
          ON recipient_staff.tenant_id=recipient.tenant_id
         AND recipient_staff.user_id=recipient.uid
       WHERE facility_grant.tenant_id=usage_record.tenant_id
         AND facility_grant.id::text=outbox_record.payload->>'recipient_facility_grant_id'
         AND facility_grant.facility_id=usage_record.facility_id
         AND facility_grant.staff_uid::text=outbox_record.payload->>'recipient_uid'
         AND recipient.id::text=outbox_record.recipient_id
         AND outbox_record.payload->>'recipient_status_snapshot'='active'
         AND outbox_record.payload->>'recipient_not_deleted_snapshot'='true'
         AND facility_grant.granted_at <= outbox_record.created_at
         AND (facility_grant.revoked_at IS NULL
              OR facility_grant.revoked_at >= outbox_record.created_at)
    )
  ) THEN
    RAISE EXCEPTION 'Cath inventory notification lacks exact facility-grant provenance'
      USING ERRCODE='23514';
  END IF;

  FOR movement_record IN
    SELECT movement.* FROM public.pharmacy_stock_movements movement
     WHERE movement.tenant_id=usage_record.tenant_id
       AND (
         (movement.reference_type='cath_consumable_usage'
          AND movement.reference_id=usage_record.id::text)
         OR (movement.reference_type='cath_consumable_reconciliation'
          AND movement.metadata->>'cath_consumable_usage_id'=usage_record.id::text)
       )
  LOOP
    IF movement_record.inventory_item_id IS DISTINCT FROM usage_record.inventory_item_id
       OR movement_record.inventory_batch_id IS DISTINCT FROM usage_record.inventory_batch_id
       OR movement_record.movement_kind IS DISTINCT FROM
            (CASE WHEN usage_record.wasted THEN 'dispose' ELSE 'issue' END)
       OR movement_record.quantity_delta >= 0
       OR movement_record.performed_by::text
            IS DISTINCT FROM movement_record.metadata->>'canonical_actor_uid'
       OR movement_record.metadata->>'facility_id' IS DISTINCT FROM usage_record.facility_id::text
       OR movement_record.metadata->>'actor_facility_grant_id' !~ '^[1-9][0-9]*$'
       OR NOT EXISTS (
         SELECT 1
           FROM public.pharmacy_staff_facility_grants facility_grant
          WHERE facility_grant.tenant_id=movement_record.tenant_id
            AND facility_grant.id::text=movement_record.metadata->>'actor_facility_grant_id'
            AND facility_grant.staff_uid=movement_record.performed_by
            AND facility_grant.facility_id=usage_record.facility_id
            AND facility_grant.granted_at <= movement_record.created_at
            AND (facility_grant.revoked_at IS NULL
                 OR facility_grant.revoked_at >= movement_record.created_at)
       )
       OR NOT EXISTS (
         SELECT 1 FROM public.pharmacy_inventory_batches batch
          WHERE batch.tenant_id=movement_record.tenant_id
            AND batch.facility_id=usage_record.facility_id
            AND batch.id=movement_record.inventory_batch_id
            AND batch.inventory_item_id=movement_record.inventory_item_id
       )
    THEN
      RAISE EXCEPTION 'Cath stock movement lacks exact batch/facility/grant provenance'
        USING ERRCODE='23514';
    END IF;
  END LOOP;

  SELECT COALESCE(SUM(-movement.quantity_delta), 0::numeric),
         (ARRAY_AGG(movement.id ORDER BY movement.created_at DESC, movement.id DESC)
           FILTER (WHERE movement.id IS NOT NULL))[1]
    INTO movement_total, final_movement_id
    FROM public.pharmacy_stock_movements movement
   WHERE movement.tenant_id=usage_record.tenant_id
     AND (
       (movement.reference_type='cath_consumable_usage'
        AND movement.reference_id=usage_record.id::text)
       OR (movement.reference_type='cath_consumable_reconciliation'
        AND movement.metadata->>'cath_consumable_usage_id'=usage_record.id::text)
     );
  IF movement_total > usage_record.quantity
     OR usage_record.inventory_movement_id IS DISTINCT FROM final_movement_id
     OR (
       usage_record.inventory_decrement_status='decremented'
       AND movement_total IS DISTINCT FROM usage_record.quantity
     )
     OR (
       usage_record.inventory_decrement_status<>'decremented'
       AND movement_total >= usage_record.quantity
     )
  THEN
    RAISE EXCEPTION 'Cath usage inventory outcome diverges from append-only movement evidence'
      USING ERRCODE='23514';
  END IF;
END;
$cath_inventory_authority_assert_contract_753$;

CREATE OR REPLACE FUNCTION public.cath_inventory_authority_constraint_753()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $cath_inventory_authority_constraint_753$
DECLARE
  tenant_value UUID;
  usage_id_text TEXT;
  relevant BOOLEAN := FALSE;
BEGIN
  tenant_value := COALESCE(NEW.tenant_id, OLD.tenant_id);
  IF TG_TABLE_NAME='cath_case_consumable_usage' THEN
    relevant := TRUE;
    usage_id_text := COALESCE(NEW.id, OLD.id)::text;
  ELSIF TG_TABLE_NAME='tasks' THEN
    relevant := COALESCE(NEW.metadata->>'task_contract','')='cath_inventory_shortfall_v1'
      OR COALESCE(OLD.metadata->>'task_contract','')='cath_inventory_shortfall_v1';
    usage_id_text := COALESCE(
      NEW.metadata->>'cath_consumable_usage_id',
      OLD.metadata->>'cath_consumable_usage_id'
    );
  ELSIF TG_TABLE_NAME='workflow_sla_instances' THEN
    relevant := COALESCE(NEW.rule_code,'')='cath_consumable_inventory_reconciliation'
      OR COALESCE(OLD.rule_code,'')='cath_consumable_inventory_reconciliation';
    usage_id_text := COALESCE(NEW.source_id, OLD.source_id);
  ELSIF TG_TABLE_NAME='notification_outbox' THEN
    relevant := COALESCE(NEW.type,'')='cath_inventory_shortfall'
      OR COALESCE(OLD.type,'')='cath_inventory_shortfall';
    usage_id_text := COALESCE(
      NEW.payload->>'cath_consumable_usage_id',
      OLD.payload->>'cath_consumable_usage_id'
    );
  ELSE
    relevant := COALESCE(NEW.reference_type,'') IN (
      'cath_consumable_usage','cath_consumable_reconciliation'
    ) OR COALESCE(OLD.reference_type,'') IN (
      'cath_consumable_usage','cath_consumable_reconciliation'
    );
    usage_id_text := COALESCE(
      CASE WHEN NEW.reference_type='cath_consumable_usage' THEN NEW.reference_id
           ELSE NEW.metadata->>'cath_consumable_usage_id' END,
      CASE WHEN OLD.reference_type='cath_consumable_usage' THEN OLD.reference_id
           ELSE OLD.metadata->>'cath_consumable_usage_id' END
    );
  END IF;
  IF relevant IS NOT TRUE THEN RETURN NULL; END IF;
  IF usage_id_text !~ '^[1-9][0-9]*$' THEN
    RAISE EXCEPTION 'Cath authority evidence has an invalid usage identity'
      USING ERRCODE='23514';
  END IF;
  PERFORM public.cath_inventory_authority_assert_contract_753(
    tenant_value, usage_id_text::bigint
  );
  RETURN NULL;
END;
$cath_inventory_authority_constraint_753$;

DROP TRIGGER IF EXISTS trg_cath_case_authority_identity_753 ON public.cath_lab_cases;
CREATE TRIGGER trg_cath_case_authority_identity_753
  BEFORE UPDATE OR DELETE ON public.cath_lab_cases
  FOR EACH ROW EXECUTE FUNCTION public.cath_authority_identity_guard_753();
DROP TRIGGER IF EXISTS trg_cath_catalog_authority_identity_753 ON public.cath_consumable_catalog;
CREATE TRIGGER trg_cath_catalog_authority_identity_753
  BEFORE UPDATE OR DELETE ON public.cath_consumable_catalog
  FOR EACH ROW EXECUTE FUNCTION public.cath_authority_identity_guard_753();
DROP TRIGGER IF EXISTS trg_cath_usage_authority_identity_753 ON public.cath_case_consumable_usage;
CREATE TRIGGER trg_cath_usage_authority_identity_753
  BEFORE UPDATE OR DELETE ON public.cath_case_consumable_usage
  FOR EACH ROW EXECUTE FUNCTION public.cath_authority_identity_guard_753();
DROP TRIGGER IF EXISTS trg_cath_task_authority_identity_753 ON public.tasks;
CREATE TRIGGER trg_cath_task_authority_identity_753
  BEFORE UPDATE OR DELETE ON public.tasks
  FOR EACH ROW WHEN (
    OLD.metadata->>'task_contract'='cath_inventory_shortfall_v1'
  ) EXECUTE FUNCTION public.cath_authority_identity_guard_753();
DROP TRIGGER IF EXISTS trg_cath_sla_authority_identity_753 ON public.workflow_sla_instances;
CREATE TRIGGER trg_cath_sla_authority_identity_753
  BEFORE UPDATE OR DELETE ON public.workflow_sla_instances
  FOR EACH ROW WHEN (
    OLD.rule_code='cath_consumable_inventory_reconciliation'
  ) EXECUTE FUNCTION public.cath_authority_identity_guard_753();
DROP TRIGGER IF EXISTS trg_cath_outbox_authority_identity_753 ON public.notification_outbox;
CREATE TRIGGER trg_cath_outbox_authority_identity_753
  BEFORE UPDATE OR DELETE ON public.notification_outbox
  FOR EACH ROW WHEN (
    OLD.type='cath_inventory_shortfall'
  ) EXECUTE FUNCTION public.cath_authority_identity_guard_753();
DROP TRIGGER IF EXISTS trg_cath_movement_authority_identity_753 ON public.pharmacy_stock_movements;
CREATE TRIGGER trg_cath_movement_authority_identity_753
  BEFORE UPDATE OR DELETE ON public.pharmacy_stock_movements
  FOR EACH ROW WHEN (
    OLD.reference_type IN ('cath_consumable_usage','cath_consumable_reconciliation')
  ) EXECUTE FUNCTION public.cath_authority_identity_guard_753();

DROP TRIGGER IF EXISTS trg_cath_usage_authority_contract_753 ON public.cath_case_consumable_usage;
CREATE CONSTRAINT TRIGGER trg_cath_usage_authority_contract_753
  AFTER INSERT OR UPDATE OR DELETE ON public.cath_case_consumable_usage
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION public.cath_inventory_authority_constraint_753();
DROP TRIGGER IF EXISTS trg_cath_task_authority_contract_753 ON public.tasks;
CREATE CONSTRAINT TRIGGER trg_cath_task_authority_contract_753
  AFTER INSERT OR UPDATE OR DELETE ON public.tasks
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION public.cath_inventory_authority_constraint_753();
DROP TRIGGER IF EXISTS trg_cath_sla_authority_contract_753 ON public.workflow_sla_instances;
CREATE CONSTRAINT TRIGGER trg_cath_sla_authority_contract_753
  AFTER INSERT OR UPDATE OR DELETE ON public.workflow_sla_instances
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION public.cath_inventory_authority_constraint_753();
DROP TRIGGER IF EXISTS trg_cath_outbox_authority_contract_753 ON public.notification_outbox;
CREATE CONSTRAINT TRIGGER trg_cath_outbox_authority_contract_753
  AFTER INSERT OR UPDATE OR DELETE ON public.notification_outbox
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION public.cath_inventory_authority_constraint_753();
DROP TRIGGER IF EXISTS trg_cath_movement_authority_contract_753 ON public.pharmacy_stock_movements;
CREATE CONSTRAINT TRIGGER trg_cath_movement_authority_contract_753
  AFTER INSERT OR UPDATE OR DELETE ON public.pharmacy_stock_movements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION public.cath_inventory_authority_constraint_753();
DROP TRIGGER IF EXISTS trg_cath_case_recovery_receipt_753 ON public.cath_lab_cases;
CREATE CONSTRAINT TRIGGER trg_cath_case_recovery_receipt_753
  AFTER UPDATE ON public.cath_lab_cases
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION public.cath_authority_recovery_receipt_constraint_753();
DROP TRIGGER IF EXISTS trg_cath_catalog_recovery_receipt_753 ON public.cath_consumable_catalog;
CREATE CONSTRAINT TRIGGER trg_cath_catalog_recovery_receipt_753
  AFTER UPDATE ON public.cath_consumable_catalog
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION public.cath_authority_recovery_receipt_constraint_753();

REVOKE ALL PRIVILEGES ON FUNCTION public.cath_authority_identity_guard_753()
  FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.cath_authority_recovery_receipt_constraint_753()
  FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  public.cath_inventory_authority_assert_contract_753(UUID, BIGINT) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.cath_inventory_authority_constraint_753()
  FROM PUBLIC;

DO $cath_inventory_authority_runtime_privileges_753$
DECLARE
  runtime_role TEXT;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['vhhealth_app','vhhealth_runtime']::TEXT[]
  LOOP
    IF pg_catalog.to_regrole(runtime_role) IS NULL THEN CONTINUE; END IF;
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.cath_inventory_authority_assert_contract_753(UUID, BIGINT) FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION public.cath_inventory_authority_assert_contract_753(UUID, BIGINT) TO %I',
      runtime_role
    );
  END LOOP;
END;
$cath_inventory_authority_runtime_privileges_753$;

COMMENT ON FUNCTION public.cath_inventory_authority_assert_contract_753(UUID, BIGINT) IS
  'Deferred exact Cath case/catalog/batch, canonical event, facility grant, task, SLA, outbox, and movement authority binding.';

CREATE OR REPLACE FUNCTION public.pharmacy_funding_duplicate_line_snapshot_753(
  p_tenant_id UUID,
  p_pharmacy_order_id INTEGER
)
RETURNS TABLE (snapshot JSONB, snapshot_sha256 CHAR(64), active_line_count INTEGER)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  WITH authority AS (
    SELECT pharmacy_order.id,pharmacy_order.facility_id,
           pharmacy_order.inventory_authority_version,
           pharmacy_order.funding_admission_id,
           pharmacy_order.funding_admission_order_version,
           pharmacy_order.funding_admission_items_sha256,
           encode(public.digest(COALESCE(pharmacy_order.items_list,'[]'::jsonb)::text,'sha256'),'hex')
             AS order_items_storage_sha256,
           COALESCE((
             SELECT jsonb_agg(
               jsonb_build_object(
                 'movement_id',movement.id,
                 'movement_kind',movement.movement_kind,
                 'quantity_delta',movement.quantity_delta,
                 'reference_type',movement.reference_type,
                 'reference_id',movement.reference_id,
                 'contract',movement.metadata->>'contract',
                 'command_key_sha256',movement.metadata->>'command_key_sha256'
               ) ORDER BY movement.id
             )
             FROM pharmacy_stock_movements movement
            WHERE movement.tenant_id=pharmacy_order.tenant_id
              AND movement.metadata->>'order_id'=pharmacy_order.id::text
           ),'[]'::jsonb) AS stock_evidence
      FROM pharmacy_orders pharmacy_order
     WHERE pharmacy_order.tenant_id=p_tenant_id
       AND pharmacy_order.id=p_pharmacy_order_id
  ), line_evidence AS (
    SELECT item.id AS invoice_item_id,item.invoice_id,invoice.status AS invoice_status,
           invoice.patient_uid,invoice.admission_id,
           invoice.subtotal AS invoice_subtotal,
           invoice.cgst_amount AS invoice_cgst_amount,
           invoice.sgst_amount AS invoice_sgst_amount,
           invoice.igst_amount AS invoice_igst_amount,
           invoice.total_amount AS invoice_total_amount,
           invoice.amount_paid AS invoice_amount_paid,invoice.amount_due AS invoice_amount_due,
           item.description,item.category,item.quantity,item.unit_price,item.line_subtotal,
           item.cgst_amount,item.sgst_amount,item.igst_amount,item.line_total,item.source_ref_active,
           item.source_authority_version,item.source_authority_sha256,
           encode(public.digest(jsonb_build_object(
             'invoice_item_id',item.id,'invoice_id',item.invoice_id,
             'description',item.description,'category',item.category,
             'quantity',item.quantity,'unit_price',item.unit_price,
             'line_subtotal',item.line_subtotal,'cgst_amount',item.cgst_amount,
             'sgst_amount',item.sgst_amount,'igst_amount',item.igst_amount,
             'line_total',item.line_total,'source_ref_active',item.source_ref_active,
             'source_authority_version',item.source_authority_version,
             'source_authority_sha256',item.source_authority_sha256
           )::text,'sha256'),'hex') AS invoice_item_sha256,
           COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
               'payment_id',payment.id,'amount',payment.amount,'mode',payment.mode,
               'reference',payment.reference,'reversed',payment.reversed
             ) ORDER BY payment.id)
               FROM billing_payments payment
              WHERE payment.tenant_id=item.tenant_id
                AND payment.invoice_id=item.invoice_id
           ),'[]'::jsonb) AS payments,
           COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
               'allocation_id',allocation.id,
               'billing_payment_id',allocation.billing_payment_id,
               'allocated_amount',allocation.allocated_amount,
               'source_authority_version',allocation.source_authority_version,
               'source_authority_sha256',allocation.source_authority_sha256,
               'reversed_amount',COALESCE(reversal.reversed_amount,0)
             ) ORDER BY allocation.id)
               FROM pharmacy_payment_allocations allocation
               LEFT JOIN (
                 SELECT tenant_id,allocation_id,SUM(reversed_amount) AS reversed_amount
                   FROM pharmacy_payment_allocation_reversals
                  GROUP BY tenant_id,allocation_id
               ) reversal
                 ON reversal.tenant_id=allocation.tenant_id
                AND reversal.allocation_id=allocation.id
              WHERE allocation.tenant_id=item.tenant_id
                AND allocation.invoice_item_id=item.id
           ),'[]'::jsonb) AS allocations,
           COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
               'decision_id',decision.id,'claim_id',decision.claim_id,
               'approved_amount',decision.approved_amount,
               'non_payable_amount',decision.non_payable_amount,
               'source_authority_version',decision.source_authority_version,
               'source_authority_sha256',decision.source_authority_sha256,
               'invalidated_at',decision.invalidated_at
             ) ORDER BY decision.id)
               FROM tpa_claim_line_decisions decision
              WHERE decision.tenant_id=item.tenant_id
                AND decision.invoice_item_id=item.id
           ),'[]'::jsonb) AS tpa_decisions
      FROM billing_invoice_items item
      JOIN billing_invoices invoice
        ON invoice.tenant_id=item.tenant_id AND invoice.id=item.invoice_id
     WHERE item.tenant_id=p_tenant_id
       AND item.source_ref_type='pharmacy_order'
       AND item.source_ref_id=p_pharmacy_order_id
  ), evidence AS (
    SELECT jsonb_build_object(
      'contract','pharmacy_funding_duplicate_line_snapshot_v1',
      'tenant_id',p_tenant_id,
      'pharmacy_order_id',p_pharmacy_order_id,
      'facility_id',authority.facility_id,
      'order_version',authority.inventory_authority_version,
      'funding_admission_id',authority.funding_admission_id,
      'funding_admission_order_version',authority.funding_admission_order_version,
      'funding_admission_items_sha256',authority.funding_admission_items_sha256,
      'order_items_storage_sha256',authority.order_items_storage_sha256,
      'stock_evidence',authority.stock_evidence,
      'lines',COALESCE(jsonb_agg(to_jsonb(line_evidence) ORDER BY line_evidence.invoice_item_id)
                       FILTER (WHERE line_evidence.invoice_item_id IS NOT NULL),'[]'::jsonb)
    ) AS body,
    COUNT(line_evidence.invoice_item_id) FILTER (WHERE line_evidence.source_ref_active)::integer
      AS line_count
      FROM authority
      LEFT JOIN line_evidence ON TRUE
     GROUP BY authority.facility_id,authority.inventory_authority_version,
              authority.funding_admission_id,authority.funding_admission_order_version,
              authority.funding_admission_items_sha256,authority.order_items_storage_sha256,
              authority.stock_evidence
  )
  SELECT evidence.body,
         encode(public.digest(evidence.body::text,'sha256'),'hex')::char(64),
         evidence.line_count
    FROM evidence;
$$;

CREATE TABLE IF NOT EXISTS pharmacy_funding_reconciliation_cases (
  id                    BIGSERIAL PRIMARY KEY,
  tenant_id             UUID NOT NULL,
  facility_id           INTEGER,
  patient_uid           UUID NOT NULL,
  pharmacy_order_id     INTEGER NOT NULL,
  task_id               INTEGER NOT NULL,
  task_resource_type    VARCHAR(60) NOT NULL DEFAULT 'pharmacy_funding_reconciliation',
  task_resource_id      VARCHAR(120) NOT NULL,
  status                VARCHAR(24) NOT NULL DEFAULT 'OPEN',
  snapshot_sha256       CHAR(64) NOT NULL,
  snapshot              JSONB NOT NULL,
  resolution_path       VARCHAR(40),
  keeper_invoice_item_id INTEGER,
  proposal_sha256       CHAR(64),
  proposed_by           UUID,
  proposed_at           TIMESTAMPTZ,
  approved_by           UUID,
  resolved_at           TIMESTAMPTZ,
  outcome               JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_pharmacy_funding_reconciliation_status_753 CHECK (
    status IN ('OPEN','PENDING_APPROVAL','BLOCKED','RESOLVED')
  ),
  CONSTRAINT chk_pharmacy_funding_reconciliation_task_753 CHECK (
    task_resource_type='pharmacy_funding_reconciliation'
    AND task_resource_id=pharmacy_order_id::text
  ),
  CONSTRAINT chk_pharmacy_funding_reconciliation_hashes_753 CHECK (
    snapshot_sha256 ~ '^[0-9a-f]{64}$'
    AND (proposal_sha256 IS NULL OR proposal_sha256 ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT chk_pharmacy_funding_reconciliation_dual_control_753 CHECK (
    approved_by IS NULL OR (proposed_by IS NOT NULL AND approved_by<>proposed_by)
  ),
  CONSTRAINT chk_pharmacy_funding_reconciliation_state_shape_753 CHECK (
    (status='OPEN'
      AND resolution_path IS NULL AND keeper_invoice_item_id IS NULL
      AND proposal_sha256 IS NULL AND proposed_by IS NULL AND proposed_at IS NULL
      AND approved_by IS NULL AND resolved_at IS NULL AND outcome IS NULL)
    OR
    (status='PENDING_APPROVAL'
      AND resolution_path IS NOT NULL AND keeper_invoice_item_id IS NOT NULL
      AND proposal_sha256 IS NOT NULL AND proposed_by IS NOT NULL AND proposed_at IS NOT NULL
      AND approved_by IS NULL AND resolved_at IS NULL AND outcome IS NULL)
    OR
    (status='BLOCKED'
      AND resolution_path IS NOT NULL AND keeper_invoice_item_id IS NOT NULL
      AND proposal_sha256 IS NOT NULL AND proposed_by IS NOT NULL AND proposed_at IS NOT NULL
      AND approved_by IS NULL AND resolved_at IS NULL AND outcome IS NOT NULL)
    OR
    (status='RESOLVED'
      AND resolution_path IS NOT NULL AND keeper_invoice_item_id IS NOT NULL
      AND proposal_sha256 IS NOT NULL AND proposed_by IS NOT NULL AND proposed_at IS NOT NULL
      AND approved_by IS NOT NULL AND approved_by<>proposed_by
      AND resolved_at IS NOT NULL AND outcome IS NOT NULL)
  ),
  CONSTRAINT fk_pharmacy_funding_reconciliation_order_753
    FOREIGN KEY (tenant_id,pharmacy_order_id)
    REFERENCES pharmacy_orders (tenant_id,id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pharmacy_funding_reconciliation_patient_753
    FOREIGN KEY (tenant_id,patient_uid)
    REFERENCES users (tenant_id,uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_pharmacy_funding_reconciliation_facility_753
    FOREIGN KEY (tenant_id,facility_id)
    REFERENCES facilities (tenant_id,id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pharmacy_funding_reconciliation_task_753
    FOREIGN KEY (tenant_id,task_id,task_resource_type,task_resource_id)
    REFERENCES tasks (tenant_id,id,related_resource_type,related_resource_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pharmacy_funding_reconciliation_proposer_753
    FOREIGN KEY (tenant_id,proposed_by) REFERENCES users (tenant_id,uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pharmacy_funding_reconciliation_approver_753
    FOREIGN KEY (tenant_id,approved_by) REFERENCES users (tenant_id,uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_funding_reconciliation_order_753
  ON pharmacy_funding_reconciliation_cases (tenant_id,pharmacy_order_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_funding_reconciliation_tenant_id_753
  ON pharmacy_funding_reconciliation_cases (tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_funding_reconciliation_case_identity_753
  ON pharmacy_funding_reconciliation_cases (tenant_id,id,pharmacy_order_id);
CREATE INDEX IF NOT EXISTS idx_pharmacy_funding_reconciliation_worklist_753
  ON pharmacy_funding_reconciliation_cases (tenant_id,status,created_at,id);

CREATE TABLE IF NOT EXISTS pharmacy_funding_reconciliation_events (
  id                    BIGSERIAL PRIMARY KEY,
  tenant_id             UUID NOT NULL,
  case_id               BIGINT NOT NULL,
  pharmacy_order_id     INTEGER NOT NULL,
  event_type            VARCHAR(24) NOT NULL,
  snapshot_sha256       CHAR(64) NOT NULL,
  proposal_sha256       CHAR(64),
  command_key_sha256    CHAR(64) NOT NULL,
  request_sha256        CHAR(64) NOT NULL,
  actor_uid             UUID,
  evidence              JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_pharmacy_funding_reconciliation_event_type_753 CHECK (
    event_type IN ('DETECTED','PROPOSED','BLOCKED','APPROVED','RESOLVED')
  ),
  CONSTRAINT chk_pharmacy_funding_reconciliation_event_hashes_753 CHECK (
    snapshot_sha256 ~ '^[0-9a-f]{64}$'
    AND command_key_sha256 ~ '^[0-9a-f]{64}$'
    AND request_sha256 ~ '^[0-9a-f]{64}$'
    AND (proposal_sha256 IS NULL OR proposal_sha256 ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT fk_pharmacy_funding_reconciliation_event_case_753
    FOREIGN KEY (tenant_id,case_id,pharmacy_order_id)
    REFERENCES pharmacy_funding_reconciliation_cases (tenant_id,id,pharmacy_order_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pharmacy_funding_reconciliation_event_actor_753
    FOREIGN KEY (tenant_id,actor_uid) REFERENCES users (tenant_id,uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_funding_reconciliation_event_command_753
  ON pharmacy_funding_reconciliation_events (tenant_id,command_key_sha256);
CREATE INDEX IF NOT EXISTS idx_pharmacy_funding_reconciliation_event_stream_753
  ON pharmacy_funding_reconciliation_events (tenant_id,case_id,recorded_at,id);

ALTER TABLE billing_invoice_items
  ADD COLUMN IF NOT EXISTS source_ref_reconciliation_case_id BIGINT,
  ADD COLUMN IF NOT EXISTS source_ref_deactivated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS source_ref_deactivated_by UUID;

ALTER TABLE billing_invoice_items
  ADD CONSTRAINT fk_billing_item_reconciliation_case_753
    FOREIGN KEY (tenant_id,source_ref_reconciliation_case_id)
    REFERENCES pharmacy_funding_reconciliation_cases (tenant_id,id)
    ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT fk_billing_item_reconciliation_actor_753
    FOREIGN KEY (tenant_id,source_ref_deactivated_by)
    REFERENCES users (tenant_id,uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID;

INSERT INTO tasks (
  tenant_id,task_kind,title,description,patient_uid,related_resource_type,
  related_resource_id,priority,status,assigned_to_role,metadata
)
SELECT duplicate.tenant_id,'pharmacy_funding_reconciliation',
       'Reconcile duplicate pharmacy billing authority',
       'Two distinct finance owners must resolve the exact duplicate draft-line evidence.',
       duplicate.patient_uid,'pharmacy_funding_reconciliation',duplicate.pharmacy_order_id::text,
       'high','open','FINANCE_INCHARGE',
       jsonb_build_object(
         'contract','pharmacy_funding_reconciliation_task_v1',
         'pharmacy_order_id',duplicate.pharmacy_order_id,
         'snapshot_sha256',duplicate.snapshot_sha256,
         'active_line_count',duplicate.active_line_count,
         'resolution_paths',jsonb_build_array(
           'SAFE_DEACTIVATE_DUPLICATES','KEEP_CURRENT_AUTHORITY','CANCEL_ORDER','REBILL'
         )
       )
  FROM (
    SELECT pharmacy_order.tenant_id,pharmacy_order.id AS pharmacy_order_id,
           patient.uid AS patient_uid,snapshot.snapshot_sha256,snapshot.active_line_count
      FROM pharmacy_orders pharmacy_order
      JOIN users patient
        ON patient.tenant_id=pharmacy_order.tenant_id AND patient.id=pharmacy_order.patient_id
      CROSS JOIN LATERAL public.pharmacy_funding_duplicate_line_snapshot_753(
        pharmacy_order.tenant_id,pharmacy_order.id
      ) snapshot
     WHERE snapshot.active_line_count > 1
  ) duplicate
 WHERE NOT EXISTS (
   SELECT 1 FROM tasks existing
    WHERE existing.tenant_id=duplicate.tenant_id
      AND existing.related_resource_type='pharmacy_funding_reconciliation'
      AND existing.related_resource_id=duplicate.pharmacy_order_id::text
      AND existing.status IN ('open','in_progress','blocked','overdue')
 );

INSERT INTO pharmacy_funding_reconciliation_cases (
  tenant_id,facility_id,patient_uid,pharmacy_order_id,task_id,
  task_resource_type,task_resource_id,snapshot_sha256,snapshot
)
SELECT pharmacy_order.tenant_id,pharmacy_order.facility_id,patient.uid,
       pharmacy_order.id,task.id,'pharmacy_funding_reconciliation',
       pharmacy_order.id::text,snapshot.snapshot_sha256,snapshot.snapshot
  FROM pharmacy_orders pharmacy_order
  JOIN users patient
    ON patient.tenant_id=pharmacy_order.tenant_id AND patient.id=pharmacy_order.patient_id
  CROSS JOIN LATERAL public.pharmacy_funding_duplicate_line_snapshot_753(
    pharmacy_order.tenant_id,pharmacy_order.id
  ) snapshot
  JOIN tasks task
    ON task.tenant_id=pharmacy_order.tenant_id
   AND task.related_resource_type='pharmacy_funding_reconciliation'
   AND task.related_resource_id=pharmacy_order.id::text
   AND task.status IN ('open','in_progress','blocked','overdue')
 WHERE snapshot.active_line_count > 1
ON CONFLICT (tenant_id,pharmacy_order_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.enforce_pharmacy_funding_reconciliation_case_753()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'pharmacy funding reconciliation cases cannot be deleted'
      USING ERRCODE='55000';
  END IF;
  IF NEW.id<>OLD.id
     OR NEW.tenant_id<>OLD.tenant_id
     OR NEW.facility_id IS DISTINCT FROM OLD.facility_id
     OR NEW.patient_uid<>OLD.patient_uid
     OR NEW.pharmacy_order_id<>OLD.pharmacy_order_id
     OR NEW.task_id<>OLD.task_id
     OR NEW.task_resource_type<>OLD.task_resource_type
     OR NEW.task_resource_id<>OLD.task_resource_id
     OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'pharmacy funding reconciliation case identity and snapshot are immutable'
      USING ERRCODE='55000';
  END IF;
  IF OLD.status='RESOLVED' THEN
    RAISE EXCEPTION 'resolved pharmacy funding reconciliation cases are immutable'
      USING ERRCODE='55000';
  END IF;
  IF (NEW.snapshot_sha256<>OLD.snapshot_sha256 OR NEW.snapshot<>OLD.snapshot)
     AND NOT (OLD.status IN ('OPEN','BLOCKED') AND NEW.status='PENDING_APPROVAL') THEN
    RAISE EXCEPTION 'reconciliation snapshot may only rebase with a new governed proposal'
      USING ERRCODE='55000';
  END IF;
  IF (OLD.status IN ('OPEN','BLOCKED') AND NEW.status='PENDING_APPROVAL')
     OR (OLD.status='PENDING_APPROVAL' AND NEW.status IN ('BLOCKED','RESOLVED')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'illegal pharmacy funding reconciliation case transition'
    USING ERRCODE='55000';
END;
$$;

DROP TRIGGER IF EXISTS trg_pharmacy_funding_reconciliation_cases_state_753
  ON pharmacy_funding_reconciliation_cases;
CREATE TRIGGER trg_pharmacy_funding_reconciliation_cases_state_753
BEFORE UPDATE OR DELETE ON pharmacy_funding_reconciliation_cases
FOR EACH ROW EXECUTE FUNCTION public.enforce_pharmacy_funding_reconciliation_case_753();

INSERT INTO pharmacy_funding_reconciliation_events (
  tenant_id,case_id,pharmacy_order_id,event_type,snapshot_sha256,
  command_key_sha256,request_sha256,evidence
)
SELECT reconciliation.tenant_id,reconciliation.id,reconciliation.pharmacy_order_id,
       'DETECTED',reconciliation.snapshot_sha256,
       encode(public.digest(
         ('pharmacy-funding-reconciliation-detected:' || reconciliation.tenant_id::text
          || ':' || reconciliation.pharmacy_order_id::text || ':'
          || reconciliation.snapshot_sha256)::text,'sha256'
       ),'hex'),
       reconciliation.snapshot_sha256,
       jsonb_build_object(
         'contract','pharmacy_funding_reconciliation_detected_v1',
         'task_id',reconciliation.task_id,
         'snapshot',reconciliation.snapshot
       )
  FROM pharmacy_funding_reconciliation_cases reconciliation
ON CONFLICT (tenant_id,command_key_sha256) DO NOTHING;

CREATE OR REPLACE FUNCTION public.prevent_pharmacy_funding_reconciliation_event_mutation_753()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'pharmacy funding reconciliation events are append-only'
    USING ERRCODE='55000';
END;
$$;

CREATE TRIGGER trg_pharmacy_funding_reconciliation_events_append_only_753
BEFORE UPDATE OR DELETE ON pharmacy_funding_reconciliation_events
FOR EACH ROW EXECUTE FUNCTION public.prevent_pharmacy_funding_reconciliation_event_mutation_753();

ALTER TABLE pharmacy_funding_reconciliation_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_funding_reconciliation_cases FORCE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_funding_reconciliation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_funding_reconciliation_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation
  ON pharmacy_funding_reconciliation_cases
  AS PERMISSIVE
  USING (
    current_setting('app.current_tenant_id', TRUE) IS NULL
    OR current_setting('app.current_tenant_id', TRUE) = ''
    OR current_setting('app.current_tenant_id', TRUE) = 'bypass'
    OR tenant_id = public.app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', TRUE) IS NULL
    OR current_setting('app.current_tenant_id', TRUE) = ''
    OR current_setting('app.current_tenant_id', TRUE) = 'bypass'
    OR tenant_id = public.app_current_tenant_id_uuid()
  );
CREATE POLICY pharmacy_funding_reconciliation_cases_tenant_restrictive
  ON pharmacy_funding_reconciliation_cases AS RESTRICTIVE
  USING (
    current_setting('app.current_tenant_id', TRUE) IS NOT NULL
    AND current_setting('app.current_tenant_id', TRUE) <> ''
    AND current_setting('app.current_tenant_id', TRUE) <> 'bypass'
    AND tenant_id = public.app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', TRUE) IS NOT NULL
    AND current_setting('app.current_tenant_id', TRUE) <> ''
    AND current_setting('app.current_tenant_id', TRUE) <> 'bypass'
    AND tenant_id = public.app_current_tenant_id_uuid()
  );
CREATE POLICY tenant_isolation
  ON pharmacy_funding_reconciliation_events
  AS PERMISSIVE
  USING (
    current_setting('app.current_tenant_id', TRUE) IS NULL
    OR current_setting('app.current_tenant_id', TRUE) = ''
    OR current_setting('app.current_tenant_id', TRUE) = 'bypass'
    OR tenant_id = public.app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', TRUE) IS NULL
    OR current_setting('app.current_tenant_id', TRUE) = ''
    OR current_setting('app.current_tenant_id', TRUE) = 'bypass'
    OR tenant_id = public.app_current_tenant_id_uuid()
  );
CREATE POLICY pharmacy_funding_reconciliation_events_tenant_restrictive
  ON pharmacy_funding_reconciliation_events AS RESTRICTIVE
  USING (
    current_setting('app.current_tenant_id', TRUE) IS NOT NULL
    AND current_setting('app.current_tenant_id', TRUE) <> ''
    AND current_setting('app.current_tenant_id', TRUE) <> 'bypass'
    AND tenant_id = public.app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', TRUE) IS NOT NULL
    AND current_setting('app.current_tenant_id', TRUE) <> ''
    AND current_setting('app.current_tenant_id', TRUE) <> 'bypass'
    AND tenant_id = public.app_current_tenant_id_uuid()
  );

-- Exact insurance authority for pre-auth/claim creation.  The service locks
-- these tuples before inserting; the composite keys make the ownership bind
-- durable and the triggers prevent a later direct rewrite of that evidence.
CREATE UNIQUE INDEX IF NOT EXISTS ux_insurance_policies_claim_authority_753
  ON insurance_policies (tenant_id,id,patient_uid);
CREATE UNIQUE INDEX IF NOT EXISTS ux_insurance_preauth_claim_authority_753
  ON insurance_preauth (tenant_id,id,patient_uid,policy_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_tpa_claims_parent_authority_753
  ON tpa_claims (tenant_id,id,patient_uid,policy_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_billing_invoices_claim_authority_753
  ON billing_invoices (tenant_id,id,patient_uid);

ALTER TABLE insurance_preauth
  ADD CONSTRAINT fk_insurance_preauth_policy_authority_753
    FOREIGN KEY (tenant_id,policy_id,patient_uid)
    REFERENCES insurance_policies (tenant_id,id,patient_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  ADD CONSTRAINT fk_insurance_preauth_admission_authority_753
    FOREIGN KEY (tenant_id,admission_id,patient_uid)
    REFERENCES admissions (tenant_id,id,patient_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  ADD CONSTRAINT fk_insurance_preauth_parent_authority_753
    FOREIGN KEY (tenant_id,parent_preauth_id,patient_uid,policy_id)
    REFERENCES insurance_preauth (tenant_id,id,patient_uid,policy_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE tpa_claims
  ADD CONSTRAINT fk_tpa_claim_policy_authority_753
    FOREIGN KEY (tenant_id,policy_id,patient_uid)
    REFERENCES insurance_policies (tenant_id,id,patient_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  ADD CONSTRAINT fk_tpa_claim_preauth_authority_753
    FOREIGN KEY (tenant_id,preauth_id,patient_uid,policy_id)
    REFERENCES insurance_preauth (tenant_id,id,patient_uid,policy_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  ADD CONSTRAINT fk_tpa_claim_admission_authority_753
    FOREIGN KEY (tenant_id,admission_id,patient_uid)
    REFERENCES admissions (tenant_id,id,patient_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  ADD CONSTRAINT fk_tpa_claim_parent_authority_753
    FOREIGN KEY (tenant_id,parent_claim_id,patient_uid,policy_id)
    REFERENCES tpa_claims (tenant_id,id,patient_uid,policy_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  ADD CONSTRAINT fk_tpa_claim_invoice_authority_753
    FOREIGN KEY (tenant_id,invoice_id,patient_uid)
    REFERENCES billing_invoices (tenant_id,id,patient_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

CREATE OR REPLACE FUNCTION public.enforce_insurance_preauth_authority_753()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  parent_admission_id INTEGER;
BEGIN
  IF TG_OP='UPDATE' AND (
    NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.policy_id IS DISTINCT FROM OLD.policy_id
    OR NEW.patient_uid IS DISTINCT FROM OLD.patient_uid
    OR NEW.admission_id IS DISTINCT FROM OLD.admission_id
    OR NEW.request_type IS DISTINCT FROM OLD.request_type
    OR NEW.parent_preauth_id IS DISTINCT FROM OLD.parent_preauth_id
    OR NEW.expected_cost IS DISTINCT FROM OLD.expected_cost
    OR NEW.cost_breakdown IS DISTINCT FROM OLD.cost_breakdown
  ) THEN
    RAISE EXCEPTION 'insurance pre-auth authority identity and requested amount are immutable'
      USING ERRCODE='55000';
  END IF;
  IF NEW.parent_preauth_id IS NOT NULL THEN
    SELECT admission_id INTO parent_admission_id
      FROM insurance_preauth
     WHERE tenant_id=NEW.tenant_id
       AND id=NEW.parent_preauth_id
       AND patient_uid=NEW.patient_uid
       AND policy_id=NEW.policy_id;
    IF NOT FOUND OR parent_admission_id IS DISTINCT FROM NEW.admission_id THEN
      RAISE EXCEPTION 'parent pre-auth is not bound to the exact patient policy and admission'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_insurance_preauth_authority_753
BEFORE INSERT OR UPDATE ON insurance_preauth
FOR EACH ROW EXECUTE FUNCTION public.enforce_insurance_preauth_authority_753();

CREATE OR REPLACE FUNCTION public.enforce_tpa_claim_authority_753()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  reference_admission_id INTEGER;
  reference_preauth_id INTEGER;
BEGIN
  IF TG_OP='UPDATE' AND (
    NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.policy_id IS DISTINCT FROM OLD.policy_id
    OR NEW.preauth_id IS DISTINCT FROM OLD.preauth_id
    OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
    OR NEW.patient_uid IS DISTINCT FROM OLD.patient_uid
    OR NEW.admission_id IS DISTINCT FROM OLD.admission_id
    OR NEW.claim_type IS DISTINCT FROM OLD.claim_type
    OR NEW.stage IS DISTINCT FROM OLD.stage
    OR NEW.parent_claim_id IS DISTINCT FROM OLD.parent_claim_id
    OR NEW.total_billed IS DISTINCT FROM OLD.total_billed
    OR NEW.patient_copay IS DISTINCT FROM OLD.patient_copay
    OR NEW.non_payable_amount IS DISTINCT FROM OLD.non_payable_amount
    OR NEW.claimed_amount IS DISTINCT FROM OLD.claimed_amount
  ) THEN
    RAISE EXCEPTION 'TPA claim authority identity and billed amounts are immutable'
      USING ERRCODE='55000';
  END IF;
  IF NEW.preauth_id IS NOT NULL THEN
    SELECT admission_id INTO reference_admission_id
      FROM insurance_preauth
     WHERE tenant_id=NEW.tenant_id
       AND id=NEW.preauth_id
       AND patient_uid=NEW.patient_uid
       AND policy_id=NEW.policy_id;
    IF NOT FOUND OR reference_admission_id IS DISTINCT FROM NEW.admission_id THEN
      RAISE EXCEPTION 'claim pre-auth is not bound to the exact patient policy and admission'
        USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.parent_claim_id IS NOT NULL THEN
    SELECT admission_id,preauth_id INTO reference_admission_id,reference_preauth_id
      FROM tpa_claims
     WHERE tenant_id=NEW.tenant_id
       AND id=NEW.parent_claim_id
       AND patient_uid=NEW.patient_uid
       AND policy_id=NEW.policy_id;
    IF NOT FOUND
       OR reference_admission_id IS DISTINCT FROM NEW.admission_id
       OR (NEW.preauth_id IS NOT NULL AND reference_preauth_id IS DISTINCT FROM NEW.preauth_id) THEN
      RAISE EXCEPTION 'parent claim is not bound to the exact patient policy pre-auth and admission'
        USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.invoice_id IS NOT NULL THEN
    SELECT admission_id INTO reference_admission_id
      FROM billing_invoices
     WHERE tenant_id=NEW.tenant_id
       AND id=NEW.invoice_id
       AND patient_uid=NEW.patient_uid;
    IF NOT FOUND OR reference_admission_id IS DISTINCT FROM NEW.admission_id THEN
      RAISE EXCEPTION 'claim invoice is not bound to the exact patient and admission'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_tpa_claim_authority_753
BEFORE INSERT OR UPDATE ON tpa_claims
FOR EACH ROW EXECUTE FUNCTION public.enforce_tpa_claim_authority_753();

ALTER TABLE nhcx_messages
  ADD COLUMN IF NOT EXISTS transport_accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS transport_http_status INTEGER,
  ADD COLUMN IF NOT EXISTS transport_response_sha256 CHAR(64),
  ADD COLUMN IF NOT EXISTS transport_gateway_reference VARCHAR(255),
  ADD COLUMN IF NOT EXISTS transport_response_excerpt TEXT,
  ADD COLUMN IF NOT EXISTS projection_status VARCHAR(32),
  ADD COLUMN IF NOT EXISTS projection_error TEXT,
  ADD COLUMN IF NOT EXISTS projection_evidence JSONB,
  ADD COLUMN IF NOT EXISTS projection_task_id INTEGER,
  ADD COLUMN IF NOT EXISTS projection_updated_at TIMESTAMPTZ;

ALTER TABLE nhcx_messages
  ADD CONSTRAINT chk_nhcx_transport_projection_authority_753 CHECK (
    (
      transport_accepted_at IS NULL
      AND transport_http_status IS NULL
      AND transport_response_sha256 IS NULL
      AND transport_gateway_reference IS NULL
      AND transport_response_excerpt IS NULL
      AND projection_status IS NULL
      AND projection_error IS NULL
      AND projection_evidence IS NULL
      AND projection_task_id IS NULL
      AND projection_updated_at IS NULL
    )
    OR (
      direction='outbound'
      AND status='accepted'
      AND transport_accepted_at IS NOT NULL
      AND transport_http_status BETWEEN 200 AND 299
      AND transport_response_sha256 ~ '^[0-9a-f]{64}$'
      AND projection_status IN ('pending','applied','reconciliation_required')
      AND projection_updated_at IS NOT NULL
      AND (
        (projection_status='pending' AND projection_error IS NULL
         AND projection_task_id IS NULL)
        OR
        (projection_status='applied' AND projection_error IS NULL
         AND projection_evidence IS NOT NULL AND projection_task_id IS NULL)
        OR
        (projection_status='reconciliation_required'
         AND projection_error IS NOT NULL AND length(btrim(projection_error)) > 0
         AND projection_evidence IS NOT NULL AND projection_task_id IS NOT NULL)
      )
    )
  ) NOT VALID,
  ADD CONSTRAINT fk_nhcx_projection_task_753
    FOREIGN KEY (tenant_id,projection_task_id)
    REFERENCES tasks (tenant_id,id)
    ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID;

CREATE INDEX IF NOT EXISTS idx_nhcx_projection_reconciliation_753
  ON nhcx_messages (tenant_id,projection_status,transport_accepted_at,id)
  WHERE projection_status='reconciliation_required';

CREATE OR REPLACE FUNCTION public.enforce_nhcx_projection_task_binding_753()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.projection_status='reconciliation_required' AND NOT EXISTS (
    SELECT 1 FROM tasks task
     WHERE task.tenant_id=NEW.tenant_id
       AND task.id=NEW.projection_task_id
       AND task.related_resource_type='nhcx_gateway_projection'
       AND task.related_resource_id=NEW.id::text
       AND task.assigned_to_role='INSURANCE_COORDINATOR'
       AND task.status IN ('open','in_progress','blocked','overdue')
       AND task.metadata->>'transport_response_sha256'=btrim(NEW.transport_response_sha256)
  ) THEN
    RAISE EXCEPTION 'NHCX reconciliation must bind the exact active insurance projection task'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_nhcx_projection_task_binding_753
BEFORE INSERT OR UPDATE OF projection_status,projection_task_id ON nhcx_messages
FOR EACH ROW EXECUTE FUNCTION public.enforce_nhcx_projection_task_binding_753();

CREATE TABLE nhcx_projection_commands (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  nhcx_message_id BIGINT NOT NULL,
  task_id INTEGER NOT NULL,
  actor_uid UUID NOT NULL,
  actor_role VARCHAR(80) NOT NULL,
  command_key_sha256 CHAR(64) NOT NULL,
  request_sha256 CHAR(64) NOT NULL,
  transport_response_sha256 CHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'IN_PROGRESS',
  response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_nhcx_projection_commands_key_753
    UNIQUE (tenant_id,command_key_sha256),
  CONSTRAINT fk_nhcx_projection_commands_message_753
    FOREIGN KEY (tenant_id,nhcx_message_id)
    REFERENCES nhcx_messages (tenant_id,id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_nhcx_projection_commands_task_753
    FOREIGN KEY (tenant_id,task_id)
    REFERENCES tasks (tenant_id,id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_nhcx_projection_commands_actor_753
    FOREIGN KEY (tenant_id,actor_uid)
    REFERENCES users (tenant_id,uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_nhcx_projection_commands_shape_753 CHECK (
    command_key_sha256 ~ '^[0-9a-f]{64}$'
    AND request_sha256 ~ '^[0-9a-f]{64}$'
    AND transport_response_sha256 ~ '^[0-9a-f]{64}$'
    AND actor_role IN ('INSURANCE_COORDINATOR','CLAIMS_MANAGER','ADMIN','SUPER_ADMIN')
    AND (
      (status='IN_PROGRESS' AND response IS NULL AND completed_at IS NULL)
      OR
      (status='COMPLETE' AND response IS NOT NULL AND completed_at IS NOT NULL)
    )
  )
);

CREATE INDEX idx_nhcx_projection_commands_message_753
  ON nhcx_projection_commands (tenant_id,nhcx_message_id,created_at DESC);
CREATE INDEX idx_nhcx_projection_commands_task_753
  ON nhcx_projection_commands (tenant_id,task_id);

CREATE OR REPLACE FUNCTION public.enforce_nhcx_projection_command_753()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'NHCX projection command receipts cannot be deleted'
      USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM nhcx_messages message
        JOIN tasks task
          ON task.tenant_id=message.tenant_id
         AND task.id=NEW.task_id
         AND task.related_resource_type='nhcx_gateway_projection'
         AND task.related_resource_id=message.id::text
         AND task.assigned_to_role='INSURANCE_COORDINATOR'
         AND task.status IN ('open','in_progress','blocked','overdue')
         AND task.metadata->>'transport_response_sha256'=btrim(message.transport_response_sha256)
        JOIN users actor
          ON actor.tenant_id=message.tenant_id
         AND actor.uid=NEW.actor_uid
         AND actor.is_active=TRUE
         AND actor.status='active'
         AND actor.is_deleted=FALSE
         AND actor.merged_into_uid IS NULL
         AND UPPER(actor.role)=NEW.actor_role
       WHERE message.tenant_id=NEW.tenant_id
         AND message.id=NEW.nhcx_message_id
         AND message.status='accepted'
         AND message.transport_accepted_at IS NOT NULL
         AND message.projection_status='reconciliation_required'
         AND message.projection_task_id=NEW.task_id
         AND message.transport_response_sha256=NEW.transport_response_sha256
    ) THEN
      RAISE EXCEPTION 'NHCX projection command is not bound to the exact accepted receipt and task'
        USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.nhcx_message_id IS DISTINCT FROM OLD.nhcx_message_id
     OR NEW.task_id IS DISTINCT FROM OLD.task_id
     OR NEW.actor_uid IS DISTINCT FROM OLD.actor_uid
     OR NEW.actor_role IS DISTINCT FROM OLD.actor_role
     OR NEW.command_key_sha256 IS DISTINCT FROM OLD.command_key_sha256
     OR NEW.request_sha256 IS DISTINCT FROM OLD.request_sha256
     OR NEW.transport_response_sha256 IS DISTINCT FROM OLD.transport_response_sha256
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR OLD.status='COMPLETE'
     OR NOT (OLD.status='IN_PROGRESS' AND NEW.status='COMPLETE') THEN
    RAISE EXCEPTION 'NHCX projection command identity and completed response are immutable'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_nhcx_projection_commands_immutable_753
BEFORE INSERT OR UPDATE OR DELETE ON nhcx_projection_commands
FOR EACH ROW EXECUTE FUNCTION public.enforce_nhcx_projection_command_753();

ALTER TABLE nhcx_projection_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE nhcx_projection_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation
  ON nhcx_projection_commands AS PERMISSIVE
  USING (
    current_setting('app.current_tenant_id',TRUE) IS NULL
    OR current_setting('app.current_tenant_id',TRUE)=''
    OR current_setting('app.current_tenant_id',TRUE)='bypass'
    OR tenant_id=public.app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id',TRUE) IS NULL
    OR current_setting('app.current_tenant_id',TRUE)=''
    OR current_setting('app.current_tenant_id',TRUE)='bypass'
    OR tenant_id=public.app_current_tenant_id_uuid()
  );
CREATE POLICY nhcx_projection_commands_tenant_restrictive_753
  ON nhcx_projection_commands AS RESTRICTIVE
  USING (
    current_setting('app.current_tenant_id',TRUE)='bypass'
    OR (
      current_setting('app.current_tenant_id',TRUE) IS NOT NULL
      AND current_setting('app.current_tenant_id',TRUE)<>''
      AND tenant_id=public.app_current_tenant_id_uuid()
    )
  )
  WITH CHECK (
    current_setting('app.current_tenant_id',TRUE)='bypass'
    OR (
      current_setting('app.current_tenant_id',TRUE) IS NOT NULL
      AND current_setting('app.current_tenant_id',TRUE)<>''
      AND tenant_id=public.app_current_tenant_id_uuid()
    )
  );

CREATE OR REPLACE FUNCTION public.prevent_nhcx_transport_receipt_rewrite_753()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.transport_accepted_at IS NOT NULL THEN
      RAISE EXCEPTION 'Accepted NHCX transport receipt is immutable and cannot be deleted'
        USING ERRCODE='55000';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.transport_accepted_at IS NOT NULL AND (
    NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.direction IS DISTINCT FROM OLD.direction
    OR NEW.cycle IS DISTINCT FROM OLD.cycle
    OR NEW.endpoint IS DISTINCT FROM OLD.endpoint
    OR NEW.claim_id IS DISTINCT FROM OLD.claim_id
    OR NEW.preauth_id IS DISTINCT FROM OLD.preauth_id
    OR NEW.patient_uid IS DISTINCT FROM OLD.patient_uid
    OR NEW.admission_id IS DISTINCT FROM OLD.admission_id
    OR NEW.transport_accepted_at IS DISTINCT FROM OLD.transport_accepted_at
    OR NEW.transport_http_status IS DISTINCT FROM OLD.transport_http_status
    OR NEW.transport_response_sha256 IS DISTINCT FROM OLD.transport_response_sha256
    OR NEW.transport_gateway_reference IS DISTINCT FROM OLD.transport_gateway_reference
    OR NEW.transport_response_excerpt IS DISTINCT FROM OLD.transport_response_excerpt
    OR NEW.status <> 'accepted'
  ) THEN
    RAISE EXCEPTION 'Accepted NHCX transport receipt is immutable and cannot be resent'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_nhcx_transport_receipt_immutable_753
BEFORE UPDATE OR DELETE ON nhcx_messages
FOR EACH ROW EXECUTE FUNCTION public.prevent_nhcx_transport_receipt_rewrite_753();

-- MED03 pharmacy supply runtime authority: storage lineage, durable command
-- receipts, and terminal GRN/QC state. Keep this block isolated from the
-- order, funding, cath, ward, eRx, and NHCX authority blocks above.
ALTER TABLE pharmacy_suppliers
  ADD COLUMN IF NOT EXISTS facility_id INTEGER;

-- 'supplier' is already in the single authoritative entity_type CHECK on
-- pharmacy_inventory_authority_recovery_worklist (note the differing
-- constraint NAME here: a second CHECK does not replace the first, it ANDs
-- with it, and this one would have dropped every cath entity type out of the
-- effective allow-list).

WITH supplier_facilities AS (
  SELECT item.tenant_id, item.default_supplier_id AS supplier_id, item.facility_id
    FROM pharmacy_inventory_items item
   WHERE item.default_supplier_id IS NOT NULL AND item.facility_id IS NOT NULL
  UNION
  SELECT batch.tenant_id, batch.supplier_id, batch.facility_id
    FROM pharmacy_inventory_batches batch
   WHERE batch.supplier_id IS NOT NULL AND batch.facility_id IS NOT NULL
  UNION
  SELECT po.tenant_id, po.supplier_id, po.facility_id
    FROM pharmacy_purchase_orders po
   WHERE po.supplier_id IS NOT NULL AND po.facility_id IS NOT NULL
  UNION
  SELECT grn.tenant_id, grn.supplier_id, grn.facility_id
    FROM pharmacy_goods_receipts grn
   WHERE grn.supplier_id IS NOT NULL AND grn.facility_id IS NOT NULL
), resolved AS (
  SELECT tenant_id, supplier_id, MIN(facility_id) AS facility_id,
         COUNT(DISTINCT facility_id)::int AS facility_count
    FROM supplier_facilities
   GROUP BY tenant_id, supplier_id
)
UPDATE pharmacy_suppliers supplier
   SET facility_id=resolved.facility_id,
       updated_at=NOW()
  FROM resolved
 WHERE supplier.tenant_id=resolved.tenant_id
   AND supplier.id=resolved.supplier_id
   AND supplier.facility_id IS NULL
   AND resolved.facility_count=1;

WITH supplier_facilities AS (
  SELECT item.tenant_id, item.default_supplier_id AS supplier_id, item.facility_id
    FROM pharmacy_inventory_items item
   WHERE item.default_supplier_id IS NOT NULL AND item.facility_id IS NOT NULL
  UNION
  SELECT batch.tenant_id, batch.supplier_id, batch.facility_id
    FROM pharmacy_inventory_batches batch
   WHERE batch.supplier_id IS NOT NULL AND batch.facility_id IS NOT NULL
  UNION
  SELECT po.tenant_id, po.supplier_id, po.facility_id
    FROM pharmacy_purchase_orders po
   WHERE po.supplier_id IS NOT NULL AND po.facility_id IS NOT NULL
  UNION
  SELECT grn.tenant_id, grn.supplier_id, grn.facility_id
    FROM pharmacy_goods_receipts grn
   WHERE grn.supplier_id IS NOT NULL AND grn.facility_id IS NOT NULL
), authority AS (
  SELECT supplier.tenant_id, supplier.id AS supplier_id,
         ARRAY_REMOVE(ARRAY_AGG(DISTINCT scope.facility_id), NULL) AS facility_ids
    FROM pharmacy_suppliers supplier
    LEFT JOIN supplier_facilities scope
      ON scope.tenant_id=supplier.tenant_id AND scope.supplier_id=supplier.id
   WHERE supplier.facility_id IS NULL
   GROUP BY supplier.tenant_id, supplier.id
)
INSERT INTO pharmacy_inventory_authority_recovery_worklist (
  tenant_id, entity_type, entity_id, reason_code, authority_snapshot
)
SELECT authority.tenant_id, 'supplier', authority.supplier_id,
       'SUPPLIER_FACILITY_AUTHORITY_UNRESOLVED',
       jsonb_build_object('candidate_facility_ids', authority.facility_ids)
  FROM authority
ON CONFLICT (tenant_id, entity_type, entity_id, reason_code) DO NOTHING;

UPDATE pharmacy_suppliers supplier
   SET status='paused',
       metadata=COALESCE(supplier.metadata, '{}'::jsonb)
         || jsonb_build_object('facility_authority_recovery_required', TRUE),
       updated_at=NOW()
 WHERE supplier.facility_id IS NULL
   AND supplier.status='active';

CREATE INDEX IF NOT EXISTS idx_pharmacy_suppliers_facility_authority_supply_753
  ON pharmacy_suppliers (tenant_id, facility_id, status)
  WHERE facility_id IS NOT NULL;

ALTER TABLE pharmacy_suppliers
  DROP CONSTRAINT IF EXISTS fk_pharmacy_suppliers_facility_authority_supply_753,
  DROP CONSTRAINT IF EXISTS chk_pharmacy_suppliers_active_facility_supply_753,
  ADD CONSTRAINT fk_pharmacy_suppliers_facility_authority_supply_753
    FOREIGN KEY (tenant_id, facility_id)
    REFERENCES facilities (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT chk_pharmacy_suppliers_active_facility_supply_753
    CHECK (status<>'active' OR facility_id IS NOT NULL) NOT VALID;

CREATE OR REPLACE FUNCTION public.prevent_pharmacy_supplier_rehome_supply_753()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  has_history BOOLEAN;
BEGIN
  IF NEW.facility_id IS NOT DISTINCT FROM OLD.facility_id THEN RETURN NEW; END IF;
  SELECT (
    EXISTS (SELECT 1 FROM pharmacy_inventory_items item
             WHERE item.tenant_id=OLD.tenant_id
               AND item.default_supplier_id=OLD.id)
    OR EXISTS (SELECT 1 FROM pharmacy_inventory_batches batch
                WHERE batch.tenant_id=OLD.tenant_id
                  AND batch.supplier_id=OLD.id)
    OR EXISTS (SELECT 1 FROM pharmacy_purchase_orders po
                WHERE po.tenant_id=OLD.tenant_id
                  AND po.supplier_id=OLD.id)
    OR EXISTS (SELECT 1 FROM pharmacy_goods_receipts grn
                WHERE grn.tenant_id=OLD.tenant_id
                  AND grn.supplier_id=OLD.id)
  ) INTO has_history;
  IF has_history AND NOT (
    current_setting('app.pharmacy_authority_recovery_id', TRUE) ~ '^[1-9][0-9]*$'
    AND EXISTS (
      SELECT 1 FROM pharmacy_inventory_authority_recovery_worklist recovery
       WHERE recovery.id=current_setting(
               'app.pharmacy_authority_recovery_id', TRUE
             )::bigint
         AND recovery.tenant_id=OLD.tenant_id
         AND recovery.entity_type='supplier'
         AND recovery.entity_id=OLD.id
         AND recovery.reason_code='SUPPLIER_FACILITY_AUTHORITY_UNRESOLVED'
         AND recovery.status='OPEN'
         AND recovery.authority_snapshot->>'target_facility_id'=NEW.facility_id::text
    )
  ) THEN
    RAISE EXCEPTION 'Supplier facility authority is immutable after supply lineage exists'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pharmacy_supplier_rehome_supply_753
  ON pharmacy_suppliers;
CREATE TRIGGER trg_pharmacy_supplier_rehome_supply_753
BEFORE UPDATE OF facility_id ON pharmacy_suppliers
FOR EACH ROW EXECUTE FUNCTION public.prevent_pharmacy_supplier_rehome_supply_753();

CREATE OR REPLACE FUNCTION public.prevent_pharmacy_inventory_item_rehome_supply_753()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  has_history BOOLEAN;
BEGIN
  IF NEW.facility_id IS NOT DISTINCT FROM OLD.facility_id
     AND NEW.catalog_id IS NOT DISTINCT FROM OLD.catalog_id
     AND NEW.default_supplier_id IS NOT DISTINCT FROM OLD.default_supplier_id
     AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  SELECT (
    EXISTS (SELECT 1 FROM pharmacy_inventory_batches batch
             WHERE batch.tenant_id=OLD.tenant_id
               AND batch.inventory_item_id=OLD.id)
    OR EXISTS (SELECT 1 FROM pharmacy_purchase_order_items line
                WHERE line.tenant_id=OLD.tenant_id
                  AND line.inventory_item_id=OLD.id)
    OR EXISTS (SELECT 1 FROM pharmacy_goods_receipt_items line
                WHERE line.tenant_id=OLD.tenant_id
                  AND line.inventory_item_id=OLD.id)
    OR EXISTS (SELECT 1 FROM pharmacy_stock_movements movement
                WHERE movement.tenant_id=OLD.tenant_id
                  AND movement.inventory_item_id=OLD.id)
    OR EXISTS (SELECT 1 FROM pharmacy_substitutes substitute
                WHERE substitute.tenant_id=OLD.tenant_id
                  AND (substitute.primary_item_id=OLD.id
                    OR substitute.substitute_item_id=OLD.id))
  ) INTO has_history;
  IF has_history AND NOT (
    current_setting('app.pharmacy_authority_recovery_id', TRUE) ~ '^[1-9][0-9]*$'
    AND EXISTS (
      SELECT 1 FROM pharmacy_inventory_authority_recovery_worklist recovery
       WHERE recovery.id=current_setting(
               'app.pharmacy_authority_recovery_id', TRUE
             )::bigint
         AND recovery.tenant_id=OLD.tenant_id
         AND recovery.entity_type='inventory_item'
         AND recovery.entity_id=OLD.id
         AND recovery.reason_code='INVENTORY_ITEM_AUTHORITY_REHOME'
         AND recovery.status='OPEN'
         AND recovery.authority_snapshot->>'target_facility_id'=NEW.facility_id::text
         AND recovery.authority_snapshot->>'target_catalog_id'=NEW.catalog_id::text
         AND COALESCE(
               recovery.authority_snapshot->>'target_default_supplier_id',
               ''
             )=COALESCE(NEW.default_supplier_id::text, '')
         AND recovery.authority_snapshot->>'target_status'=NEW.status
    )
  ) THEN
    RAISE EXCEPTION 'Inventory item facility, catalog, supplier, and status authority is immutable after custody history'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pharmacy_inventory_item_rehome_supply_753
  ON pharmacy_inventory_items;
CREATE TRIGGER trg_pharmacy_inventory_item_rehome_supply_753
BEFORE UPDATE OF facility_id,catalog_id,default_supplier_id,status
ON pharmacy_inventory_items
FOR EACH ROW EXECUTE FUNCTION public.prevent_pharmacy_inventory_item_rehome_supply_753();

CREATE UNIQUE INDEX IF NOT EXISTS ux_facility_locations_tenant_facility_id_supply_753
  ON facility_locations (tenant_id, facility_id, id);

INSERT INTO pharmacy_inventory_authority_recovery_worklist (
  tenant_id, entity_type, entity_id, inventory_item_id,
  facility_id, reason_code, authority_snapshot
)
SELECT batch.tenant_id, 'inventory_batch', batch.id, batch.inventory_item_id,
       batch.facility_id, 'BATCH_STORAGE_LOCATION_AUTHORITY_INVALID',
       jsonb_build_object(
         'storage_location_id', batch.storage_location_id,
         'batch_status', batch.status
       )
  FROM pharmacy_inventory_batches batch
  LEFT JOIN facility_locations location
    ON location.tenant_id=batch.tenant_id
   AND location.facility_id=batch.facility_id
   AND location.id=batch.storage_location_id
   AND location.status='active'
 WHERE batch.storage_location_id IS NULL OR location.id IS NULL
ON CONFLICT (tenant_id, entity_type, entity_id, reason_code) DO NOTHING;

UPDATE pharmacy_inventory_batches batch
   SET status='quarantined',
       metadata=COALESCE(batch.metadata, '{}'::jsonb)
         || jsonb_build_object('storage_authority_recovery_required', TRUE),
       updated_at=NOW()
 WHERE batch.status IN ('in_stock', 'reserved')
   AND (
     batch.storage_location_id IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM facility_locations location
        WHERE location.tenant_id=batch.tenant_id
          AND location.facility_id=batch.facility_id
          AND location.id=batch.storage_location_id
          AND location.status='active'
     )
   );

CREATE INDEX IF NOT EXISTS idx_pharmacy_batches_storage_authority_supply_753
  ON pharmacy_inventory_batches (tenant_id, facility_id, storage_location_id)
  WHERE storage_location_id IS NOT NULL;

ALTER TABLE pharmacy_inventory_batches
  DROP CONSTRAINT IF EXISTS fk_pharmacy_batches_storage_authority_supply_753,
  DROP CONSTRAINT IF EXISTS chk_pharmacy_batches_usable_storage_supply_753,
  ADD CONSTRAINT fk_pharmacy_batches_storage_authority_supply_753
    FOREIGN KEY (tenant_id, facility_id, storage_location_id)
    REFERENCES facility_locations (tenant_id, facility_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT chk_pharmacy_batches_usable_storage_supply_753
    CHECK (
      status NOT IN ('in_stock', 'reserved')
      OR storage_location_id IS NOT NULL
    ) NOT VALID;

CREATE OR REPLACE FUNCTION public.enforce_pharmacy_batch_storage_authority_supply_753()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IN ('in_stock', 'reserved', 'quarantined')
     AND NEW.storage_location_id IS NULL THEN
    RAISE EXCEPTION 'Active or quarantined pharmacy stock requires an exact storage location'
      USING ERRCODE='23514';
  END IF;
  IF NEW.storage_location_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM facility_locations location
     WHERE location.tenant_id=NEW.tenant_id
       AND location.facility_id=NEW.facility_id
       AND location.id=NEW.storage_location_id
       AND location.status='active'
  ) THEN
    RAISE EXCEPTION 'Pharmacy batch storage location must be active in the exact facility'
      USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE'
     AND NEW.storage_location_id IS DISTINCT FROM OLD.storage_location_id
     AND (
       EXISTS (
         SELECT 1 FROM pharmacy_stock_movements movement
          WHERE movement.tenant_id=OLD.tenant_id
            AND movement.inventory_batch_id=OLD.id
       )
       OR EXISTS (
         SELECT 1 FROM pharmacy_goods_receipt_items line
          WHERE line.tenant_id=OLD.tenant_id
            AND line.inventory_batch_id=OLD.id
       )
     ) THEN
    RAISE EXCEPTION 'Pharmacy batch storage lineage is immutable after custody history exists'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pharmacy_batch_storage_authority_supply_753
  ON pharmacy_inventory_batches;
CREATE TRIGGER trg_pharmacy_batch_storage_authority_supply_753
BEFORE INSERT OR UPDATE OF tenant_id,facility_id,storage_location_id,status
ON pharmacy_inventory_batches
FOR EACH ROW EXECUTE FUNCTION public.enforce_pharmacy_batch_storage_authority_supply_753();

CREATE OR REPLACE FUNCTION public.prevent_pharmacy_storage_location_rehome_supply_753()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_tenant UUID := CASE WHEN TG_OP='DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
  target_id INTEGER := CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS (
      SELECT 1 FROM pharmacy_inventory_batches batch
       WHERE batch.tenant_id=target_tenant
         AND batch.storage_location_id=target_id
    ) THEN
      RAISE EXCEPTION 'A pharmacy storage location with batch lineage cannot be deleted'
        USING ERRCODE='55000';
    END IF;
    RETURN OLD;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pharmacy_inventory_batches batch
     WHERE batch.tenant_id=target_tenant
       AND batch.storage_location_id=target_id
  ) AND (
    NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.facility_id IS DISTINCT FROM OLD.facility_id
    OR NEW.status IS DISTINCT FROM OLD.status
  ) THEN
    RAISE EXCEPTION 'A pharmacy storage location with batch lineage cannot be moved or inactivated'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pharmacy_storage_location_rehome_supply_753
  ON facility_locations;
CREATE TRIGGER trg_pharmacy_storage_location_rehome_supply_753
BEFORE UPDATE OF tenant_id,facility_id,status OR DELETE ON facility_locations
FOR EACH ROW EXECUTE FUNCTION public.prevent_pharmacy_storage_location_rehome_supply_753();

CREATE OR REPLACE FUNCTION public.enforce_pharmacy_supply_receipt_immutable_753()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  old_contract TEXT := OLD.metadata->>'contract';
  new_contract TEXT := CASE WHEN TG_OP='DELETE' THEN NULL ELSE NEW.metadata->>'contract' END;
  receipt_key TEXT;
  receipt_facility TEXT;
BEGIN
  IF old_contract IS NULL OR old_contract NOT IN (
    'pharmacy_inventory_direct_receive_v1',
    'pharmacy_grn_receive_line_v1',
    'pharmacy_supply_stock_movement_v1'
  ) THEN
    IF TG_OP<>'DELETE' AND new_contract IN (
      'pharmacy_inventory_direct_receive_v1',
      'pharmacy_grn_receive_line_v1',
      'pharmacy_supply_stock_movement_v1'
    ) THEN
      RAISE EXCEPTION 'A legacy movement cannot be rewritten as a pharmacy supply command receipt'
        USING ERRCODE='55000';
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Pharmacy supply command receipts cannot be deleted'
      USING ERRCODE='55000';
  END IF;
  IF new_contract IS DISTINCT FROM old_contract
     OR to_jsonb(NEW) - 'metadata' IS DISTINCT FROM to_jsonb(OLD) - 'metadata' THEN
    RAISE EXCEPTION 'Pharmacy supply command identity and movement evidence are immutable'
      USING ERRCODE='55000';
  END IF;

  receipt_key := CASE
    WHEN old_contract='pharmacy_supply_stock_movement_v1' THEN 'response'
    ELSE 'response_payload'
  END;
  IF OLD.metadata ? receipt_key THEN
    IF NEW.metadata IS DISTINCT FROM OLD.metadata THEN
      RAISE EXCEPTION 'Completed pharmacy supply command receipts are immutable'
        USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT (NEW.metadata ? receipt_key)
     OR NEW.metadata - receipt_key IS DISTINCT FROM OLD.metadata THEN
    RAISE EXCEPTION 'Only one immutable pharmacy supply response may complete a command receipt'
      USING ERRCODE='55000';
  END IF;
  receipt_facility := CASE old_contract
    WHEN 'pharmacy_supply_stock_movement_v1'
      THEN NEW.metadata#>>'{response,facility_id}'
    WHEN 'pharmacy_grn_receive_line_v1'
      THEN COALESCE(
        NEW.metadata#>>'{response_payload,goods_receipt,facility_id}',
        NEW.metadata#>>'{response_payload,batch,facility_id}'
      )
    ELSE NEW.metadata#>>'{response_payload,facility_id}'
  END;
  IF receipt_facility IS NULL OR receipt_facility !~ '^[1-9][0-9]*$' THEN
    RAISE EXCEPTION 'Pharmacy supply response receipt requires a positive stored facility authority'
      USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pharmacy_inventory_batches batch
     WHERE batch.tenant_id=OLD.tenant_id
       AND batch.id=OLD.inventory_batch_id
       AND batch.inventory_item_id=OLD.inventory_item_id
       AND batch.facility_id::text=receipt_facility
  ) THEN
    RAISE EXCEPTION 'Pharmacy supply response receipt facility does not match its immutable batch lineage'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pharmacy_supply_receipt_immutable_753
  ON pharmacy_stock_movements;
CREATE TRIGGER trg_pharmacy_supply_receipt_immutable_753
BEFORE UPDATE OR DELETE ON pharmacy_stock_movements
FOR EACH ROW EXECUTE FUNCTION public.enforce_pharmacy_supply_receipt_immutable_753();

ALTER TABLE pharmacy_goods_receipts
  DROP CONSTRAINT IF EXISTS chk_pharmacy_goods_receipts_status_supply_753,
  ADD CONSTRAINT chk_pharmacy_goods_receipts_status_supply_753 CHECK (
    status IN (
      'received', 'qc_pending', 'qc_failed', 'qc_passed', 'partial',
      'closed', 'rejected', 'archived'
    )
  ) NOT VALID;

CREATE OR REPLACE FUNCTION public.enforce_pharmacy_grn_lifecycle_supply_753()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Goods receipts are custody evidence and cannot be deleted'
      USING ERRCODE='55000';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.facility_id IS DISTINCT FROM OLD.facility_id
     OR NEW.grn_number IS DISTINCT FROM OLD.grn_number
     OR NEW.purchase_order_id IS DISTINCT FROM OLD.purchase_order_id
     OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
     OR NEW.received_by IS DISTINCT FROM OLD.received_by
     OR NEW.received_at IS DISTINCT FROM OLD.received_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Goods receipt custody identity is immutable'
      USING ERRCODE='55000';
  END IF;
  IF OLD.status IN ('rejected', 'archived') THEN
    RAISE EXCEPTION 'Terminal goods receipts are immutable'
      USING ERRCODE='55000';
  END IF;
  IF OLD.status='closed' AND NEW.status='archived' THEN RETURN NEW; END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status='received' AND NEW.status IN ('qc_pending', 'rejected'))
    OR (OLD.status='qc_pending' AND NEW.status IN ('qc_passed', 'qc_failed', 'partial', 'rejected'))
    OR (OLD.status IN ('qc_passed', 'partial') AND NEW.status='closed')
    OR (OLD.status='qc_failed' AND NEW.status='archived')
  ) THEN
    RAISE EXCEPTION 'Goods receipt status transition is not governed'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pharmacy_grn_lifecycle_supply_753
  ON pharmacy_goods_receipts;
CREATE TRIGGER trg_pharmacy_grn_lifecycle_supply_753
BEFORE UPDATE OR DELETE ON pharmacy_goods_receipts
FOR EACH ROW EXECUTE FUNCTION public.enforce_pharmacy_grn_lifecycle_supply_753();

CREATE OR REPLACE FUNCTION public.enforce_pharmacy_grn_item_qc_immutable_supply_753()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Goods receipt lines are custody evidence and cannot be deleted'
      USING ERRCODE='55000';
  END IF;
  IF OLD.qc_status IN ('passed', 'failed') THEN
    RAISE EXCEPTION 'Completed goods receipt line QC evidence is immutable'
      USING ERRCODE='55000';
  END IF;
  IF to_jsonb(NEW) - ARRAY['qc_status','qc_notes','metadata','updated_at']
       IS DISTINCT FROM
     to_jsonb(OLD) - ARRAY['qc_status','qc_notes','metadata','updated_at']
     OR COALESCE(OLD.qc_status, 'pending')<>'pending'
     OR NEW.qc_status NOT IN ('passed', 'failed') THEN
    RAISE EXCEPTION 'Goods receipt line changes require one terminal QC decision'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pharmacy_grn_item_qc_immutable_supply_753
  ON pharmacy_goods_receipt_items;
CREATE TRIGGER trg_pharmacy_grn_item_qc_immutable_supply_753
BEFORE UPDATE OR DELETE ON pharmacy_goods_receipt_items
FOR EACH ROW EXECUTE FUNCTION public.enforce_pharmacy_grn_item_qc_immutable_supply_753();

-- MED03 counter-sale facility authority. counterSaleService.js already writes
-- facility_id to all three migration-684 counter-sale tables (plus the
-- prescription pointer on lines and the item snapshot on allocations), but no
-- migration ever created those columns, so every POS sale fails at INSERT.
-- 753 is unshipped, so the DDL lands here rather than in a new migration
-- number. The custody chain mirrors the cath consumable pattern above:
-- sale -> line -> allocation each carry the facility, and every hop is pinned
-- by a composite FK through (tenant_id, facility_id) so a line or allocation
-- can never point at stock from a different facility than its own sale.
--
-- Every constraint is NOT VALID: legacy migration-684 rows predate facility
-- custody, keep facility_id NULL, and are worklisted below. Validation is
-- deferred to the readiness migration (756).
ALTER TABLE pharmacy_counter_sales
  ADD COLUMN IF NOT EXISTS facility_id INTEGER;

ALTER TABLE pharmacy_counter_sale_lines
  ADD COLUMN IF NOT EXISTS facility_id INTEGER,
  -- Signed e-prescription pointer for Schedule H/H1/X and narcotic lines.
  -- Bare INTEGER with no FK, matching migration 150's schedule-register
  -- idiom: e_prescriptions carries no (tenant_id, id) unique key to
  -- reference, and register evidence must outlive prescription retention.
  ADD COLUMN IF NOT EXISTS prescription_id INTEGER,
  ADD COLUMN IF NOT EXISTS prescription_line_index INTEGER;

ALTER TABLE pharmacy_counter_sale_allocations
  ADD COLUMN IF NOT EXISTS facility_id INTEGER,
  ADD COLUMN IF NOT EXISTS inventory_item_id INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_counter_sales_facility_scope_753
  ON pharmacy_counter_sales (tenant_id, id, facility_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_counter_sale_lines_facility_scope_753
  ON pharmacy_counter_sale_lines (tenant_id, id, facility_id, inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_pharmacy_counter_sales_facility_753
  ON pharmacy_counter_sales (tenant_id, facility_id, status, created_at DESC, id DESC)
  WHERE facility_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pharmacy_counter_sale_lines_facility_item_753
  ON pharmacy_counter_sale_lines (tenant_id, facility_id, inventory_item_id)
  WHERE facility_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pharmacy_counter_sale_allocations_facility_batch_753
  ON pharmacy_counter_sale_allocations (tenant_id, facility_id, inventory_batch_id)
  WHERE facility_id IS NOT NULL;

ALTER TABLE pharmacy_counter_sales
  DROP CONSTRAINT IF EXISTS fk_pharmacy_counter_sales_facility_753,
  DROP CONSTRAINT IF EXISTS chk_pharmacy_counter_sales_facility_authority_753,
  ADD CONSTRAINT fk_pharmacy_counter_sales_facility_753
    FOREIGN KEY (tenant_id, facility_id)
    REFERENCES facilities (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT chk_pharmacy_counter_sales_facility_authority_753
    CHECK (facility_id IS NOT NULL OR status IN ('VOIDED', 'FAILED')) NOT VALID;

ALTER TABLE pharmacy_counter_sale_lines
  DROP CONSTRAINT IF EXISTS fk_pharmacy_counter_sale_lines_sale_facility_753,
  DROP CONSTRAINT IF EXISTS fk_pharmacy_counter_sale_lines_facility_item_753,
  DROP CONSTRAINT IF EXISTS chk_pharmacy_counter_sale_lines_facility_authority_753,
  DROP CONSTRAINT IF EXISTS chk_pharmacy_counter_sale_lines_prescription_pointer_753,
  ADD CONSTRAINT fk_pharmacy_counter_sale_lines_sale_facility_753
    FOREIGN KEY (tenant_id, counter_sale_id, facility_id)
    REFERENCES pharmacy_counter_sales (tenant_id, id, facility_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT fk_pharmacy_counter_sale_lines_facility_item_753
    FOREIGN KEY (tenant_id, facility_id, inventory_item_id)
    REFERENCES pharmacy_inventory_items (tenant_id, facility_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT chk_pharmacy_counter_sale_lines_facility_authority_753
    CHECK (facility_id IS NOT NULL) NOT VALID,
  ADD CONSTRAINT chk_pharmacy_counter_sale_lines_prescription_pointer_753
    CHECK (
      prescription_line_index IS NULL
      OR (prescription_id IS NOT NULL AND prescription_line_index >= 0)
    ) NOT VALID;

ALTER TABLE pharmacy_counter_sale_allocations
  DROP CONSTRAINT IF EXISTS fk_pharmacy_counter_sale_alloc_line_facility_753,
  DROP CONSTRAINT IF EXISTS fk_pharmacy_counter_sale_alloc_facility_batch_753,
  DROP CONSTRAINT IF EXISTS chk_pharmacy_counter_sale_alloc_facility_authority_753,
  ADD CONSTRAINT fk_pharmacy_counter_sale_alloc_line_facility_753
    FOREIGN KEY (tenant_id, counter_sale_line_id, facility_id, inventory_item_id)
    REFERENCES pharmacy_counter_sale_lines (tenant_id, id, facility_id, inventory_item_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT fk_pharmacy_counter_sale_alloc_facility_batch_753
    FOREIGN KEY (tenant_id, facility_id, inventory_batch_id, inventory_item_id)
    REFERENCES pharmacy_inventory_batches (tenant_id, facility_id, id, inventory_item_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT chk_pharmacy_counter_sale_alloc_facility_authority_753
    CHECK (
      (facility_id IS NULL AND inventory_item_id IS NULL)
      OR (facility_id IS NOT NULL AND inventory_item_id IS NOT NULL)
    ) NOT VALID;

-- Legacy counter sales carry no facility and none is inferred: a tenant
-- default is not evidence of which counter dispensed the stock. Non-terminal
-- legacy sales are worklisted with the candidate defaults in their snapshot
-- and are held by chk_pharmacy_counter_sales_facility_authority_753.
INSERT INTO pharmacy_inventory_authority_recovery_worklist (
  tenant_id, entity_type, entity_id, reason_code, authority_snapshot
)
SELECT sale.tenant_id, 'counter_sale', sale.id,
       'COUNTER_SALE_FACILITY_UNRESOLVED',
       jsonb_build_object(
         'status', sale.status,
         'invoice_id', sale.invoice_id,
         'sold_by', sale.sold_by,
         'line_count', (
           SELECT COUNT(*)
             FROM pharmacy_counter_sale_lines line
            WHERE line.tenant_id=sale.tenant_id
              AND line.counter_sale_id=sale.id
         ),
         'candidate_facility_ids', COALESCE((
           SELECT jsonb_agg(facility.id ORDER BY facility.id)
             FROM facilities facility
            WHERE facility.tenant_id=sale.tenant_id
              AND facility.status='active'
              AND facility.is_default=TRUE
         ), '[]'::jsonb)
       )
  FROM pharmacy_counter_sales sale
 WHERE sale.facility_id IS NULL
   AND sale.status NOT IN ('VOIDED', 'FAILED')
ON CONFLICT (tenant_id, entity_type, entity_id, reason_code) DO NOTHING;

COMMENT ON COLUMN pharmacy_counter_sales.facility_id IS
  'Exact active facility whose counter dispensed this sale; unresolved legacy sales remain NULL and are worklisted.';
COMMENT ON COLUMN pharmacy_counter_sale_lines.facility_id IS
  'Immutable facility snapshot copied from the parent counter sale and pinned to the Inventory V2 item.';
COMMENT ON COLUMN pharmacy_counter_sale_lines.prescription_id IS
  'Signed e-prescription pointer required for Schedule H/H1/X and narcotic lines; no FK, matching the schedule register.';
COMMENT ON COLUMN pharmacy_counter_sale_allocations.facility_id IS
  'Immutable facility snapshot pinning this FEFO allocation to a batch in the selling facility.';
COMMENT ON COLUMN pharmacy_counter_sale_allocations.inventory_item_id IS
  'Immutable Inventory V2 item snapshot paired with facility_id and inventory_batch_id.';

COMMENT ON COLUMN cath_consumable_catalog.facility_id IS
  'Exact active facility of the mapped Inventory V2 item; unresolved legacy mappings remain NULL and fail closed.';
COMMENT ON COLUMN cath_lab_cases.facility_id IS
  'Pinned facility authority for this exact patient case and encounter; unresolved legacy cases remain NULL and are worklisted.';
COMMENT ON COLUMN cath_case_consumable_usage.facility_id IS
  'Immutable facility snapshot copied from the exact Cath catalog and Inventory V2 mapping.';
COMMENT ON COLUMN cath_case_consumable_usage.inventory_item_id IS
  'Immutable Inventory V2 item snapshot paired with facility_id and catalog_item_id.';

COMMENT ON COLUMN pharmacy_orders.facility_id IS
  'Exact active facility whose Inventory V2 custody fulfils this order; unresolved legacy rows fail closed.';
COMMENT ON COLUMN pharmacy_orders.inventory_authority_version IS
  'Monotonic structured-order revision. Verification is valid only for the same revision and item hash.';
COMMENT ON COLUMN pharmacy_orders.clinical_verification_safety_version IS
  'Patient medication-safety context version pinned by pharmacist verification and rechecked before fulfilment.';
COMMENT ON COLUMN pharmacy_orders.clinical_verification_active_therapy_sha256 IS
  'Canonical patient-global active-therapy source, timing, lineage, tenant catalog, composition, and KB identity snapshot pinned at pharmacist verification.';
COMMENT ON TABLE pharmacy_patient_safety_versions IS
  'Tenant/patient concurrency fence incremented before medication-safety source writes.';
COMMENT ON TABLE pharmacy_cap_reservations IS
  'Durable same-transaction admission pharmacy-cap consumption and authoritative funding evidence for one pharmacy order.';
COMMENT ON TABLE pharmacy_funding_decision_events IS
  'Append-only exact order-version funding authority evidence. Staff input alone is never dispense authority.';
COMMENT ON TABLE pharmacy_cap_reservation_events IS
  'Append-only attribution for pharmacy cap reservation, update, and release commands.';
COMMENT ON TABLE pharmacy_payment_allocations IS
  'Append-only allocation of posted invoice payments to one exact pharmacy order line/version; prevents invoice-payment double spend.';
COMMENT ON TABLE pharmacy_payment_allocation_reversals IS
  'Append-only exact compensating evidence that releases a pharmacy payment allocation before governed payment reversal.';
COMMENT ON TABLE pharmacy_funding_commands IS
  'Durable exact request/target claim checked before pharmacy funding decision mutation.';

COMMIT;

-- Schema bridge: tenant isolation for the two bridged allocation ledgers.
-- Lifted verbatim from the full lane (both the permissive tenant_isolation
-- and the restrictive explicit_tenant_context policies); the repo phi gate
-- requires a tenant_isolation policy on every tenant_id-bearing table.
ALTER TABLE pharmacy_advance_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_advance_allocations FORCE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_advance_allocation_reversals ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_advance_allocation_reversals FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON pharmacy_advance_allocations;
CREATE POLICY tenant_isolation ON pharmacy_advance_allocations
  AS PERMISSIVE
  USING (
    current_setting('app.current_tenant_id',TRUE) IN ('','bypass')
    OR current_setting('app.current_tenant_id',TRUE) IS NULL
    OR tenant_id=public.app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id',TRUE) IN ('','bypass')
    OR current_setting('app.current_tenant_id',TRUE) IS NULL
    OR tenant_id=public.app_current_tenant_id_uuid()
  );
DROP POLICY IF EXISTS explicit_tenant_context ON pharmacy_advance_allocations;
CREATE POLICY explicit_tenant_context ON pharmacy_advance_allocations
  AS RESTRICTIVE
  USING (
    current_setting('app.current_tenant_id',TRUE) IS NOT NULL
    AND current_setting('app.current_tenant_id',TRUE) NOT IN ('','bypass')
    AND tenant_id=public.app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id',TRUE) IS NOT NULL
    AND current_setting('app.current_tenant_id',TRUE) NOT IN ('','bypass')
    AND tenant_id=public.app_current_tenant_id_uuid()
  );

DROP POLICY IF EXISTS tenant_isolation ON pharmacy_advance_allocation_reversals;
CREATE POLICY tenant_isolation ON pharmacy_advance_allocation_reversals
  AS PERMISSIVE
  USING (
    current_setting('app.current_tenant_id',TRUE) IN ('','bypass')
    OR current_setting('app.current_tenant_id',TRUE) IS NULL
    OR tenant_id=public.app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id',TRUE) IN ('','bypass')
    OR current_setting('app.current_tenant_id',TRUE) IS NULL
    OR tenant_id=public.app_current_tenant_id_uuid()
  );
DROP POLICY IF EXISTS explicit_tenant_context ON pharmacy_advance_allocation_reversals;
CREATE POLICY explicit_tenant_context ON pharmacy_advance_allocation_reversals
  AS RESTRICTIVE
  USING (
    current_setting('app.current_tenant_id',TRUE) IS NOT NULL
    AND current_setting('app.current_tenant_id',TRUE) NOT IN ('','bypass')
    AND tenant_id=public.app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id',TRUE) IS NOT NULL
    AND current_setting('app.current_tenant_id',TRUE) NOT IN ('','bypass')
    AND tenant_id=public.app_current_tenant_id_uuid()
  );
