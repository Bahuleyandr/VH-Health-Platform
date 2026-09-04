-- 765_cath_device_reuse.sql
--
-- Cath-lab device reuse (spec docs/superpowers/specs/2026-09-04-cath-device-reuse-and-bloodborne-markers-design.md).
-- Indian cath labs reprocess and reuse catheters, guidewires, balloons and
-- sheaths; stents, pacemakers, leads and closure devices are never reused.
-- Until now a cath usage row could only bind to a stock batch, and migration
-- 753 obliged every non-terminal usage to carry a pharmacy shortfall task, so a
-- reused device could not be recorded truthfully.
--
-- This migration adds, forward-only:
--   * cath_reprocessing_settings            — per tenant: blood-borne rules + serology window
--   * cath_reprocessing_category_policies   — per tenant per category: reprocessable, max cycles
--   * cath_reprocessable_devices            — the device register (system-minted tag, cycle count)
--   * cath_case_consumable_usage            — device_id, reuse_cycle, post_use_disposition,
--                                             reuse_screen, post_use_screen; status value
--                                             'reused_device'; shape CHECK; the 753 exact-authority
--                                             CHECK re-added with a third arm
--   * cath_consumable_catalog               — reused_billing_item_code
--   * cath_inventory_authority_assert_contract_753 re-declared exactly as 758
--     re-declared it, plus one branch: a 'reused_device' usage must reference a
--     device of the same catalogue item and carry no stock movement, no
--     shortfall task and no SLA. Every other branch is byte-identical to 758.
--     Migrations 753 and 758 are not edited.
--
-- Ballot 753-D1 (every new-unit use is a shortfall task, or only actual
-- shortfalls) is NOT decided here. Reused devices are exempt whichever way the
-- owner votes; the ballot now concerns new units only.
--
-- NOT VALID: chk_cath_usage_exact_inventory_authority_753 was NOT VALID in 753
-- because legacy rows may violate its first two arms. It is dropped and re-added
-- NOT VALID here with a third arm for reused devices, for the same reason. It is
-- not meant to stay unvalidated (OPEN-15 class). Validate in a follow-up once:
--
--   SELECT count(*) FROM cath_case_consumable_usage u
--    WHERE NOT (
--      (u.facility_id IS NOT NULL AND u.inventory_item_id IS NOT NULL AND u.inventory_batch_id IS NOT NULL)
--      OR (u.inventory_decrement_status = 'not_applicable'
--          AND u.metadata->'authority_recovery'->>'action' IN ('PRESERVE','CANCEL')
--          AND u.facility_id IS NULL AND u.inventory_item_id IS NULL
--          AND u.inventory_batch_id IS NULL AND u.inventory_movement_id IS NULL)
--      OR (u.inventory_decrement_status = 'reused_device' AND u.device_id IS NOT NULL
--          AND u.facility_id IS NOT NULL AND u.inventory_item_id IS NOT NULL
--          AND u.inventory_batch_id IS NULL AND u.inventory_movement_id IS NULL));
--
--   ALTER TABLE cath_case_consumable_usage
--     VALIDATE CONSTRAINT chk_cath_usage_exact_inventory_authority_753;
--
-- On a freshly migrated database the count is 0 immediately.
--
-- Every CHECK is named explicitly, for the reason migration 764 records:
-- Postgres auto-names a single-column check <table>_<column>_check but a
-- multi-column check <table>_check, <table>_check1, … — positional suffixes
-- that renumber when a check is added or removed.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';

-- ---------------------------------------------------------------------------
-- 1. Tenant settings
-- ---------------------------------------------------------------------------
CREATE TABLE cath_reprocessing_settings (
  tenant_id UUID PRIMARY KEY DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ) REFERENCES tenants(id) ON DELETE CASCADE,
  reactive_patient_rule VARCHAR(24) NOT NULL DEFAULT 'discard',
  unknown_serology_rule VARCHAR(24) NOT NULL DEFAULT 'warn',
  serology_validity_days INTEGER NOT NULL DEFAULT 90,
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ(6),
  updated_by UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT cath_reprocessing_settings_reactive_rule_check
    CHECK (reactive_patient_rule IN ('discard', 'override_allowed')),
  CONSTRAINT cath_reprocessing_settings_unknown_rule_check
    CHECK (unknown_serology_rule IN ('warn', 'block_return')),
  CONSTRAINT cath_reprocessing_settings_validity_check
    CHECK (serology_validity_days BETWEEN 1 AND 365)
);

