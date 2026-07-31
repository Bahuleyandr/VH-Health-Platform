-- C6.1-A: canonical external-interface recovery substrate and I10 cold-chain
-- adapter integrity. Workers remain paused; this migration does not activate
-- any interface.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '180s';

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Canonical per-consumer cursor: retain pathway control rows and add explicit
-- tenant-scoped external-interface rows without introducing another ledger.
-- ---------------------------------------------------------------------------

ALTER TABLE public.event_consumer_offsets
  ADD COLUMN offset_id UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN scope_kind VARCHAR(32) NOT NULL DEFAULT 'pathway_registry',
  ADD COLUMN tenant_id UUID,
  ADD COLUMN facility_scope VARCHAR(16),
  ADD COLUMN facility_id INTEGER,
  ADD COLUMN interface_family VARCHAR(8),
  ADD COLUMN direction VARCHAR(16),
  ADD COLUMN source_partition VARCHAR(160),
  ADD COLUMN cursor_kind VARCHAR(40),
  ADD COLUMN high_water_position BIGINT,
  ADD COLUMN high_water_token VARCHAR(255),
  ADD COLUMN retained_from_position BIGINT,
  ADD COLUMN retained_from_token VARCHAR(255),
  ADD COLUMN resume_cutoff_position BIGINT,
  ADD COLUMN resume_cutoff_token VARCHAR(255),
  ADD COLUMN recovery_state VARCHAR(80),
  ADD COLUMN reconciliation_reason VARCHAR(160),
  ADD COLUMN policy_version VARCHAR(80),
  ADD COLUMN policy_signature VARCHAR(128),
  ADD COLUMN retention_policy VARCHAR(80),
  ADD COLUMN retention_until TIMESTAMPTZ(6);

