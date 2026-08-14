-- Interface-engine inbound activation requires a CANONICAL backend adapter.
--
-- Audit 2026-08-13. Migration 665 gave the interface engine two activation
-- triggers, and both tested exactly one thing about the configured backend
-- adapter: that it was not the literal 'backend.interop.preview'
-- (665:364-369 for a version, 665:473-478 for a channel). Anything else was
-- approved. So an operator could activate an `http_inbound` channel whose
-- version named:
--
--   * an adapter key that no adapter implements — `deliverBackendTx` then
--     refuses every message with INTEROP_BACKEND_ADAPTER_UNREGISTERED; or
--   * no adapter at all — ingestion stops at `transformed`, no receipt is ever
--     written, and the ingress route answers 409 INTEROP_HL7_NOT_DELIVERED for
--     the life of the channel.
--
-- In both cases the row claims `status = 'active'` for an interface that
-- cannot produce a clinical effect. `http_inbound` may only carry `hl7v2`
-- (665:325 and runtimePolicy.ACTIVE_CONNECTOR_PROTOCOLS), and the only
-- registered hl7v2 backend adapter is the preview adapter these triggers
-- already forbid — it writes `receipt_status = 'previewed'` and performs no
-- clinical write. There is therefore no configuration of an inbound channel
-- that can deliver, and activation must fail closed instead of approving one.
--
-- This migration adds no table and no column. It introduces the canonical
-- adapter registry as a function and re-plants it inside both activation
-- trigger functions, which are otherwise byte-equivalent to 665's. The
-- triggers themselves are unchanged and keep pointing at these names.
--
-- Effect today: `http_inbound` activation is unavailable, and says so. It
-- re-opens on its own the day a canonical hl7v2 backend adapter is registered
-- in BOTH places — `interop_canonical_backend_adapters()` below and
-- `canonicalBackendAdapterKeys` on the adapter in
-- src/services/interfaceEngine/protocolAdapters/. The two are pinned to each
-- other by src/tests/unit/interfaceEngineCanonicalBackendAdapters.test.js, so
-- adding one without the other fails CI.
--
-- Already-active rows are deliberately NOT mutated: BEFORE INSERT/UPDATE
-- triggers gate future transitions, and retiring live operator state is an
-- owner decision, not a migration's. Such a row remains incapable of a
-- delivery anyway — migration 665's `assert_interop_message_delivery_evidence`
-- still refuses `status = 'delivered'` without an accepted same-message
-- receipt.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '180s';

-- The canonical backend adapters, by protocol. A protocol with an empty array
-- has no adapter that can carry a clinical effect, so no inbound version of it
-- may be activated. Mirrors `canonicalBackendAdapterKeys` on each adapter in
-- src/services/interfaceEngine/protocolAdapters/.
CREATE OR REPLACE FUNCTION public.interop_canonical_backend_adapters(p_protocol TEXT)
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE p_protocol
    -- hl7v2's only registered backend adapter is 'backend.interop.preview',
    -- which records a preview receipt and performs NO clinical write.
    WHEN 'hl7v2'     THEN ARRAY[]::TEXT[]
    WHEN 'csv'       THEN ARRAY['backend.interop.csv']
    WHEN 'json'      THEN ARRAY['backend.interop.json']
    WHEN 'fhir_json' THEN ARRAY['backend.interop.fhir-json']
    WHEN 'other'     THEN ARRAY['backend.interop.other-envelope']
    ELSE ARRAY[]::TEXT[]
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
  configured_adapter TEXT;
  canonical_adapters TEXT[];
BEGIN
  SELECT channel.id, channel.tenant_id, channel.direction,
         channel.connector_kind, channel.protocol, channel.source_system_id,
         channel.auth_kind, channel.auth_sender_identifier
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
    IF channel_record.auth_kind <> 'none' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_interop_runtime_outbound_auth',
        MESSAGE = 'http_outbound runtime supports auth_kind none only';
    END IF;
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
    IF channel_record.auth_kind <> 'tenant_interop_secret'
       OR NULLIF(BTRIM(channel_record.auth_sender_identifier), '') IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_interop_runtime_inbound_auth',
        MESSAGE = 'http_inbound runtime requires tenant_interop_secret authentication and a sender identifier';
    END IF;
    configured_adapter := COALESCE(
      NULLIF(NEW.transform_dsl -> 'emit' ->> 'adapter', ''),
      NEW.routing_policy ->> 'adapter'
    );
    IF configured_adapter = 'backend.interop.preview' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_interop_runtime_preview_activation',
        MESSAGE = 'preview-only inbound versions cannot be activated';
    END IF;
    canonical_adapters := public.interop_canonical_backend_adapters(channel_record.protocol);
    IF cardinality(canonical_adapters) = 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_interop_runtime_canonical_adapter',
        MESSAGE = 'inbound activation is unavailable: no canonical backend adapter is registered for this protocol';
    END IF;
    IF NULLIF(BTRIM(COALESCE(configured_adapter, '')), '') IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_interop_runtime_canonical_adapter',
        MESSAGE = 'active http_inbound versions require a canonical backend adapter';
    END IF;
    IF NOT (BTRIM(configured_adapter) = ANY (canonical_adapters)) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_interop_runtime_canonical_adapter',
        MESSAGE = 'active http_inbound versions require a registered canonical backend adapter';
    END IF;
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
  configured_adapter TEXT;
  canonical_adapters TEXT[];
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
  SELECT version.id, version.status, version.connector_config,
         version.transform_dsl, version.routing_policy
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
    IF NEW.auth_kind <> 'none' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_interop_channel_active_runtime',
        MESSAGE = 'http_outbound runtime supports auth_kind none only';
    END IF;
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
    IF NEW.auth_kind <> 'tenant_interop_secret'
       OR NULLIF(BTRIM(NEW.auth_sender_identifier), '') IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_interop_channel_active_runtime',
        MESSAGE = 'http_inbound runtime requires tenant_interop_secret authentication and a sender identifier';
    END IF;
    configured_adapter := COALESCE(
      NULLIF(active_version.transform_dsl -> 'emit' ->> 'adapter', ''),
      active_version.routing_policy ->> 'adapter'
    );
    IF configured_adapter = 'backend.interop.preview' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_interop_channel_active_runtime',
        MESSAGE = 'preview-only inbound versions cannot be activated';
    END IF;
    canonical_adapters := public.interop_canonical_backend_adapters(NEW.protocol);
    IF cardinality(canonical_adapters) = 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_interop_channel_active_runtime',
        MESSAGE = 'inbound activation is unavailable: no canonical backend adapter is registered for this protocol';
    END IF;
    IF NULLIF(BTRIM(COALESCE(configured_adapter, '')), '') IS NULL
       OR NOT (BTRIM(configured_adapter) = ANY (canonical_adapters)) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_interop_channel_active_runtime',
        MESSAGE = 'active http_inbound channels require a registered canonical backend adapter';
    END IF;
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

COMMIT;