-- ---------------------------------------------------------------------------
-- 2. Category policies
-- ---------------------------------------------------------------------------
CREATE TABLE cath_reprocessing_category_policies (
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ) REFERENCES tenants(id) ON DELETE CASCADE,
  category VARCHAR(40) NOT NULL,
  reprocessable BOOLEAN NOT NULL DEFAULT FALSE,
  max_cycles INTEGER,
  allowed_cycle_types TEXT[] NOT NULL DEFAULT '{}'::text[],
  function_check_required BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT cath_reprocessing_category_policies_pkey PRIMARY KEY (tenant_id, category),
  CONSTRAINT cath_reprocessing_category_policies_category_check
    CHECK (category IN ('stent', 'balloon', 'guidewire', 'catheter', 'sheath',
                        'closure_device', 'pacemaker', 'lead', 'other')),
  CONSTRAINT cath_reprocessing_category_policies_implant_check
    CHECK (category NOT IN ('stent', 'pacemaker', 'lead', 'closure_device') OR reprocessable = FALSE),
  CONSTRAINT cath_reprocessing_category_policies_max_cycles_check
    CHECK (max_cycles IS NULL OR max_cycles BETWEEN 1 AND 50),
  CONSTRAINT cath_reprocessing_category_policies_cycle_types_check
    CHECK (allowed_cycle_types <@ ARRAY['steam', 'eto', 'plasma', 'dry_heat', 'chemical', 'other']::text[]),
  CONSTRAINT cath_reprocessing_category_policies_complete_check
    CHECK (reprocessable = FALSE OR (max_cycles IS NOT NULL AND cardinality(allowed_cycle_types) >= 1))
);

-- ---------------------------------------------------------------------------
-- 3. Device register (no patient identity; patient linkage lives on usage rows)
--
-- Every reference out of this table is tenant-pinned as a composite
-- (tenant_id, <column>) foreign key, so a device can never bind to another
-- tenant's facility, catalogue entry or usage row. Neither parent carried a
-- plain (tenant_id, id) unique — cath_consumable_catalog's existing composites
-- are wider ((tenant_id, id, batch_tracked, is_implant) and
-- (tenant_id, facility_id, id, inventory_item_id)) and
-- cath_case_consumable_usage's is (tenant_id, id, case_id, patient_uid) — so
-- the two indexes below are created first. `id` is each table's primary key,
-- so both are trivially satisfiable. facilities already has
-- ux_facilities_tenant_id.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX ux_cath_consumable_catalog_tenant_id
  ON cath_consumable_catalog (tenant_id, id);
CREATE UNIQUE INDEX ux_cath_case_consumable_usage_tenant_id
  ON cath_case_consumable_usage (tenant_id, id);