ALTER TABLE public.event_consumer_offsets
  ALTER COLUMN historical_cutoff_event_id DROP NOT NULL,
  ALTER COLUMN backfill_cursor_event_id DROP NOT NULL,
  DROP CONSTRAINT event_consumer_offsets_pkey,
  ADD CONSTRAINT event_consumer_offsets_pkey PRIMARY KEY (offset_id),
  ADD CONSTRAINT fk_event_consumer_offsets_tenant
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT fk_event_consumer_offsets_facility
    FOREIGN KEY (tenant_id, facility_id)
    REFERENCES public.facilities(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT chk_event_consumer_offsets_scope_kind
    CHECK (scope_kind IN ('pathway_registry', 'external_interface')),
  ADD CONSTRAINT chk_event_consumer_offsets_external_state
    CHECK (
      recovery_state IS NULL
      OR recovery_state IN (
        'paused',
        'ready',
        'replaying',
        'reconciliation_required_missing_marker',
        'reconciliation_required_retention_gap',
        'reconciliation_required_source_gap',
        'retired'
      )
    ),
  ADD CONSTRAINT chk_event_consumer_offsets_external_direction
    CHECK (direction IS NULL OR direction IN ('inbound', 'outbound')),
  ADD CONSTRAINT chk_event_consumer_offsets_position_order
    CHECK (
      retained_from_position IS NULL
      OR resume_cutoff_position IS NULL
      OR retained_from_position <= resume_cutoff_position
    ),
  ADD CONSTRAINT chk_event_consumer_offsets_row_shape
    CHECK (
      (
        scope_kind = 'pathway_registry'
        AND tenant_id IS NULL
        AND facility_scope IS NULL
        AND facility_id IS NULL
        AND interface_family IS NULL
        AND direction IS NULL
        AND source_partition IS NULL
        AND cursor_kind IS NULL
        AND high_water_position IS NULL
        AND high_water_token IS NULL
        AND retained_from_position IS NULL
        AND retained_from_token IS NULL
        AND resume_cutoff_position IS NULL
        AND resume_cutoff_token IS NULL
        AND recovery_state IS NULL
        AND reconciliation_reason IS NULL
        AND policy_version IS NULL
        AND policy_signature IS NULL
        AND retention_policy IS NULL
        AND retention_until IS NULL
        AND historical_cutoff_event_id IS NOT NULL
        AND backfill_cursor_event_id IS NOT NULL
      )
      OR
      (
        scope_kind = 'external_interface'
        AND tenant_id IS NOT NULL
        AND tenant_id <> '00000000-0000-4000-8000-000000000001'::uuid
        AND facility_scope IN ('tenant', 'facility')
        AND (
          (facility_scope = 'tenant' AND facility_id IS NULL)
          OR (facility_scope = 'facility' AND facility_id IS NOT NULL)
        )
        AND interface_family IS NOT NULL
        AND direction IS NOT NULL
        AND source_partition IS NOT NULL
        AND cursor_kind IS NOT NULL
        AND recovery_state IS NOT NULL
        AND policy_version IS NOT NULL
        AND policy_signature IS NOT NULL
        AND retention_policy IS NOT NULL
        AND retention_until IS NOT NULL
        AND historical_cutoff_event_id IS NULL
        AND backfill_cursor_event_id IS NULL
        AND backfill_completed_at IS NULL
      )
    ) NOT VALID;

ALTER TABLE public.event_consumer_offsets
  VALIDATE CONSTRAINT chk_event_consumer_offsets_row_shape;

DROP INDEX public.uq_event_consumer_offsets_live_consumer;

CREATE UNIQUE INDEX uq_event_consumer_offsets_pathway_generation
  ON public.event_consumer_offsets (consumer_key, generation)
  WHERE scope_kind = 'pathway_registry';

CREATE UNIQUE INDEX uq_event_consumer_offsets_live_consumer
  ON public.event_consumer_offsets (consumer_key)
  WHERE scope_kind = 'pathway_registry' AND intake_retired_at IS NULL;

CREATE UNIQUE INDEX uq_event_consumer_offsets_external_generation
  ON public.event_consumer_offsets
    (tenant_id, interface_family, direction, source_partition, generation)
  WHERE scope_kind = 'external_interface';

CREATE UNIQUE INDEX uq_event_consumer_offsets_external_live
  ON public.event_consumer_offsets
    (tenant_id, interface_family, direction, source_partition)
  WHERE scope_kind = 'external_interface' AND intake_retired_at IS NULL;

CREATE UNIQUE INDEX ux_event_consumer_offsets_tenant_offset
  ON public.event_consumer_offsets (tenant_id, offset_id);

ALTER TABLE public.event_consumer_offsets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_consumer_offsets FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON public.event_consumer_offsets;
CREATE POLICY tenant_isolation
  ON public.event_consumer_offsets
  AS PERMISSIVE
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS external_interface_tenant_isolation
  ON public.event_consumer_offsets;
CREATE POLICY external_interface_tenant_isolation
  ON public.event_consumer_offsets
  AS RESTRICTIVE
  USING (
    (
      scope_kind = 'external_interface'
      AND current_setting('app.current_tenant_id', true) IS NOT NULL
      AND current_setting('app.current_tenant_id', true) <> ''
      AND current_setting('app.current_tenant_id', true) <> 'bypass'
      AND tenant_id = public.app_current_tenant_id_uuid()
    )
    OR (
      scope_kind = 'pathway_registry'
      AND current_user = pg_catalog.pg_get_userbyid(
        (
          SELECT relation.relowner
            FROM pg_catalog.pg_class AS relation
           WHERE relation.oid =
             'public.event_consumer_offsets'::pg_catalog.regclass
        )
      )
    )
  )
  WITH CHECK (
    (
      scope_kind = 'external_interface'
      AND current_setting('app.current_tenant_id', true) IS NOT NULL
      AND current_setting('app.current_tenant_id', true) <> ''
      AND current_setting('app.current_tenant_id', true) <> 'bypass'
      AND tenant_id = public.app_current_tenant_id_uuid()
    )
    OR (
      scope_kind = 'pathway_registry'
      AND current_user = pg_catalog.pg_get_userbyid(
        (
          SELECT relation.relowner
            FROM pg_catalog.pg_class AS relation
           WHERE relation.oid =
             'public.event_consumer_offsets'::pg_catalog.regclass
        )
      )
    )
  );

-- Pathway offset lifecycle is a global control-plane operation. These functions
-- expose only pathway_registry rows and leave external rows to tenant-pinned
-- table access.
CREATE OR REPLACE FUNCTION public.pathway_projector_offset_get(
  p_consumer_key TEXT,
  p_generation INTEGER,
  p_lock BOOLEAN DEFAULT FALSE
)
RETURNS SETOF public.event_consumer_offsets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_lock THEN
    RETURN QUERY
      SELECT offsets.*
        FROM public.event_consumer_offsets AS offsets
       WHERE offsets.scope_kind OPERATOR(pg_catalog.=) 'pathway_registry'
         AND offsets.consumer_key OPERATOR(pg_catalog.=) p_consumer_key
         AND offsets.generation OPERATOR(pg_catalog.=) p_generation
       FOR UPDATE;
  ELSE
    RETURN QUERY
      SELECT offsets.*
        FROM public.event_consumer_offsets AS offsets
       WHERE offsets.scope_kind OPERATOR(pg_catalog.=) 'pathway_registry'
         AND offsets.consumer_key OPERATOR(pg_catalog.=) p_consumer_key
         AND offsets.generation OPERATOR(pg_catalog.=) p_generation;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.pathway_projector_offsets_list(
  p_consumer_key TEXT,
  p_lock BOOLEAN DEFAULT FALSE
)
RETURNS SETOF public.event_consumer_offsets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_lock THEN
    RETURN QUERY
      SELECT offsets.*
        FROM public.event_consumer_offsets AS offsets
       WHERE offsets.scope_kind OPERATOR(pg_catalog.=) 'pathway_registry'
         AND offsets.consumer_key OPERATOR(pg_catalog.=) p_consumer_key
       ORDER BY offsets.generation
       FOR UPDATE;
  ELSE
    RETURN QUERY
      SELECT offsets.*
        FROM public.event_consumer_offsets AS offsets
       WHERE offsets.scope_kind OPERATOR(pg_catalog.=) 'pathway_registry'
         AND offsets.consumer_key OPERATOR(pg_catalog.=) p_consumer_key
       ORDER BY offsets.generation;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.pathway_projector_offset_register(
  p_consumer_key TEXT,
  p_generation INTEGER,
  p_historical_cutoff_event_id BIGINT,
  p_backfill_completed BOOLEAN
)
RETURNS SETOF public.event_consumer_offsets
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  INSERT INTO public.event_consumer_offsets
    (scope_kind, consumer_key, generation, historical_cutoff_event_id,
     backfill_cursor_event_id, backfill_completed_at)
  VALUES
    ('pathway_registry', p_consumer_key, p_generation,
     p_historical_cutoff_event_id, 0,
     CASE WHEN p_backfill_completed THEN pg_catalog.now() ELSE NULL END)
  RETURNING *
$$;

CREATE OR REPLACE FUNCTION public.pathway_projector_offset_retire(
  p_consumer_key TEXT,
  p_generation INTEGER
)
RETURNS SETOF public.event_consumer_offsets
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  UPDATE public.event_consumer_offsets
     SET intake_retired_at = pg_catalog.now(),
         updated_at = pg_catalog.now()
   WHERE scope_kind = 'pathway_registry'
     AND consumer_key = p_consumer_key
     AND generation = p_generation
     AND intake_retired_at IS NULL
  RETURNING *
$$;

CREATE OR REPLACE FUNCTION public.pathway_projector_offset_advance(
  p_consumer_key TEXT,
  p_generation INTEGER,
  p_cursor BIGINT,
  p_completed BOOLEAN
)
RETURNS SETOF public.event_consumer_offsets
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  UPDATE public.event_consumer_offsets
     SET backfill_cursor_event_id = p_cursor,
         backfill_completed_at = CASE
           WHEN p_completed THEN COALESCE(backfill_completed_at, pg_catalog.now())
           ELSE backfill_completed_at
         END,
         updated_at = pg_catalog.now()
   WHERE scope_kind = 'pathway_registry'
     AND consumer_key = p_consumer_key
     AND generation = p_generation
  RETURNING *
$$;

-- ---------------------------------------------------------------------------
-- Canonical inbox: preserve pathway rows and add immutable external identities,
-- duplicate fingerprints, occurrence time, leases, and typed outcomes.
-- ---------------------------------------------------------------------------

ALTER TABLE public.pathway_projector_inbox
  ADD COLUMN inbox_id UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN scope_kind VARCHAR(32) NOT NULL DEFAULT 'pathway_registry',
  ADD COLUMN offset_id UUID,
  ADD COLUMN facility_id INTEGER,
  ADD COLUMN interface_family VARCHAR(8),
  ADD COLUMN direction VARCHAR(16),
  ADD COLUMN source_partition VARCHAR(160),
  ADD COLUMN source_position BIGINT,
  ADD COLUMN source_token VARCHAR(255),
  ADD COLUMN predecessor_token VARCHAR(255),
  ADD COLUMN duplicate_key VARCHAR(255),
  ADD COLUMN command_fingerprint CHAR(64),
  ADD COLUMN occurred_at TIMESTAMPTZ(6),
  ADD COLUMN received_at TIMESTAMPTZ(6),
  ADD COLUMN recorded_at TIMESTAMPTZ(6),
  ADD COLUMN arrival_class VARCHAR(32),
  ADD COLUMN effect_disposition VARCHAR(32),
  ADD COLUMN outcome_code VARCHAR(80),
  ADD COLUMN pending_task_id INTEGER,
  ADD COLUMN policy_version VARCHAR(80),
  ADD COLUMN policy_signature VARCHAR(128),
  ADD COLUMN retention_policy VARCHAR(80),
  ADD COLUMN retention_until TIMESTAMPTZ(6);

ALTER TABLE public.pathway_projector_inbox
  DROP CONSTRAINT pathway_projector_inbox_pkey;

ALTER TABLE public.pathway_projector_inbox
  ALTER COLUMN event_id DROP NOT NULL,
  DROP CONSTRAINT pathway_projector_inbox_status_check,
  ADD CONSTRAINT pathway_projector_inbox_pkey PRIMARY KEY (inbox_id),
  ADD CONSTRAINT pathway_projector_inbox_status_check
    CHECK (status IN ('pending', 'handled', 'ignored', 'dead')),
  ADD CONSTRAINT chk_pathway_projector_inbox_scope_kind
    CHECK (scope_kind IN ('pathway_registry', 'external_interface')),
  ADD CONSTRAINT chk_pathway_projector_inbox_arrival_class
    CHECK (
      arrival_class IS NULL
      OR arrival_class IN ('live', 'recovery_backlog', 'unknown')
    ),
  ADD CONSTRAINT chk_pathway_projector_inbox_effect_disposition
    CHECK (
      effect_disposition IS NULL
      OR effect_disposition IN ('normal', 'late_pending_only', 'signed_exception')
    ),
  ADD CONSTRAINT chk_pathway_projector_inbox_fingerprint
    CHECK (
      command_fingerprint IS NULL
      OR command_fingerprint ~ '^[0-9a-f]{64}$'
    ),
  ADD CONSTRAINT chk_pathway_projector_inbox_external_pending_work
    CHECK (
      scope_kind <> 'external_interface'
      OR effect_disposition <> 'late_pending_only'
      OR status <> 'handled'
      OR pending_task_id IS NOT NULL
    ),
  ADD CONSTRAINT chk_pathway_projector_inbox_row_shape
    CHECK (
      (
        scope_kind = 'pathway_registry'
        AND event_id IS NOT NULL
        AND offset_id IS NULL
        AND facility_id IS NULL
        AND interface_family IS NULL
        AND direction IS NULL
        AND source_partition IS NULL
        AND source_position IS NULL
        AND source_token IS NULL
        AND predecessor_token IS NULL
        AND duplicate_key IS NULL
        AND command_fingerprint IS NULL
        AND occurred_at IS NULL
        AND received_at IS NULL
        AND recorded_at IS NULL
        AND arrival_class IS NULL
        AND effect_disposition IS NULL
        AND pending_task_id IS NULL
        AND policy_version IS NULL
        AND policy_signature IS NULL
        AND retention_policy IS NULL
        AND retention_until IS NULL
      )
      OR
      (
        scope_kind = 'external_interface'
        AND tenant_id <> '00000000-0000-4000-8000-000000000001'::uuid
        AND event_id IS NULL
        AND offset_id IS NOT NULL
        AND interface_family IS NOT NULL
        AND direction IS NOT NULL
        AND source_partition IS NOT NULL
        AND source_position IS NOT NULL
        AND source_token IS NOT NULL
        AND duplicate_key IS NOT NULL
        AND command_fingerprint IS NOT NULL
        AND occurred_at IS NOT NULL
        AND received_at IS NOT NULL
        AND recorded_at IS NOT NULL
        AND arrival_class IS NOT NULL
        AND effect_disposition IS NOT NULL
        AND policy_version IS NOT NULL
        AND policy_signature IS NOT NULL
        AND retention_policy IS NOT NULL
        AND retention_until IS NOT NULL
      )
    ) NOT VALID,
  ADD CONSTRAINT fk_pathway_projector_inbox_offset
    FOREIGN KEY (tenant_id, offset_id)
    REFERENCES public.event_consumer_offsets(tenant_id, offset_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT fk_pathway_projector_inbox_facility
    FOREIGN KEY (tenant_id, facility_id)
    REFERENCES public.facilities(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT fk_pathway_projector_inbox_pending_task
    FOREIGN KEY (tenant_id, pending_task_id)
    REFERENCES public.tasks(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION;

ALTER TABLE public.pathway_projector_inbox
  VALIDATE CONSTRAINT chk_pathway_projector_inbox_row_shape;

CREATE UNIQUE INDEX uq_pathway_projector_inbox_pathway_event
  ON public.pathway_projector_inbox
    (tenant_id, consumer_key, generation, event_id)
  WHERE scope_kind = 'pathway_registry';

CREATE UNIQUE INDEX uq_pathway_projector_inbox_external_duplicate
  ON public.pathway_projector_inbox
    (tenant_id, interface_family, direction, source_partition, duplicate_key)
  WHERE scope_kind = 'external_interface';

CREATE UNIQUE INDEX uq_pathway_projector_inbox_external_position
  ON public.pathway_projector_inbox
    (tenant_id, offset_id, generation, source_position)
  WHERE scope_kind = 'external_interface';

CREATE UNIQUE INDEX ux_pathway_projector_inbox_recovery_contract
  ON public.pathway_projector_inbox
    (tenant_id, inbox_id, occurred_at, command_fingerprint, effect_disposition);

CREATE UNIQUE INDEX ux_pathway_projector_inbox_facility_identity
  ON public.pathway_projector_inbox (tenant_id, inbox_id, facility_id);

CREATE INDEX idx_pathway_projector_inbox_external_due
  ON public.pathway_projector_inbox
    (tenant_id, offset_id, source_position, next_attempt_at)
  WHERE scope_kind = 'external_interface' AND status = 'pending';

DROP POLICY IF EXISTS tenant_isolation ON public.pathway_projector_inbox;
CREATE POLICY tenant_isolation ON public.pathway_projector_inbox
  AS PERMISSIVE
  USING (
    (
      scope_kind = 'pathway_registry'
      AND (
        current_setting('app.current_tenant_id', true) IS NULL
        OR current_setting('app.current_tenant_id', true) = ''
        OR current_setting('app.current_tenant_id', true) = 'bypass'
        OR tenant_id = public.app_current_tenant_id_uuid()
      )
    )
    OR (
      scope_kind = 'external_interface'
      AND current_setting('app.current_tenant_id', true) IS NOT NULL
      AND current_setting('app.current_tenant_id', true) <> ''
      AND current_setting('app.current_tenant_id', true) <> 'bypass'
      AND tenant_id = public.app_current_tenant_id_uuid()
    )
  )
  WITH CHECK (
    (
      scope_kind = 'pathway_registry'
      AND (
        current_setting('app.current_tenant_id', true) IS NULL
        OR current_setting('app.current_tenant_id', true) = ''
        OR current_setting('app.current_tenant_id', true) = 'bypass'
        OR tenant_id = public.app_current_tenant_id_uuid()
      )
    )
    OR (
      scope_kind = 'external_interface'
      AND current_setting('app.current_tenant_id', true) IS NOT NULL
      AND current_setting('app.current_tenant_id', true) <> ''
      AND current_setting('app.current_tenant_id', true) <> 'bypass'
      AND tenant_id = public.app_current_tenant_id_uuid()
    )
  );

DROP POLICY IF EXISTS pathway_projector_inbox_explicit_context
  ON public.pathway_projector_inbox;
CREATE POLICY pathway_projector_inbox_explicit_context
  ON public.pathway_projector_inbox
  AS RESTRICTIVE
  USING (
    scope_kind = 'pathway_registry'
    OR (
      scope_kind = 'external_interface'
      AND current_setting('app.current_tenant_id', true) IS NOT NULL
      AND current_setting('app.current_tenant_id', true) <> ''
      AND current_setting('app.current_tenant_id', true) <> 'bypass'
      AND tenant_id = public.app_current_tenant_id_uuid()
    )
  )
  WITH CHECK (
    scope_kind = 'pathway_registry'
    OR (
      scope_kind = 'external_interface'
      AND current_setting('app.current_tenant_id', true) IS NOT NULL
      AND current_setting('app.current_tenant_id', true) <> ''
      AND current_setting('app.current_tenant_id', true) <> 'bypass'
      AND tenant_id = public.app_current_tenant_id_uuid()
    )
  );

CREATE OR REPLACE FUNCTION public.assert_external_recovery_inbox_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.scope_kind OPERATOR(pg_catalog.=) 'external_interface'
     AND (
       NEW.scope_kind IS DISTINCT FROM OLD.scope_kind
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.offset_id IS DISTINCT FROM OLD.offset_id
       OR NEW.facility_id IS DISTINCT FROM OLD.facility_id
       OR NEW.interface_family IS DISTINCT FROM OLD.interface_family
       OR NEW.direction IS DISTINCT FROM OLD.direction
       OR NEW.source_partition IS DISTINCT FROM OLD.source_partition
       OR NEW.generation IS DISTINCT FROM OLD.generation
       OR NEW.source_position IS DISTINCT FROM OLD.source_position
       OR NEW.source_token IS DISTINCT FROM OLD.source_token
       OR NEW.predecessor_token IS DISTINCT FROM OLD.predecessor_token
       OR NEW.duplicate_key IS DISTINCT FROM OLD.duplicate_key
       OR NEW.command_fingerprint IS DISTINCT FROM OLD.command_fingerprint
       OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
       OR NEW.received_at IS DISTINCT FROM OLD.received_at
       OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at
       OR NEW.arrival_class IS DISTINCT FROM OLD.arrival_class
       OR NEW.effect_disposition IS DISTINCT FROM OLD.effect_disposition
       OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
       OR NEW.policy_signature IS DISTINCT FROM OLD.policy_signature
       OR NEW.retention_policy IS DISTINCT FROM OLD.retention_policy
       OR NEW.retention_until IS DISTINCT FROM OLD.retention_until
       OR (
         OLD.outcome_code IS NOT NULL
         AND NEW.outcome_code IS DISTINCT FROM OLD.outcome_code
       )
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_external_recovery_inbox_immutable',
      MESSAGE = 'external recovery inbox identity and outcome are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER external_recovery_inbox_immutable
BEFORE UPDATE ON public.pathway_projector_inbox
FOR EACH ROW
EXECUTE FUNCTION public.assert_external_recovery_inbox_immutable();

CREATE OR REPLACE FUNCTION public.pathway_projector_enqueue_new_event()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_RELID OPERATOR(pg_catalog.<>)
       ('public.event_outbox'::pg_catalog.regclass)::pg_catalog.oid
     OR TG_OP OPERATOR(pg_catalog.<>) 'INSERT'::pg_catalog.text THEN
    RAISE EXCEPTION 'pathway_projector_enqueue_new_event is bound to event_outbox INSERT';
  END IF;

  INSERT INTO public.pathway_projector_inbox
    (scope_kind, tenant_id, consumer_key, generation, event_id)
  SELECT 'pathway_registry', NEW.tenant_id, offsets.consumer_key,
         offsets.generation, NEW.id
    FROM public.event_consumer_offsets AS offsets
   WHERE offsets.scope_kind = 'pathway_registry'
     AND offsets.intake_retired_at IS NULL
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Persisted occurrence time and replay-origin fence for event_outbox.
-- ---------------------------------------------------------------------------

ALTER TABLE public.event_outbox
  ADD COLUMN occurred_at TIMESTAMPTZ(6),
  ADD COLUMN occurred_at_source VARCHAR(32),
  ADD COLUMN recovery_inbox_id UUID,
  ADD COLUMN recovery_fingerprint CHAR(64),
  ADD COLUMN recovery_effect_disposition VARCHAR(32);

CREATE FUNCTION pg_temp.c6_1_try_timestamptz(value TEXT)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  RETURN value::timestamptz;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

UPDATE public.event_outbox
   SET occurred_at = CASE
         WHEN event_type = 'admission.diagnostic_resource_linked'
          AND pg_temp.c6_1_try_timestamptz(payload ->> 'occurred_at') IS NOT NULL
           THEN pg_temp.c6_1_try_timestamptz(payload ->> 'occurred_at')
         ELSE created_at
       END,
       occurred_at_source = CASE
         WHEN event_type = 'admission.diagnostic_resource_linked'
          AND pg_temp.c6_1_try_timestamptz(payload ->> 'occurred_at') IS NOT NULL
           THEN 'legacy_payload'
         ELSE 'legacy_recorded_at'
       END;

ALTER TABLE public.event_outbox
  ALTER COLUMN occurred_at SET DEFAULT NOW(),
  ALTER COLUMN occurred_at SET NOT NULL,
  ALTER COLUMN occurred_at_source SET DEFAULT 'explicit',
  ALTER COLUMN occurred_at_source SET NOT NULL,
  ADD CONSTRAINT chk_event_outbox_occurred_at_source
    CHECK (
      occurred_at_source IN ('legacy_payload', 'legacy_recorded_at', 'explicit')
    ),
  ADD CONSTRAINT chk_event_outbox_recovery_fingerprint
    CHECK (
      recovery_fingerprint IS NULL
      OR recovery_fingerprint ~ '^[0-9a-f]{64}$'
    ),
  ADD CONSTRAINT chk_event_outbox_recovery_contract
    CHECK (
      (
        recovery_inbox_id IS NULL
        AND recovery_fingerprint IS NULL
        AND recovery_effect_disposition IS NULL
      )
      OR
      (
        recovery_inbox_id IS NOT NULL
        AND recovery_fingerprint IS NOT NULL
        AND recovery_effect_disposition IN (
          'normal',
          'late_pending_only',
          'signed_exception'
        )
        AND occurred_at_source = 'explicit'
      )
    ),
  ADD CONSTRAINT fk_event_outbox_recovery_contract
    FOREIGN KEY (
      tenant_id,
      recovery_inbox_id,
      occurred_at,
      recovery_fingerprint,
      recovery_effect_disposition
    )
    REFERENCES public.pathway_projector_inbox(
      tenant_id,
      inbox_id,
      occurred_at,
      command_fingerprint,
      effect_disposition
    )
    ON UPDATE NO ACTION ON DELETE NO ACTION;

-- ---------------------------------------------------------------------------
-- I10 tenant/facility/unit/device/recovery provenance.
-- ---------------------------------------------------------------------------

ALTER TABLE public.cold_chain_units
  ADD COLUMN facility_id INTEGER;

UPDATE public.cold_chain_units AS unit
   SET facility_id = location.facility_id
  FROM public.facility_locations AS location
 WHERE location.id = unit.location_id
   AND location.tenant_id = unit.tenant_id;

CREATE UNIQUE INDEX ux_device_registry_tenant_id
  ON public.device_registry (tenant_id, id);

CREATE UNIQUE INDEX ux_cold_chain_units_tenant_id
  ON public.cold_chain_units (tenant_id, id);

ALTER TABLE public.cold_chain_units
  ADD CONSTRAINT fk_cold_chain_units_facility_tenant
    FOREIGN KEY (tenant_id, facility_id)
    REFERENCES public.facilities(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT fk_cold_chain_units_device_tenant
    FOREIGN KEY (tenant_id, device_registry_id)
    REFERENCES public.device_registry(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION;

ALTER TABLE public.cold_chain_readings
  ADD COLUMN facility_id INTEGER,
  ADD COLUMN recovery_inbox_id UUID;

UPDATE public.cold_chain_readings AS reading
   SET facility_id = unit.facility_id
  FROM public.cold_chain_units AS unit
 WHERE unit.id = reading.unit_id
   AND unit.tenant_id = reading.tenant_id;

CREATE UNIQUE INDEX ux_cold_chain_readings_tenant_id
  ON public.cold_chain_readings (tenant_id, id);

ALTER TABLE public.cold_chain_readings
  ADD CONSTRAINT chk_cold_chain_readings_recovery_facility
    CHECK (recovery_inbox_id IS NULL OR facility_id IS NOT NULL),
  ADD CONSTRAINT fk_cold_chain_readings_unit_tenant
    FOREIGN KEY (tenant_id, unit_id)
    REFERENCES public.cold_chain_units(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT fk_cold_chain_readings_device_tenant
    FOREIGN KEY (tenant_id, device_registry_id)
    REFERENCES public.device_registry(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT fk_cold_chain_readings_facility_tenant
    FOREIGN KEY (tenant_id, facility_id)
    REFERENCES public.facilities(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT fk_cold_chain_readings_recovery_inbox
    FOREIGN KEY (tenant_id, recovery_inbox_id, facility_id)
    REFERENCES public.pathway_projector_inbox(tenant_id, inbox_id, facility_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION;

-- ---------------------------------------------------------------------------
-- Late-effect database fence.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.assert_external_recovery_effect_allowed()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF current_setting(
       'app.external_recovery_effect_disposition',
       true
     ) OPERATOR(pg_catalog.=) 'late_pending_only' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_external_recovery_late_effect_guard',
      MESSAGE = FORMAT(
        'late external recovery cannot mutate %I',
        TG_TABLE_NAME
      );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER external_recovery_effect_guard_workflow_sla
BEFORE INSERT OR UPDATE ON public.workflow_sla_instances
FOR EACH ROW EXECUTE FUNCTION public.assert_external_recovery_effect_allowed();

CREATE TRIGGER external_recovery_effect_guard_pathway_transition
BEFORE INSERT OR UPDATE ON public.care_pathway_transition_events
FOR EACH ROW EXECUTE FUNCTION public.assert_external_recovery_effect_allowed();

CREATE TRIGGER external_recovery_effect_guard_notification
BEFORE INSERT OR UPDATE ON public.notification_outbox
FOR EACH ROW EXECUTE FUNCTION public.assert_external_recovery_effect_allowed();

-- ---------------------------------------------------------------------------
-- Runtime privileges. Mutation identity is column-scoped; destructive table
-- operations and migration-owned guard functions remain unavailable.
-- ---------------------------------------------------------------------------

REVOKE ALL PRIVILEGES
  ON FUNCTION public.assert_external_recovery_inbox_immutable()
  FROM PUBLIC;
REVOKE ALL PRIVILEGES
  ON FUNCTION public.assert_external_recovery_effect_allowed()
  FROM PUBLIC;
REVOKE ALL PRIVILEGES
  ON FUNCTION public.pathway_projector_offset_get(TEXT, INTEGER, BOOLEAN)
  FROM PUBLIC;
REVOKE ALL PRIVILEGES
  ON FUNCTION public.pathway_projector_offsets_list(TEXT, BOOLEAN)
  FROM PUBLIC;
REVOKE ALL PRIVILEGES
  ON FUNCTION public.pathway_projector_offset_register(TEXT, INTEGER, BIGINT, BOOLEAN)
  FROM PUBLIC;
REVOKE ALL PRIVILEGES
  ON FUNCTION public.pathway_projector_offset_retire(TEXT, INTEGER)
  FROM PUBLIC;
REVOKE ALL PRIVILEGES
  ON FUNCTION public.pathway_projector_offset_advance(TEXT, INTEGER, BIGINT, BOOLEAN)
  FROM PUBLIC;

DO $runtime_privileges$
DECLARE
  runtime_role TEXT;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['vhhealth_app', 'vhhealth_runtime']
  LOOP
    IF pg_catalog.to_regrole(runtime_role) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE FORMAT(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.event_consumer_offsets FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT SELECT ON public.event_consumer_offsets TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT INSERT (
         scope_kind, tenant_id, facility_scope, facility_id, interface_family,
         direction, source_partition, consumer_key, generation, cursor_kind,
         high_water_position, high_water_token, retained_from_position,
         retained_from_token, resume_cutoff_position, resume_cutoff_token,
         recovery_state, reconciliation_reason, policy_version,
         policy_signature, retention_policy, retention_until,
         historical_cutoff_event_id, backfill_cursor_event_id,
         backfill_completed_at, intake_retired_at
       ) ON public.event_consumer_offsets TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT UPDATE (
         high_water_position, high_water_token, resume_cutoff_position,
         resume_cutoff_token, recovery_state, reconciliation_reason,
         intake_retired_at, updated_at
       ) ON public.event_consumer_offsets TO %I',
      runtime_role
    );

    EXECUTE FORMAT(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.pathway_projector_inbox FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT SELECT ON public.pathway_projector_inbox TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT INSERT (
         scope_kind, tenant_id, consumer_key, generation, event_id, offset_id,
         facility_id, interface_family, direction, source_partition,
         source_position, source_token, predecessor_token, duplicate_key,
         command_fingerprint, occurred_at, received_at, recorded_at,
         arrival_class, effect_disposition, next_attempt_at, policy_version,
         policy_signature, retention_policy, retention_until
       ) ON public.pathway_projector_inbox TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT UPDATE (
         status, attempts, lease_owner, lease_expires_at, next_attempt_at,
         last_error, outcome_at, outcome_code, pending_task_id
       ) ON public.pathway_projector_inbox TO %I',
      runtime_role
    );

    EXECUTE FORMAT(
      'GRANT EXECUTE ON FUNCTION public.pathway_projector_offset_get(TEXT, INTEGER, BOOLEAN) TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT EXECUTE ON FUNCTION public.pathway_projector_offsets_list(TEXT, BOOLEAN) TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT EXECUTE ON FUNCTION public.pathway_projector_offset_register(TEXT, INTEGER, BIGINT, BOOLEAN) TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT EXECUTE ON FUNCTION public.pathway_projector_offset_retire(TEXT, INTEGER) TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT EXECUTE ON FUNCTION public.pathway_projector_offset_advance(TEXT, INTEGER, BIGINT, BOOLEAN) TO %I',
      runtime_role
    );

    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.assert_external_recovery_inbox_immutable() FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.assert_external_recovery_effect_allowed() FROM %I',
      runtime_role
    );
  END LOOP;
END
$runtime_privileges$;

COMMIT;
