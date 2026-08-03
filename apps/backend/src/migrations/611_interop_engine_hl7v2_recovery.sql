-- C6.1-E / I05 HL7v2: adapt the generic interface-engine ledger in place.
-- This migration is inert: it registers no worker and releases no held message.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '180s';

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Existing integer relationships become same-tenant relationships. The
-- redundant unique keys are intentional PostgreSQL FK targets.
ALTER TABLE public.interop_systems
  ADD CONSTRAINT ux_interop_systems_tenant_id UNIQUE (tenant_id, id);
ALTER TABLE public.interop_channels
  ADD CONSTRAINT ux_interop_channels_tenant_id UNIQUE (tenant_id, id);
ALTER TABLE public.interop_channel_versions
  ADD CONSTRAINT ux_interop_channel_versions_tenant_id UNIQUE (tenant_id, id);
ALTER TABLE public.interop_messages
  ADD CONSTRAINT ux_interop_messages_tenant_id UNIQUE (tenant_id, id);

ALTER TABLE public.interop_channels
  DROP CONSTRAINT interop_channels_source_system_id_fkey,
  DROP CONSTRAINT interop_channels_target_system_id_fkey,
  ADD CONSTRAINT fk_interop_channels_source_system_tenant
    FOREIGN KEY (tenant_id, source_system_id)
    REFERENCES public.interop_systems (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE SET NULL (source_system_id) NOT VALID,
  ADD CONSTRAINT fk_interop_channels_target_system_tenant
    FOREIGN KEY (tenant_id, target_system_id)
    REFERENCES public.interop_systems (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE SET NULL (target_system_id) NOT VALID;

ALTER TABLE public.interop_channel_versions
  DROP CONSTRAINT interop_channel_versions_channel_id_fkey,
  ADD CONSTRAINT fk_interop_channel_versions_channel_tenant
    FOREIGN KEY (tenant_id, channel_id)
    REFERENCES public.interop_channels (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE CASCADE NOT VALID;

ALTER TABLE public.interop_channels
  DROP CONSTRAINT fk_interop_channels_active_version,
  ADD CONSTRAINT fk_interop_channels_active_version_tenant
    FOREIGN KEY (tenant_id, active_version_id)
    REFERENCES public.interop_channel_versions (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE SET NULL (active_version_id) NOT VALID;

ALTER TABLE public.interop_messages
  DROP CONSTRAINT interop_messages_channel_id_fkey,
  DROP CONSTRAINT interop_messages_channel_version_id_fkey,
  ADD CONSTRAINT fk_interop_messages_channel_tenant
    FOREIGN KEY (tenant_id, channel_id)
    REFERENCES public.interop_channels (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE CASCADE NOT VALID,
  ADD CONSTRAINT fk_interop_messages_channel_version_tenant
    FOREIGN KEY (tenant_id, channel_version_id)
    REFERENCES public.interop_channel_versions (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT NOT VALID;

ALTER TABLE public.interop_message_attempts
  DROP CONSTRAINT interop_message_attempts_message_id_fkey,
  DROP CONSTRAINT interop_message_attempts_channel_version_id_fkey,
  ADD CONSTRAINT fk_interop_message_attempts_message_tenant
    FOREIGN KEY (tenant_id, message_id)
    REFERENCES public.interop_messages (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE CASCADE NOT VALID,
  ADD CONSTRAINT fk_interop_message_attempts_version_tenant
    FOREIGN KEY (tenant_id, channel_version_id)
    REFERENCES public.interop_channel_versions (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT NOT VALID;

ALTER TABLE public.interop_transform_tests
  DROP CONSTRAINT interop_transform_tests_channel_version_id_fkey,
  ADD CONSTRAINT fk_interop_transform_tests_version_tenant
    FOREIGN KEY (tenant_id, channel_version_id)
    REFERENCES public.interop_channel_versions (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE CASCADE NOT VALID;

ALTER TABLE public.interop_replay_batches
  DROP CONSTRAINT interop_replay_batches_channel_id_fkey,
  ADD CONSTRAINT fk_interop_replay_batches_channel_tenant
    FOREIGN KEY (tenant_id, channel_id)
    REFERENCES public.interop_channels (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE CASCADE NOT VALID;

ALTER TABLE public.interop_worker_leases
  DROP CONSTRAINT interop_worker_leases_channel_id_fkey,
  ADD CONSTRAINT fk_interop_worker_leases_channel_tenant
    FOREIGN KEY (tenant_id, channel_id)
    REFERENCES public.interop_channels (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE CASCADE NOT VALID;

-- Historical rows are retained as evidence but are not silently enrolled in
-- the recovery stream. Held authority makes them ineligible for dispatch
-- without rewriting their pre-migration delivery status.
ALTER TABLE public.interop_messages
  ADD COLUMN recovery_ledger_version SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN source_position BIGINT,
  ADD COLUMN source_token VARCHAR(255),
  ADD COLUMN predecessor_token VARCHAR(255),
  ADD COLUMN recovery_inbox_id UUID,
  ADD COLUMN recovery_interface_family VARCHAR(8),
  ADD COLUMN arrival_class VARCHAR(40) NOT NULL DEFAULT 'legacy_unverified',
  ADD COLUMN effect_disposition VARCHAR(40) NOT NULL DEFAULT 'held',
  ADD COLUMN send_authority VARCHAR(40) NOT NULL DEFAULT 'held',
  ADD COLUMN owner_reconciliation_required BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN delivery_claim_token UUID,
  ADD COLUMN delivery_claim_generation INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN delivery_claimed_at TIMESTAMPTZ(6),
  ADD COLUMN delivery_lease_expires_at TIMESTAMPTZ(6);

ALTER TABLE public.interop_messages
  ADD CONSTRAINT fk_interop_messages_recovery_inbox_tenant
    FOREIGN KEY (tenant_id, recovery_inbox_id, recovery_interface_family)
    REFERENCES public.pathway_projector_inbox (tenant_id, inbox_id, interface_family)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  ADD CONSTRAINT chk_interop_messages_recovery_identity
    CHECK (
      (recovery_ledger_version = 0
        AND source_position IS NULL
        AND source_token IS NULL
        AND predecessor_token IS NULL
        AND recovery_inbox_id IS NULL
        AND recovery_interface_family IS NULL)
      OR
      (recovery_ledger_version = 1
        AND source_position IS NOT NULL
        AND source_position >= 0
        AND source_token IS NOT NULL
        AND length(btrim(source_token)) > 0
        AND predecessor_token IS NOT NULL
        AND length(btrim(predecessor_token)) > 0
        AND recovery_inbox_id IS NOT NULL
        AND recovery_interface_family = 'I05'
        AND arrival_class = 'recovery_backlog'
        AND effect_disposition = 'late_pending_only'
        AND send_authority = 'held'
        AND owner_reconciliation_required)
    ),
  ADD CONSTRAINT chk_interop_messages_recovery_enums
    CHECK (
      arrival_class IN ('legacy_unverified', 'live', 'recovery_backlog')
      AND effect_disposition IN ('live', 'held', 'late_pending_only')
      AND send_authority IN ('held', 'live_authorized', 'owner_authorized')
    ),
  ADD CONSTRAINT chk_interop_messages_payload_sha256
    CHECK (recovery_ledger_version = 0 OR payload_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT chk_interop_messages_delivery_claim_generation
    CHECK (delivery_claim_generation >= 0),
  ADD CONSTRAINT chk_interop_messages_delivery_claim_shape
    CHECK (
      (delivery_claim_token IS NULL
        AND delivery_claimed_at IS NULL
        AND delivery_lease_expires_at IS NULL)
      OR
      (delivery_claim_token IS NOT NULL
        AND delivery_claim_generation > 0
        AND delivery_claimed_at IS NOT NULL
        AND delivery_lease_expires_at > delivery_claimed_at
        AND status = 'delivering'
        AND direction IN ('outbound', 'bidirectional')
        AND send_authority = 'live_authorized'
        AND NOT owner_reconciliation_required)
    );

CREATE UNIQUE INDEX ux_interop_messages_recovery_position
  ON public.interop_messages
    (tenant_id, channel_id, direction, protocol, source_position)
  WHERE recovery_ledger_version = 1;

CREATE INDEX idx_interop_messages_delivery_lease
  ON public.interop_messages (tenant_id, delivery_lease_expires_at, id)
  WHERE status = 'delivering' AND delivery_claim_token IS NOT NULL;

CREATE TABLE public.interop_backend_delivery_receipts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id UUID NOT NULL,
  message_id INTEGER NOT NULL,
  channel_id INTEGER NOT NULL,
  channel_version_id INTEGER NOT NULL,
  protocol VARCHAR(30) NOT NULL,
  direction VARCHAR(20) NOT NULL,
  adapter_key VARCHAR(120) NOT NULL,
  adapter_version VARCHAR(80) NOT NULL,
  payload_sha256 CHAR(64) NOT NULL,
  payload_bytes INTEGER NOT NULL,
  transformed_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  receipt_status VARCHAR(32) NOT NULL,
  recovery_inbox_id UUID,
  recovery_interface_family VARCHAR(8),
  owner_actor_uid UUID,
  owner_reason VARCHAR(500),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT ux_interop_backend_receipts_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT ux_interop_backend_receipts_message_adapter
    UNIQUE (tenant_id, message_id, adapter_key, receipt_status),
  CONSTRAINT fk_interop_backend_receipts_tenant
    FOREIGN KEY (tenant_id) REFERENCES public.tenants (id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_interop_backend_receipts_message_tenant
    FOREIGN KEY (tenant_id, message_id)
    REFERENCES public.interop_messages (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_interop_backend_receipts_channel_tenant
    FOREIGN KEY (tenant_id, channel_id)
    REFERENCES public.interop_channels (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_interop_backend_receipts_version_tenant
    FOREIGN KEY (tenant_id, channel_version_id)
    REFERENCES public.interop_channel_versions (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_interop_backend_receipts_recovery_inbox_tenant
    FOREIGN KEY (tenant_id, recovery_inbox_id, recovery_interface_family)
    REFERENCES public.pathway_projector_inbox (tenant_id, inbox_id, interface_family)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT chk_interop_backend_receipts_protocol
    CHECK (protocol = 'hl7v2'),
  CONSTRAINT chk_interop_backend_receipts_direction
    CHECK (direction IN ('inbound', 'outbound')),
  CONSTRAINT chk_interop_backend_receipts_status
    CHECK (receipt_status IN ('accepted', 'pending_review', 'send_held')),
  CONSTRAINT chk_interop_backend_receipts_adapter_direction
    CHECK (
      (direction = 'inbound'
        AND adapter_key = 'backend.interop.preview'
        AND receipt_status IN ('accepted', 'pending_review'))
      OR
      (direction = 'outbound'
        AND adapter_key = 'external.hl7v2.http'
        AND receipt_status IN ('accepted', 'send_held'))
    ),
  CONSTRAINT chk_interop_backend_receipts_sha256
    CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_interop_backend_receipts_bytes
    CHECK (payload_bytes >= 0),
  CONSTRAINT chk_interop_backend_receipts_recovery_shape
    CHECK (
      (receipt_status = 'accepted'
        AND recovery_inbox_id IS NULL
        AND recovery_interface_family IS NULL
        AND owner_actor_uid IS NULL
        AND owner_reason IS NULL)
      OR
      (receipt_status IN ('pending_review', 'send_held')
        AND recovery_inbox_id IS NOT NULL
        AND recovery_interface_family = 'I05'
        AND owner_actor_uid IS NOT NULL
        AND owner_reason IS NOT NULL
        AND length(btrim(owner_reason)) > 0)
    )
);

CREATE INDEX idx_interop_backend_receipts_message
  ON public.interop_backend_delivery_receipts
    (tenant_id, message_id, created_at DESC);
CREATE INDEX idx_interop_backend_receipts_recovery
  ON public.interop_backend_delivery_receipts
    (tenant_id, recovery_inbox_id)
  WHERE recovery_inbox_id IS NOT NULL;

CREATE POLICY tenant_isolation
  ON public.interop_backend_delivery_receipts
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = public.app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = public.app_current_tenant_id_uuid()
  );

CREATE OR REPLACE FUNCTION public.interop_delivery_evidence_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = 'chk_interop_delivery_evidence_append_only',
    MESSAGE = 'I05 delivery attempts and receipts are append-only';
END
$$;

CREATE TRIGGER interop_backend_receipt_append_only
BEFORE UPDATE OR DELETE ON public.interop_backend_delivery_receipts
FOR EACH ROW EXECUTE FUNCTION public.interop_delivery_evidence_append_only();

CREATE TRIGGER interop_message_attempt_append_only
BEFORE UPDATE OR DELETE ON public.interop_message_attempts
FOR EACH ROW EXECUTE FUNCTION public.interop_delivery_evidence_append_only();

CREATE OR REPLACE FUNCTION public.validate_interop_backend_receipt()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  source_message RECORD;
BEGIN
  SELECT message.tenant_id, message.channel_id, message.channel_version_id,
         message.protocol, message.direction, message.payload_hash,
         message.recovery_inbox_id, message.effect_disposition
    INTO source_message
    FROM public.interop_messages AS message
   WHERE message.tenant_id = NEW.tenant_id
     AND message.id = NEW.message_id;

  IF source_message IS NULL
     OR source_message.channel_id <> NEW.channel_id
     OR source_message.channel_version_id <> NEW.channel_version_id
     OR source_message.protocol <> NEW.protocol
     OR (CASE WHEN source_message.direction = 'bidirectional'
              THEN NEW.direction IN ('inbound', 'outbound')
              ELSE source_message.direction = NEW.direction END) IS NOT TRUE
     OR source_message.payload_hash <> NEW.payload_sha256::text THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_interop_backend_receipt_message_parity',
      MESSAGE = 'I05 receipt does not match its same-tenant message evidence';
  END IF;

  IF NEW.receipt_status = 'accepted'
     AND source_message.effect_disposition = 'late_pending_only' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_interop_backend_receipt_late_suppression',
      MESSAGE = 'I05 late messages cannot create accepted backend receipts';
  END IF;

  IF NEW.recovery_inbox_id IS NOT NULL
     AND (source_message.recovery_inbox_id IS DISTINCT FROM NEW.recovery_inbox_id
       OR source_message.effect_disposition <> 'late_pending_only') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_interop_backend_receipt_recovery_provenance',
      MESSAGE = 'I05 recovery receipt lacks matching late message provenance';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER validate_interop_backend_receipt
BEFORE INSERT ON public.interop_backend_delivery_receipts
FOR EACH ROW EXECUTE FUNCTION public.validate_interop_backend_receipt();

CREATE OR REPLACE FUNCTION public.validate_interop_message_recovery_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.recovery_ledger_version = 1 AND (
       NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.channel_id IS DISTINCT FROM OLD.channel_id
       OR NEW.channel_version_id IS DISTINCT FROM OLD.channel_version_id
       OR NEW.direction IS DISTINCT FROM OLD.direction
       OR NEW.protocol IS DISTINCT FROM OLD.protocol
       OR NEW.message_type IS DISTINCT FROM OLD.message_type
       OR NEW.external_control_id IS DISTINCT FROM OLD.external_control_id
       OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
       OR NEW.raw_payload_ciphertext IS DISTINCT FROM OLD.raw_payload_ciphertext
       OR NEW.recovery_ledger_version IS DISTINCT FROM OLD.recovery_ledger_version
       OR NEW.source_position IS DISTINCT FROM OLD.source_position
       OR NEW.source_token IS DISTINCT FROM OLD.source_token
       OR NEW.predecessor_token IS DISTINCT FROM OLD.predecessor_token
       OR NEW.recovery_inbox_id IS DISTINCT FROM OLD.recovery_inbox_id
       OR NEW.recovery_interface_family IS DISTINCT FROM OLD.recovery_interface_family
       OR NEW.arrival_class IS DISTINCT FROM OLD.arrival_class
       OR NEW.effect_disposition IS DISTINCT FROM OLD.effect_disposition
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_interop_message_recovery_identity_immutable',
      MESSAGE = 'I05 recovery identity and late disposition are immutable';
  END IF;

  IF NEW.effect_disposition = 'late_pending_only'
     AND NEW.status IN ('queued', 'delivering', 'delivered', 'replayed') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_interop_message_late_effect_suppression',
      MESSAGE = 'I05 late messages cannot be queued, delivered, or replayed automatically';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER validate_interop_message_recovery_transition
BEFORE INSERT OR UPDATE ON public.interop_messages
FOR EACH ROW EXECUTE FUNCTION public.validate_interop_message_recovery_transition();

CREATE OR REPLACE FUNCTION public.validate_interop_message_recovery_provenance()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  inbox RECORD;
BEGIN
  IF NEW.recovery_inbox_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT item.interface_family, item.direction, item.arrival_class,
         item.effect_disposition, item.status, item.pending_task_id
    INTO inbox
    FROM public.pathway_projector_inbox AS item
   WHERE item.tenant_id = NEW.tenant_id
     AND item.inbox_id = NEW.recovery_inbox_id;
  IF inbox IS NULL
     OR inbox.interface_family <> 'I05'
     OR (NEW.direction <> 'bidirectional' AND inbox.direction <> NEW.direction)
     OR inbox.arrival_class <> 'recovery_backlog'
     OR inbox.effect_disposition <> 'late_pending_only'
     OR inbox.status <> 'handled'
     OR inbox.pending_task_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_interop_message_recovery_provenance',
      MESSAGE = 'I05 message lacks same-tenant handled recovery provenance';
  END IF;
  RETURN NEW;
END
$$;

CREATE CONSTRAINT TRIGGER interop_message_recovery_provenance
AFTER INSERT OR UPDATE OF recovery_inbox_id
ON public.interop_messages
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.recovery_inbox_id IS NOT NULL)
EXECUTE FUNCTION public.validate_interop_message_recovery_provenance();

DO $rls$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'interop_systems',
    'interop_channels',
    'interop_channel_versions',
    'interop_messages',
    'interop_message_attempts',
    'interop_transform_tests',
    'interop_replay_batches',
    'interop_worker_leases',
    'interop_backend_delivery_receipts'
  ]
  LOOP
    EXECUTE FORMAT('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE FORMAT('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE FORMAT('DROP POLICY IF EXISTS interop_explicit_context ON public.%I', table_name);
    EXECUTE FORMAT($policy$
      CREATE POLICY interop_explicit_context
        ON public.%I
        AS RESTRICTIVE
        USING (
          current_setting('app.current_tenant_id', true) IS NOT NULL
          AND current_setting('app.current_tenant_id', true) <> ''
          AND current_setting('app.current_tenant_id', true) <> 'bypass'
          AND tenant_id = public.app_current_tenant_id_uuid()
        )
        WITH CHECK (
          current_setting('app.current_tenant_id', true) IS NOT NULL
          AND current_setting('app.current_tenant_id', true) <> ''
          AND current_setting('app.current_tenant_id', true) <> 'bypass'
          AND tenant_id = public.app_current_tenant_id_uuid()
        )
    $policy$, table_name);
  END LOOP;
END
$rls$;

REVOKE ALL PRIVILEGES ON FUNCTION public.interop_delivery_evidence_append_only() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.validate_interop_backend_receipt() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.validate_interop_message_recovery_transition() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.validate_interop_message_recovery_provenance() FROM PUBLIC;

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
      'GRANT SELECT, INSERT ON public.interop_backend_delivery_receipts TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE UPDATE, DELETE, TRUNCATE ON public.interop_backend_delivery_receipts FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE UPDATE, DELETE, TRUNCATE ON public.interop_message_attempts FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT USAGE, SELECT ON SEQUENCE public.interop_backend_delivery_receipts_id_seq TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.interop_delivery_evidence_append_only() FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.validate_interop_backend_receipt() FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.validate_interop_message_recovery_transition() FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.validate_interop_message_recovery_provenance() FROM %I',
      runtime_role
    );
  END LOOP;
END
$runtime_privileges$;

COMMIT;