CREATE TABLE cath_reprocessable_devices (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  facility_id INTEGER NOT NULL,
  catalog_item_id BIGINT NOT NULL REFERENCES cath_consumable_catalog(id) ON DELETE RESTRICT,
  device_tag VARCHAR(24) GENERATED ALWAYS AS ('RP' || lpad(id::text, 8, '0')) STORED,
  origin_usage_id BIGINT NOT NULL REFERENCES cath_case_consumable_usage(id) ON DELETE RESTRICT,
  origin_unit_index SMALLINT NOT NULL DEFAULT 1,
  cycle_count INTEGER NOT NULL DEFAULT 0,
  max_cycles_snapshot INTEGER NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'awaiting_reprocessing',
  current_usage_id BIGINT REFERENCES cath_case_consumable_usage(id) ON DELETE SET NULL,
  exposure_flag BOOLEAN NOT NULL DEFAULT FALSE,
  exposure_markers TEXT[] NOT NULL DEFAULT '{}'::text[],
  last_reprocessed_at TIMESTAMPTZ(6),
  last_reprocessed_by UUID,
  last_cycle_type VARCHAR(20),
  last_function_check VARCHAR(16),
  quarantine_reason TEXT,
  quarantined_at TIMESTAMPTZ(6),
  discard_reason VARCHAR(40),
  discard_note TEXT,
  discarded_at TIMESTAMPTZ(6),
  discarded_by UUID,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT fk_cath_reprocessable_devices_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE NO ACTION,
  CONSTRAINT fk_cath_reprocessable_devices_facility
    FOREIGN KEY (tenant_id, facility_id) REFERENCES facilities (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_cath_reprocessable_devices_catalog
    FOREIGN KEY (tenant_id, catalog_item_id)
    REFERENCES cath_consumable_catalog (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_cath_reprocessable_devices_origin_usage
    FOREIGN KEY (tenant_id, origin_usage_id)
    REFERENCES cath_case_consumable_usage (tenant_id, id) ON DELETE RESTRICT,
  -- ON DELETE SET NULL on a composite foreign key nulls EVERY member column,
  -- and tenant_id is NOT NULL — the delete would raise 23502 instead of
  -- releasing the device. The single-column current_usage_id reference above
  -- carries the SET NULL; this composite exists only to pin the tenant, so it
  -- is NO ACTION and is satisfied by the row the other action has already
  -- nulled.
  CONSTRAINT fk_cath_reprocessable_devices_current_usage
    FOREIGN KEY (tenant_id, current_usage_id)
    REFERENCES cath_case_consumable_usage (tenant_id, id) ON DELETE NO ACTION,
  CONSTRAINT cath_reprocessable_devices_unit_index_check CHECK (origin_unit_index >= 1),
  CONSTRAINT cath_reprocessable_devices_cycle_check CHECK (cycle_count >= 0),
  CONSTRAINT cath_reprocessable_devices_max_cycles_check CHECK (max_cycles_snapshot >= 1),
  CONSTRAINT cath_reprocessable_devices_cycle_bound_check CHECK (cycle_count <= max_cycles_snapshot),
  CONSTRAINT cath_reprocessable_devices_status_check
    CHECK (status IN ('awaiting_reprocessing', 'in_cssd', 'available', 'in_case', 'quarantined', 'discarded')),
  CONSTRAINT cath_reprocessable_devices_in_case_check
    CHECK (status <> 'in_case' OR current_usage_id IS NOT NULL),
  CONSTRAINT cath_reprocessable_devices_cycle_type_check
    CHECK (last_cycle_type IS NULL OR last_cycle_type IN ('steam', 'eto', 'plasma', 'dry_heat', 'chemical', 'other')),
  CONSTRAINT cath_reprocessable_devices_function_check_check
    CHECK (last_function_check IS NULL OR last_function_check IN ('not_required', 'pass', 'fail')),
  CONSTRAINT cath_reprocessable_devices_discard_reason_check
    CHECK (discard_reason IS NULL OR discard_reason IN (
      'max_cycles_reached', 'bloodborne_exposure', 'late_reactive_marker', 'function_check_failed',
      'sterilization_failed', 'damaged', 'wasted', 'policy_change', 'other')),
  CONSTRAINT cath_reprocessable_devices_discarded_check
    CHECK (status <> 'discarded' OR (discard_reason IS NOT NULL AND discarded_at IS NOT NULL)),
  CONSTRAINT ux_cath_reprocessable_devices_origin UNIQUE (origin_usage_id, origin_unit_index)
);

CREATE UNIQUE INDEX ux_cath_reprocessable_devices_tag ON cath_reprocessable_devices (tenant_id, device_tag);
-- The tenant-pinned target for cath_case_consumable_usage.device_id below.
CREATE UNIQUE INDEX ux_cath_reprocessable_devices_tenant_id ON cath_reprocessable_devices (tenant_id, id);
CREATE INDEX idx_cath_reprocessable_devices_status ON cath_reprocessable_devices (tenant_id, status);
CREATE INDEX idx_cath_reprocessable_devices_facility ON cath_reprocessable_devices (tenant_id, facility_id, status);
CREATE INDEX idx_cath_reprocessable_devices_catalog ON cath_reprocessable_devices (tenant_id, catalog_item_id, status);

-- ---------------------------------------------------------------------------
-- 4. Usage row: reused-device columns, status value, shape checks
-- ---------------------------------------------------------------------------
ALTER TABLE cath_case_consumable_usage
  ADD COLUMN device_id BIGINT REFERENCES cath_reprocessable_devices(id) ON DELETE RESTRICT,
  ADD COLUMN reuse_cycle INTEGER,
  ADD COLUMN post_use_disposition VARCHAR(32),
  ADD COLUMN reuse_screen JSONB,
  ADD COLUMN post_use_screen JSONB;

ALTER TABLE cath_case_consumable_usage
  ADD CONSTRAINT fk_cath_consumable_usage_device
    FOREIGN KEY (tenant_id, device_id)
    REFERENCES cath_reprocessable_devices (tenant_id, id) ON DELETE NO ACTION,
  DROP CONSTRAINT IF EXISTS cath_consumable_usage_inventory_status_check,
  ADD CONSTRAINT cath_consumable_usage_inventory_status_check
    CHECK (inventory_decrement_status IN (
      'pending', 'not_linked', 'decremented', 'insufficient_stock', 'error',
      'not_applicable', 'reused_device'
    )),
  ADD CONSTRAINT cath_consumable_usage_reuse_cycle_check
    CHECK (reuse_cycle IS NULL OR reuse_cycle >= 1),
  ADD CONSTRAINT cath_consumable_usage_post_use_check
    CHECK (post_use_disposition IS NULL OR post_use_disposition IN (
      'sent_for_reprocessing', 'discarded_bloodborne_exposure', 'discarded_max_cycles',
      'discarded_wasted', 'discarded_other', 'not_reprocessable')),
  ADD CONSTRAINT cath_consumable_usage_reused_device_shape_check
    CHECK (
      ((inventory_decrement_status = 'reused_device') = (device_id IS NOT NULL AND reuse_cycle IS NOT NULL))
      AND (inventory_decrement_status <> 'reused_device'
           OR (inventory_batch_id IS NULL AND inventory_movement_id IS NULL))
    ),
  DROP CONSTRAINT IF EXISTS chk_cath_usage_exact_inventory_authority_753,
  ADD CONSTRAINT chk_cath_usage_exact_inventory_authority_753
    CHECK (
      (facility_id IS NOT NULL AND inventory_item_id IS NOT NULL AND inventory_batch_id IS NOT NULL)
      OR (
        inventory_decrement_status = 'not_applicable'
        AND metadata->'authority_recovery'->>'action' IN ('PRESERVE', 'CANCEL')
        AND facility_id IS NULL AND inventory_item_id IS NULL
        AND inventory_batch_id IS NULL AND inventory_movement_id IS NULL
      )
      OR (
        inventory_decrement_status = 'reused_device'
        AND device_id IS NOT NULL
        AND facility_id IS NOT NULL AND inventory_item_id IS NOT NULL
        AND inventory_batch_id IS NULL AND inventory_movement_id IS NULL
      )
    ) NOT VALID;

CREATE INDEX idx_cath_consumable_usage_device ON cath_case_consumable_usage (tenant_id, device_id)
  WHERE device_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 5. Catalogue: reprocessed tariff code
-- ---------------------------------------------------------------------------
ALTER TABLE cath_consumable_catalog
  ADD COLUMN reused_billing_item_code VARCHAR(50);

-- ---------------------------------------------------------------------------
-- 6. RLS on the three new tables
-- ---------------------------------------------------------------------------
ALTER TABLE cath_reprocessing_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE cath_reprocessing_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON cath_reprocessing_settings;
CREATE POLICY tenant_isolation ON cath_reprocessing_settings
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  );

ALTER TABLE cath_reprocessing_category_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE cath_reprocessing_category_policies FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON cath_reprocessing_category_policies;
CREATE POLICY tenant_isolation ON cath_reprocessing_category_policies
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  );

