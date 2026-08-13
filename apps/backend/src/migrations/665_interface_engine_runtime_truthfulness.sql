-- Interface-engine runtime truthfulness: durable retries, replay accounting,
-- activation guards, and database-enforced delivery evidence.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '180s';

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

ALTER TABLE public.interop_messages
  ADD COLUMN retry_at TIMESTAMPTZ(6),
  ADD COLUMN last_delivery_outcome VARCHAR(40),
  ADD COLUMN last_delivery_response_status INTEGER,
  ADD CONSTRAINT chk_interop_messages_delivery_outcome
    CHECK (
      last_delivery_outcome IS NULL
      OR last_delivery_outcome IN (
        'accepted', 'definitive_retryable', 'definitive_permanent', 'ambiguous'
      )
    ),
  ADD CONSTRAINT chk_interop_messages_retry_shape
    CHECK (
      retry_at IS NULL
      OR (
        status = 'failed'
        AND last_delivery_outcome = 'definitive_retryable'
        AND delivery_claim_token IS NULL
      )
    ),
  ADD CONSTRAINT chk_interop_messages_delivery_response_status
    CHECK (
      last_delivery_response_status IS NULL
      OR last_delivery_response_status BETWEEN 100 AND 599
    );

ALTER TABLE public.interop_messages
  DROP CONSTRAINT chk_interop_messages_recovery_identity,
  ADD CONSTRAINT chk_interop_messages_recovery_identity_v2
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
        AND (
          (send_authority = 'held'
            AND owner_reconciliation_required
            AND owner_release_client_event_id IS NULL)
          OR
          (send_authority = 'owner_authorized'
            AND owner_reconciliation_required IS FALSE
            AND owner_release_client_event_id IS NOT NULL)
        ))
    ),
  DROP CONSTRAINT chk_interop_messages_delivery_claim_shape,
  ADD CONSTRAINT chk_interop_messages_delivery_claim_shape_v2
    CHECK (
      (
        delivery_claim_token IS NULL
        AND delivery_claimed_at IS NULL
        AND delivery_lease_expires_at IS NULL
      )
      OR
      (
        delivery_claim_token IS NOT NULL
        AND delivery_claim_generation > 0
        AND delivery_claimed_at IS NOT NULL
        AND delivery_lease_expires_at > delivery_claimed_at
        AND status = 'delivering'
        AND direction IN ('outbound', 'bidirectional')
        AND owner_reconciliation_required IS FALSE
        AND (
          (
            arrival_class = 'live'
            AND effect_disposition = 'live'
            AND send_authority = 'live_authorized'
            AND owner_release_client_event_id IS NULL
          )
          OR
          (
            recovery_ledger_version = 1
            AND arrival_class = 'recovery_backlog'
            AND effect_disposition = 'late_pending_only'
            AND send_authority = 'owner_authorized'
            AND owner_release_client_event_id IS NOT NULL
          )
        )
      )
    );

DROP INDEX public.idx_interop_messages_due_outbound;
CREATE INDEX idx_interop_messages_due_outbound_v2
  ON public.interop_messages (tenant_id, status, retry_at, updated_at, id)
  WHERE direction IN ('outbound', 'bidirectional')
    AND status IN ('queued', 'failed');

ALTER TABLE public.interop_replay_batches
  ADD COLUMN selected_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN queued_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN skipped_count INTEGER NOT NULL DEFAULT 0;

-- Older batches only observed candidates and never transitioned them. Preserve
-- that fact instead of backfilling a fictional queued count.
UPDATE public.interop_replay_batches
   SET selected_count = message_count,
       queued_count = 0,
       skipped_count = message_count;

ALTER TABLE public.interop_replay_batches
  ADD CONSTRAINT chk_interop_replay_batch_counts
    CHECK (
      selected_count >= 0
      AND queued_count >= 0
      AND skipped_count >= 0
      AND message_count = selected_count
      AND selected_count = queued_count + skipped_count
    );