ALTER TABLE cath_reprocessable_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE cath_reprocessable_devices FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON cath_reprocessable_devices;
CREATE POLICY tenant_isolation ON cath_reprocessable_devices
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  );

-- ---------------------------------------------------------------------------
-- 6b. Runtime-role grants
--
-- Same to_regrole-guarded shape as migration 764: skip a role the deployment
-- never provisioned, so this is a no-op on a single-DSN rig. All three tables
-- are operator- and CSSD-maintained records that are updated in place (a
-- settings review, a policy edit, a device's cycle count and status), so the
-- contract is SELECT + INSERT + UPDATE; DELETE and TRUNCATE stay revoked
-- because a device register that can be deleted is not a register.
--
-- This block alone is not the whole story. A tracker-driven migration runs once
-- per database, so on a cluster where the runtime role is provisioned later
-- (CNPG reconciles spec.managed.roles after the first migration pass) the
-- to_regrole guard would skip these grants forever. The boot-time bootstrap in
-- src/lib/prisma.js (ensureTenantRlsRuntimeRoleGrants) re-narrows the runtime
-- role's privileges on EVERY boot after its broad late-provisioning fallback
-- grants, so a table that is not registered there silently keeps those broad
-- privileges. All three tables are registered in that bootstrap's
-- runtime_mutable_no_delete_relations list and
-- cath_reprocessable_devices_id_seq in its runtime_nextval_sequences list.
-- ---------------------------------------------------------------------------
DO $cath_device_reuse_runtime_grants$
DECLARE
  role_name TEXT;
  table_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['vhhealth_app', 'vhhealth_runtime']::TEXT[] LOOP
    IF pg_catalog.to_regrole(role_name) IS NOT NULL THEN
      FOREACH table_name IN ARRAY ARRAY[
        'cath_reprocessing_settings',
        'cath_reprocessing_category_policies',
        'cath_reprocessable_devices'
      ]::TEXT[] LOOP
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE %I TO %I', table_name, role_name);
        EXECUTE format('REVOKE DELETE, TRUNCATE ON TABLE %I FROM %I', table_name, role_name);
      END LOOP;
      EXECUTE format(
        'GRANT USAGE, SELECT ON SEQUENCE cath_reprocessable_devices_id_seq TO %I',
        role_name
      );
      EXECUTE format(
        'REVOKE UPDATE ON SEQUENCE cath_reprocessable_devices_id_seq FROM %I',
        role_name
      );
    END IF;
  END LOOP;
END
$cath_device_reuse_runtime_grants$;

-- ---------------------------------------------------------------------------
-- 7. Re-declare the 753 assert function (body copied from 758 + the reused branch)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cath_inventory_authority_assert_contract_753(target_tenant_id uuid, target_usage_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
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

  -- 765: a reused reprocessable device consumes no stock and owes no pharmacy
  -- shortfall obligation (spec 2026-09-04 sec 8). Independent of ballot 753-D1.
  -- The task, SLA and movement lookups repeat the exact column names, literals
  -- and ::text casts the identity assertion below already uses.
  IF usage_record.inventory_decrement_status='reused_device' THEN
    IF usage_record.device_id IS NULL
       OR usage_record.reuse_cycle IS NULL
       OR usage_record.inventory_batch_id IS NOT NULL
       OR usage_record.inventory_movement_id IS NOT NULL
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
       OR EXISTS (
         SELECT 1
           FROM public.tasks task
          WHERE task.tenant_id=usage_record.tenant_id
            AND task.related_resource_type='cath_case_consumable_usage'
            AND task.related_resource_id=usage_record.id::text
            AND task.metadata->>'task_contract'='cath_inventory_shortfall_v1'
       )
       OR EXISTS (
         SELECT 1
           FROM public.workflow_sla_instances sla
          WHERE sla.tenant_id=usage_record.tenant_id
            AND sla.rule_code='cath_consumable_inventory_reconciliation'
            AND sla.source_table='cath_case_consumable_usage'
            AND sla.source_id=usage_record.id::text
       )
       OR NOT EXISTS (
         SELECT 1
           FROM public.cath_reprocessable_devices device
          WHERE device.id=usage_record.device_id
            AND device.tenant_id=usage_record.tenant_id
            AND device.catalog_item_id=usage_record.catalog_item_id
       )
    THEN
      RAISE EXCEPTION 'Reused device usage carries inventory or shortfall artefacts'
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
$function$;

COMMIT;