ALTER TABLE public.interop_backend_delivery_receipts
  DROP CONSTRAINT chk_interop_backend_receipts_status,
  DROP CONSTRAINT chk_interop_backend_receipts_adapter_direction,
  DROP CONSTRAINT chk_interop_backend_receipts_recovery_shape,
  ADD CONSTRAINT chk_interop_backend_receipts_status_v2
    CHECK (receipt_status IN ('accepted', 'previewed', 'pending_review', 'send_held')),
  ADD CONSTRAINT chk_interop_backend_receipts_adapter_direction_v2
    CHECK (
      (protocol = 'hl7v2' AND direction = 'inbound'
        AND adapter_key = 'backend.interop.preview'
        AND receipt_status IN ('accepted', 'previewed', 'pending_review'))
      OR
      (protocol = 'hl7v2' AND direction = 'outbound'
        AND adapter_key = 'external.hl7v2.http'
        AND receipt_status IN ('accepted', 'send_held'))
      OR
      (protocol = 'csv' AND direction = 'inbound'
        AND adapter_key = 'backend.interop.csv'
        AND receipt_status IN ('accepted', 'pending_review'))
      OR
      (protocol = 'csv' AND direction = 'outbound'
        AND adapter_key = 'external.csv.http'
        AND receipt_status IN ('accepted', 'send_held'))
      OR
      (protocol = 'json' AND direction = 'inbound'
        AND adapter_key = 'backend.interop.json'
        AND receipt_status IN ('accepted', 'pending_review'))
      OR
      (protocol = 'json' AND direction = 'outbound'
        AND adapter_key = 'external.json.http'
        AND receipt_status IN ('accepted', 'send_held'))
      OR
      (protocol = 'fhir_json' AND direction = 'inbound'
        AND adapter_key = 'backend.interop.fhir-json'
        AND receipt_status IN ('accepted', 'pending_review'))
      OR
      (protocol = 'fhir_json' AND direction = 'outbound'
        AND adapter_key = 'external.fhir-json.http'
        AND receipt_status IN ('accepted', 'send_held'))
      OR
      (protocol = 'other' AND direction = 'inbound'
        AND adapter_key = 'backend.interop.other-envelope'
        AND receipt_status IN ('accepted', 'pending_review'))
      OR
      (protocol = 'other' AND direction = 'outbound'
        AND adapter_key = 'external.other-envelope.http'
        AND receipt_status IN ('accepted', 'send_held'))
    ),
  ADD CONSTRAINT chk_interop_backend_receipts_recovery_shape_v2
    CHECK (
      (receipt_status IN ('accepted', 'previewed')
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
    );

-- The old preview adapter wrote explicit network_call_performed=false evidence
-- but advanced its live message to delivered. Retain the append-only receipt
-- and correct only the mutable message projection.
UPDATE public.interop_messages AS message
   SET status = 'transformed',
       updated_at = NOW()
  FROM public.interop_channel_versions AS version
 WHERE version.tenant_id = message.tenant_id
   AND version.id = message.channel_version_id
   AND message.status = 'delivered'
   AND message.direction IN ('inbound', 'bidirectional')
   AND COALESCE(
     version.transform_dsl -> 'emit' ->> 'adapter',
     version.routing_policy ->> 'adapter'
   ) = 'backend.interop.preview'
   AND EXISTS (
     SELECT 1
       FROM public.interop_backend_delivery_receipts AS receipt
      WHERE receipt.tenant_id = message.tenant_id
        AND receipt.message_id = message.id
        AND receipt.direction = 'inbound'
        AND receipt.adapter_key = 'backend.interop.preview'
        AND receipt.evidence ->> 'network_call_performed' = 'false'
   );

-- Migration 624 added the sole owner-authorized I05 release command, but the
-- older receipt trigger still rejected every accepted late-message receipt.
-- Keep late work held unless that exact immutable release proof is present.
CREATE OR REPLACE FUNCTION public.validate_interop_backend_receipt()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  source_message RECORD;
  release_proof_matches BOOLEAN := FALSE;
BEGIN
  SELECT message.tenant_id, message.channel_id, message.channel_version_id,
         message.protocol, message.direction, message.payload_hash,
         message.recovery_inbox_id, message.effect_disposition,
         message.send_authority, message.owner_reconciliation_required,
         message.owner_release_client_event_id
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
    release_proof_matches := source_message.send_authority = 'owner_authorized'
      AND source_message.owner_reconciliation_required IS FALSE
      AND source_message.owner_release_client_event_id IS NOT NULL
      AND public.cc_held_release_proof_matches(
        NEW.tenant_id,
        source_message.owner_release_client_event_id,
        'I05',
        NEW.message_id,
        FALSE
      );
    IF NOT release_proof_matches THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_interop_backend_receipt_late_suppression',
        MESSAGE = 'I05 late acceptance requires the applied owner-release proof';
    END IF;
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

CREATE OR REPLACE FUNCTION public.assert_interop_runtime_activation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  channel_record RECORD;
  source_record RECORD;
  source_range TEXT;
  endpoint_url TEXT;
BEGIN
  SELECT channel.id, channel.tenant_id, channel.direction,
         channel.connector_kind, channel.protocol, channel.source_system_id
    INTO channel_record
    FROM public.interop_channels AS channel
   WHERE channel.tenant_id = NEW.tenant_id
     AND channel.id = NEW.channel_id;

  IF channel_record IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_interop_runtime_activation',
      MESSAGE = 'interface-engine activation requires a same-tenant channel';
  END IF;

  IF NEW.status <> 'active' THEN
    RETURN NEW;
  END IF;

  IF channel_record.connector_kind NOT IN ('http_inbound', 'http_outbound')
     OR (channel_record.connector_kind = 'http_inbound'
       AND (channel_record.protocol <> 'hl7v2'
         OR channel_record.direction NOT IN ('inbound', 'bidirectional')))
     OR (channel_record.connector_kind = 'http_outbound'
       AND channel_record.direction NOT IN ('outbound', 'bidirectional')) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_interop_runtime_activation',
      MESSAGE = 'interface-engine connector runtime is not implemented';
  END IF;

  IF channel_record.connector_kind = 'http_outbound' THEN
    endpoint_url := NULLIF(BTRIM(COALESCE(
      NEW.connector_config ->> 'endpointUrl',
      NEW.connector_config ->> 'endpoint_url'
    )), '');
    IF endpoint_url IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_interop_runtime_outbound_endpoint',
        MESSAGE = 'active http_outbound versions require an endpoint URL';
    END IF;
  ELSE
    SELECT system.status, system.allowed_source_ips
      INTO source_record
      FROM public.interop_systems AS system
     WHERE system.tenant_id = NEW.tenant_id
       AND system.id = channel_record.source_system_id;
    IF source_record IS NULL
       OR source_record.status <> 'active'
       OR cardinality(source_record.allowed_source_ips) = 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_interop_runtime_inbound_source_policy',
        MESSAGE = 'active http_inbound versions require an active source with a non-empty IP allowlist';
    END IF;
    FOREACH source_range IN ARRAY source_record.allowed_source_ips LOOP
      BEGIN
        PERFORM source_range::cidr;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          CONSTRAINT = 'chk_interop_runtime_inbound_source_policy',
          MESSAGE = 'active http_inbound source allowlist contains an invalid IP or CIDR';
      END;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER assert_interop_runtime_activation
BEFORE INSERT OR UPDATE OF status, connector_config, channel_id
ON public.interop_channel_versions
FOR EACH ROW EXECUTE FUNCTION public.assert_interop_runtime_activation();

CREATE OR REPLACE FUNCTION public.assert_interop_channel_active_runtime()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  active_version RECORD;
  source_record RECORD;
  source_range TEXT;
  endpoint_url TEXT;
BEGIN
  IF NEW.status <> 'active' THEN
    RETURN NEW;
  END IF;
  IF NEW.connector_kind NOT IN ('http_inbound', 'http_outbound')
     OR (NEW.connector_kind = 'http_inbound'
       AND (NEW.protocol <> 'hl7v2'
         OR NEW.direction NOT IN ('inbound', 'bidirectional')))
     OR (NEW.connector_kind = 'http_outbound'
       AND NEW.direction NOT IN ('outbound', 'bidirectional'))
     OR NEW.active_version_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_interop_channel_active_runtime',
      MESSAGE = 'active interface-engine channel lacks an implemented active version';
  END IF;
  SELECT version.id, version.status, version.connector_config
    INTO active_version
    FROM public.interop_channel_versions AS version
   WHERE version.tenant_id = NEW.tenant_id
     AND version.channel_id = NEW.id
     AND version.id = NEW.active_version_id;
  IF active_version IS NULL OR active_version.status <> 'active' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_interop_channel_active_runtime',
      MESSAGE = 'active interface-engine channel must reference its active version';
  END IF;
  IF NEW.connector_kind = 'http_outbound' THEN
    endpoint_url := NULLIF(BTRIM(COALESCE(
      active_version.connector_config ->> 'endpointUrl',
      active_version.connector_config ->> 'endpoint_url'
    )), '');
    IF endpoint_url IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_interop_channel_active_runtime',
        MESSAGE = 'active http_outbound channels require an endpoint URL';
    END IF;
  ELSE
    SELECT system.status, system.allowed_source_ips
      INTO source_record
      FROM public.interop_systems AS system
     WHERE system.tenant_id = NEW.tenant_id
       AND system.id = NEW.source_system_id;
    IF source_record IS NULL
       OR source_record.status <> 'active'
       OR cardinality(source_record.allowed_source_ips) = 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_interop_channel_active_runtime',
        MESSAGE = 'active http_inbound channels require an active source with a non-empty IP allowlist';
    END IF;
    FOREACH source_range IN ARRAY source_record.allowed_source_ips LOOP
      BEGIN
        PERFORM source_range::cidr;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          CONSTRAINT = 'chk_interop_channel_active_runtime',
          MESSAGE = 'active http_inbound source allowlist contains an invalid IP or CIDR';
      END;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER assert_interop_channel_active_runtime
BEFORE INSERT OR UPDATE OF status, active_version_id, direction, connector_kind,
  protocol, source_system_id
ON public.interop_channels
FOR EACH ROW EXECUTE FUNCTION public.assert_interop_channel_active_runtime();

CREATE OR REPLACE FUNCTION public.assert_interop_message_delivery_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  configured_adapter TEXT;
  accepted_receipt_exists BOOLEAN;
BEGIN
  IF NEW.status <> 'delivered' OR OLD.status = 'delivered' THEN
    RETURN NEW;
  END IF;
  SELECT COALESCE(version.transform_dsl -> 'emit' ->> 'adapter',
                  version.routing_policy ->> 'adapter')
    INTO configured_adapter
    FROM public.interop_channel_versions AS version
   WHERE version.tenant_id = NEW.tenant_id
     AND version.id = NEW.channel_version_id;
  IF configured_adapter = 'backend.interop.preview' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_interop_preview_not_delivered',
      MESSAGE = 'preview-only interface messages cannot be marked delivered';
  END IF;
  IF NEW.direction IN ('outbound', 'bidirectional') THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.interop_backend_delivery_receipts AS receipt
       WHERE receipt.tenant_id = NEW.tenant_id
         AND receipt.message_id = NEW.id
         AND receipt.direction = 'outbound'
         AND receipt.receipt_status = 'accepted'
    ) INTO accepted_receipt_exists;
    IF NOT accepted_receipt_exists THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_interop_delivery_acceptance_evidence',
        MESSAGE = 'outbound interface delivery requires an accepted same-message receipt';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER assert_interop_message_delivery_evidence
BEFORE UPDATE OF status ON public.interop_messages
FOR EACH ROW EXECUTE FUNCTION public.assert_interop_message_delivery_evidence();

REVOKE ALL PRIVILEGES ON FUNCTION public.assert_interop_runtime_activation() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.assert_interop_channel_active_runtime() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.assert_interop_message_delivery_evidence() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.validate_interop_backend_receipt() FROM PUBLIC;

COMMIT;
